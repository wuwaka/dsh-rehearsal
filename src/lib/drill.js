// Session drill mechanics: lazy-migration trigger, read-side integrity over
// the post-migration generation, and the keyless write round.
//
// Verdict discipline (reviews, 2026-10-02): the keyless migration exits 1
// with MISSING_CREDENTIAL while succeeding — verdicts are driven by
// artifacts (files appearing, decodability, seq continuity, new durable
// rows), never by process exit codes.

import fs from 'node:fs';
import path from 'node:path';
import { decodeLines, decodeAll, magicOffsets } from './zfstd.js';
import { run, shadowEnv } from './util.js';

const WRITE_FAIL_SIGNATURES = [
  {
    id: 'v4-producer-source-kind',
    pattern: /format v4 message requires a producer-owned source kind/i,
    note: 'upstream #1229: v3 legacy source.kind="plugin" rows pass read-side checks but poison every write round',
    severity: 'high',
  },
  {
    id: 'preset-not-composed',
    pattern: /runs under agent preset .* which the one-shot runner does not compose/i,
    note: 'session carries an agentPreset the headless one-shot runner cannot compose (sampling bug if seen here)',
    severity: 'warn',
  },
  {
    id: 'cwd-mismatch',
    pattern: /was recorded in .* not /i,
    note: 'process cwd did not match the recorded session cwd',
    severity: 'warn',
  },
];

export function matchSignatures(stderr) {
  return WRITE_FAIL_SIGNATURES.filter((s) => s.pattern.test(stderr)).map((s) => ({ id: s.id, note: s.note, severity: s.severity }));
}

/**
 * Read-side integrity over one generation file:
 *  - fully multi-frame decodable (the zlib-only-first-frame trap)
 *  - every line parses as a session entry {type, seq, time, data}
 *  - seq strictly +1 from its minimum
 *  - turn/start..turn/end nesting closes
 */
export function readIntegrity(genPath) {
  const buf = fs.readFileSync(genPath);
  const frames = magicOffsets(buf).length;
  const issues = [];
  const counters = {};
  let rows = [];
  let openTurns = 0;
  try {
    rows = decodeLines(buf).map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        issues.push({ line: i + 1, error: `unparseable line: ${e.message}` });
        return null;
      }
    });
  } catch (e) {
    return { ok: false, issues: [{ line: 0, error: `decode failed: ${e.message}` }], frames, rows: 0 };
  }
  rows = rows.filter(Boolean);
  const seqs = rows.map((r) => r.seq).filter((s) => typeof s === 'number');
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) {
      issues.push({ line: i, error: `seq gap: ${seqs[i - 1]} -> ${seqs[i]}` });
      break;
    }
  }
  for (const r of rows) {
    if (r.type) counters[r.type] = (counters[r.type] || 0) + 1;
    if (r.type === 'turn/start') openTurns++;
    if (r.type === 'turn/end') {
      // bidirectional balance (audit P2-2): a stray turn/end without an open
      // turn is a corruption signal, not something to clamp away.
      if (openTurns === 0) issues.push({ line: 0, error: 'stray turn/end with no open turn' });
      else openTurns--;
    }
  }
  if (openTurns !== 0) issues.push({ line: 0, error: `unbalanced turns: ${openTurns} turn/start without turn/end` });
  return {
    ok: issues.length === 0,
    issues,
    frames,
    rows: rows.length,
    seqMin: seqs.length ? seqs[0] : null,
    seqMax: seqs.length ? seqs[seqs.length - 1] : null,
    typeHistogram: counters,
  };
}

/**
 * Stage verdict for the write-round stage. Preset-carrying rounds cannot be
 * conclusive (replay does not intercept their provider route), so they report
 * honestly but never decide the stage on their own: a stage with only preset
 * attempts is 'inconclusive', and a stage fails/passes on its plain attempts.
 */
export function writeRoundVerdict({ mountOk = true, results = [] } = {}) {
  if (!mountOk) return 'inconclusive';
  if (!results.length) return 'skip';
  if (results.some((r) => r.verdict === 'fail')) return 'fail';
  const plain = results.filter((r) => !r.preset);
  if (!plain.length) return 'inconclusive';
  return plain.every((r) => r.verdict === 'pass') ? 'pass' : 'inconclusive';
}

/**
 * Extract the distinct provider/model routes from a fixture's request/header
 * rows — the replay adapter must serve exactly the routes the live session
 * will request (it replays the session's own recorded history).
 */
export function extractRoutes(fixtureText) {
  const routes = new Map();
  for (const line of fixtureText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type !== 'request/header') continue;
      const cfg = row.data?.header?.config ?? {};
      const provider = cfg.provider ?? 'deepseek-official';
      const model = cfg.model ?? 'deepseek-flash';
      if (!routes.has(provider)) routes.set(provider, { id: provider, name: provider, models: [] });
      const entry = routes.get(provider);
      if (!entry.models.some((m) => m.id === model)) entry.models.push({ id: model, contextWindow: 256000 });
    } catch { /* ignore malformed rows */ }
  }
  return [...routes.values()];
}

/**
 * Tool names a session's own history would replay during a write round.
 * The replay script is DERIVED from the recorded assistant streams, and a
 * settled call can appear in FOUR row shapes (ground truth from a full
 * library census, 2026-10-02): `tool/call`, packed `tool-call-chunks`, and
 * PTC/code-mode dispatch rows (`tool/ptc-dispatch`, `tool/code-dispatch[-
 * start]`) — run_code sessions often carry ONLY dispatch rows. A tool/*
 * row (except tool/result) with no parseable name is recorded as
 * `__unnamed__` so classifyHistory fails CLOSED rather than guessing.
 */
const TOOL_NAME_ROW_TYPES = new Set([
  'tool/call',
  'tool-call-chunks',
  'tool/ptc-dispatch',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
]);

export function extractHistoryTools(fixtureText) {
  const names = new Set();
  const text = typeof fixtureText === 'string' ? fixtureText : String(fixtureText);
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('"tool')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(row.type ?? '');
    if (TOOL_NAME_ROW_TYPES.has(type)) {
      const n = row.data?.name;
      if (typeof n === 'string' && n !== '') names.add(n);
      else names.add('__unnamed__');
    } else if (type.startsWith('tool/') && type !== 'tool/result') {
      names.add('__unnamed__');
    }
  }
  return [...names];
}

/** Side-effectful tool names (exec/write/navigate/control). */
export const WRITE_CLASS_TOOLS = new Set([
  'bash', 'pwsh', 'sh', 'run_code', 'edit', 'write', 'str_replace_editor',
  'computer_script', 'browser_script', 'terminal_open', 'terminal_send',
  'workflow', 'ralph', 'spawn_teammate', 'cordis_inspect_query',
  'present', 'job_kill', 'send_message', 'subagent',
]);

/**
 * Known read-only tools (fail-closed allowlist, audit round 3): a history
 * is drillable only when EVERY tool it would replay is in this set. Anything
 * unknown — third-party (memory/dtodo/compress), MCP (mcp__* prefix), or
 * unnamed — blocks the write round. Ground-truth census of the local library:
 * 36 distinct names; here we whitelist the 12 that are provably side-effect
 * free, deliberately NOT including `memory` (its add action writes the user's
 * cross-session memory store).
 */
export const READONLY_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search',
  'todo_write', 'job_list', 'job_output', 'ask_user_question', 'skill',
  'session_search', 'session_trace', 'session_event_read',
  'session_event_search', 'session_event_trace', 'list_subagent_models',
]);

/**
 * @returns {{ok: boolean, writeClass: string[], unknown: string[]}}
 */
export function classifyHistory(toolNames) {
  const writeClass = [];
  const unknown = [];
  for (const n of toolNames) {
    if (n.startsWith('mcp__') || WRITE_CLASS_TOOLS.has(n)) writeClass.push(n);
    else if (!READONLY_TOOLS.has(n)) unknown.push(n);
  }
  return { ok: writeClass.length === 0 && unknown.length === 0, writeClass, unknown };
}

/**
 * Classify new tool/result rows of a write round into evidence buckets:
 * error-flagged (isError), unknown-toolish (not registered — the expected
 * outcome when tool rows are suppressed), and other (likely executed).
 * Honest labels: we do not claim side effects, only what the log says.
 */
export function classifyToolResults(rows) {
  const out = { total: 0, errorFlagged: 0, unknownToolish: 0, other: 0 };
  for (const r of rows) {
    if (r.type !== 'tool/result') continue;
    out.total++;
    const s = JSON.stringify(r);
    if (s.includes('"isError":true') || s.includes('"isError": true')) out.errorFlagged++;
    else if (/not registered|unknown tool|Unknown tool|not found|cannot find/i.test(s)) out.unknownToolish++;
    else out.other++;
  }
  return out;
}

/**
 * Shared diagnostic-line predicate (audit round 3: sanitizeStderr and
 * firstDiagnostic previously had DIVERGENT rules — one kept a line the other
 * dropped). Kept prefixes only:
 *  - `dsh:` diagnostics EXCEPT the `dsh: reasoning:` marker (no end anchor:
 *    a joined `dsh: reasoning: | prose…` single line must die too)
 *  - error class lines
 *  - llm-replay / patch: diagnostics
 *  - `file://` / `node:internal` stack evidence
 * Dropped by design (round-3 leak paths): bare `at ` (English prose often
 * starts "at the …"), bare `fail…` prefixes ("failure to parse …"), and
 * anything else — including all replayed assistant prose.
 */
export function isDiagnostic(line) {
  const l = String(line).trim();
  if (/^dsh:\s*reasoning:/i.test(l)) return false;
  // Stack frames: `at …` lines are kept ONLY when they carry real frame
  // evidence (file:// / node: / path:line:col). Bare `at the beginning …`
  // prose dies — that was a round-3 leak path.
  if (/^at\s/.test(l)) return /file:\/\/|node:|:\d+:\d+/.test(l);
  return /^(dsh:\s|Error\b|TypeError|ReferenceError|RangeError|SyntaxError|llm-replay|patch:|file:\/\/|node:internal)/.test(l);
}

/**
 * First DIAGNOSTIC headline of a stderr, or undefined for prose-only output.
 * Shares isDiagnostic with sanitizeStderr (round-3 consistency) but skips
 * `at …` frames — a stack line is evidence, not the error's headline.
 */
export function firstDiagnostic(stderr) {
  for (const raw of String(stderr || '').split('\n')) {
    const l = raw.trim();
    if (/^at\s/.test(l)) continue;
    if (isDiagnostic(l)) return l.slice(0, 160);
  }
  return undefined;
}

/**
 * Sanitize a child process stderr for report evidence (audit P1-1): keep
 * only isDiagnostic() lines and DROP everything else (headless echoes
 * replayed reasoning/prose to stderr, which must never reach a report).
 * Returns a compact summary plus the dropped-line count so the report can
 * state honestly how much was withheld.
 */
export function sanitizeStderr(stderr, maxLines = 6) {
  const lines = String(stderr || '').split('\n');
  const kept = lines.map((l) => l.trim()).filter((l) => l !== '' && isDiagnostic(l));
  const dropped = lines.filter((l) => l.trim() !== '').length - kept.length;
  return {
    summary: kept.slice(-maxLines).join(' | ').replace(/\s+/g, ' ').slice(0, 400),
    dropped,
  };
}

/**
 * The keyless write round (v2).
 *
 * 1. fixture = the session's own migrated v4 generation, decompressed to
 *    JSONL (llm-replay consumes projected/plain fixtures; the decompressed
 *    file lives OUTSIDE the session dir — the persistence backend refuses
 *    foreign .jsonl files inside it).
 * 2. caller has written the replay patch (official adapters disabled +
 *    replay adapter inserted for the extracted routes; tool rows suppressed
 *    unless --allow-tools).
 * 3. process cwd = session.shadowCwd (the rewritten sandbox header cwd) —
 *    never the user's real workspace.
 * 4. verdict is STRICT and artifact-driven:
 *      pass          turn/end present with reason.kind !== "error" AND an
 *                    assistant/message row landed
 *      fail          stderr matches a write-path signature (#1229 class) or
 *                    turn/end carries a SessionFormatError
 *      inconclusive  replay never intercepted (MISSING_CREDENTIAL /
 *                    no-adapter / empty script) or the turn did not close
 *                    under tool suppression — the write path was NOT fully
 *                    exercised, which is NOT a compatibility verdict
 */
export async function writeRound({ bin, shadowHome, session, fixturePath, preIntegrity, log = () => {} }) {
  const envExtra = { DSH_SNAPSHOT_FILE: fixturePath };
  const cwd = session.shadowCwd || session.header.cwd;
  const r = await headlessRunWithEnv(bin, shadowHome, ['--session-id', session.sessionId, 'Reply with exactly: ok'], cwd, envExtra, 300000);
  const sigs = matchSignatures(r.stderr);
  const errName = firstDiagnostic(r.stderr);
  const v4z = path.join(shadowHome, 'sessions', session.shadowWsName ?? session.workspaceDirName, session.sessionId, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(v4z)) {
    return { verdict: 'fail', id: session.sessionId, reason: 'no v4 generation after write round', signatures: sigs, stderr: sanitizeStderr(r.stderr) };
  }
  const post = readIntegrity(v4z);
  const newRows = decodeAll(fs.readFileSync(v4z)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((row) => row.seq > (preIntegrity?.seqMax ?? -1));
  const newTypes = {};
  for (const row of newRows) newTypes[row.type] = (newTypes[row.type] || 0) + 1;
  const toolResults = classifyToolResults(newRows);
  const turnEnd = newRows.find((row) => row.type === 'turn/end');
  const completed = turnEnd && turnEnd.data?.reason?.kind && turnEnd.data.reason.kind !== 'error';
  const hasAssistantMessage = (newTypes['assistant/message'] ?? 0) > 0;
  const formatFail = sigs.some((s) => s.id === 'v4-producer-source-kind') || /SessionFormatError/i.test(r.stderr);
  const replayMissed = /MISSING_CREDENTIAL|no adapter registered|llm-replay:/i.test(r.stderr) && !completed;

  let verdict;
  if (formatFail) verdict = 'fail';
  else if (completed && hasAssistantMessage) verdict = 'pass';
  else if (replayMissed) verdict = 'inconclusive';
  else verdict = post.ok ? 'inconclusive' : 'fail';
  log(`write round: exit ${r.code}, rows +${newRows.length}, assistant/message=${newTypes['assistant/message'] ?? 0}, verdict ${verdict}`);
  return {
    verdict,
    id: session.sessionId,
    preset: Boolean(session.header?.agentPreset),
    seqMaxBefore: preIntegrity?.seqMax ?? null,
    seqMaxAfter: post.seqMax,
    newRows: newRows.length,
    newTypes,
    toolResults,
    turnCompleted: Boolean(completed),
    signatures: sigs,
    errorName: errName || undefined,
    stderr: sanitizeStderr(r.stderr),
  };
}

function headlessRunWithEnv(bin, shadowHome, args, cwd, extraEnv, timeoutMs) {
  return run(process.execPath, [bin, '--profile', 'headless', ...args], { cwd, env: { ...shadowEnv(shadowHome), ...extraEnv }, timeoutMs });
}
