// dsh-rehearsal/v1 report assembly, Markdown rendering and scrubbing.

import fs from 'node:fs';
import path from 'node:path';
import { nowIso, redactedEnvNames } from './util.js';

const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
).version;

/**
 * Describe a DSH_HOME without putting its path in the report.
 *
 * Scrubbing a composed path is a filter with known gaps (a Unix home outside
 * /home or /Users, a UNC share, a relative --home all pass through). The
 * inventory line only needs to say whether the default location was used, so
 * the path is never composed in the first place.
 *
 * `def` must come from the caller's defaultHome(): recomputing it here drifted
 * (with USERPROFILE and HOME unset, the local expression fell back to a
 * cwd-relative ".dsh" while defaultHome() used os.homedir()), which would have
 * labelled the real default as "custom".
 */
export function homeShape(home, def, origin) {
  // Desktop-discovered homes carry a catalog-slug origin (`desktop:<id>` —
  // static ids, no user input, no separators); the shape IS the origin.
  if (typeof origin === 'string' && origin.startsWith('desktop:')) return origin;
  if (typeof home !== 'string' || !home) return 'unknown';
  if (typeof def !== 'string' || !def) return 'custom';
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  try {
    if (norm(home) === norm(def)) return 'default';
  } catch {
    return 'unknown';
  }
  return 'custom';
}

export function newReport({ candidateVersion, profile, command }) {
  return {
    schema: 'dsh-rehearsal/v1',
    tool: { name: 'dsh-rehearsal', version: pkgVersion },
    command,
    generatedAt: nowIso(),
    target: { candidateVersion: candidateVersion ?? null, profile: profile ?? null },
    stages: [],
    // Fixed disclaimer: this tool's relation to official gating. The official
    // plugin-manager blocks incompatible peers at install/startup and offers
    // exact-version exemptions; a rehearsal adds pre-upgrade cross-version
    // aggregation plus real-session migration & write evidence.
    officialGating: 'official gating intercepts at install/startup; rehearsal adds pre-upgrade evidence',
    rollback: {
      sessionsAreOneWay: true,
      note: 'sessions migrated to v4 are REFUSED (not rewritten) by older hosts — downgrade after migration is not possible; rollback relies exclusively on a pre-upgrade snapshot of DSH_HOME',
    },
    privacy: {
      // Set by finalize(), not at construction: a report that never reached
      // finalize() must not claim it was scrubbed.
      scrubbed: false,
      // Honest capability statement (audit P1-1): reports never carry message
      // bodies; stderr evidence is filtered to diagnostic lines only, and
      // messages are never read by the tool itself (session bodies are only
      // ever byte-scanned for poison-row counts, never stored or echoed).
      messageContentInReports: false,
      stderrEvidence: 'filtered to dsh:, error:, and stack-frame diagnostic lines; prose dropped and counted',
      telemetry: 'DSH_TELEMETRY_MODE=DISABLED and credential-shaped env vars stripped for all candidate runs',
      keyless: 'no provider credentials are present in any child environment',
      redactedEnv: redactedEnvNames(),
    },
    verdict: null,
    // Run-level caveats that change how the verdict should be read (e.g. a flag
    // that had nothing to act on). Rendered in both JSON and Markdown.
    warnings: [],
  };
}

export function addStage(report, stage) {
  report.stages.push(stage);
  return stage;
}

/** Aggregate stage verdicts into the single go/no-go verdict. */
export function finalizeVerdict(report) {
  const v = report.stages.map((s) => s.verdict);
  if (v.includes('fail')) report.verdict = report.stages.some((s) => s.verdict === 'fail' && s.blocking) ? 'do-not-upgrade' : 'upgrade-with-conditions';
  else if (v.includes('inconclusive') || v.includes('warn')) report.verdict = 'upgrade-with-conditions';
  else if (v.length && v.every((x) => x === 'pass' || x === 'skip')) report.verdict = 'upgrade-ok';
  else report.verdict = 'rehearsal-failed';
  return report.verdict;
}

/**
 * Scrub ONE STRING. Rules:
 *  1. user home dirs on any platform -> `~` (C:\Users\<n>, /home/<u>, /Users/<u>)
 *  2. drive-rooted absolute path -> `<abs-path>` (any drive letter, both slash
 *     directions, spaces inside the path consumed too)
 *  3. POSIX absolute path with >=2 segments -> `<abs-path>`. Without this the
 *     filter only knew /home and /Users, so /root/.dsh (running as root, common
 *     in containers), /var/lib/<svc>, /srv/<team> and /tmp/<shadow> passed
 *     through untouched.
 *  4. UNC share -> `<unc-path>`; parent-relative `../` or `..\` -> `<rel-path>`
 *  5. credential shapes
 * Deliberately greedy to the next field delimiter: over-masking a prose span is
 * safe, leaking the tail of a path is not. URLs survive because the boundary
 * class excludes the `:` of `://` from starting a match, and `//` cannot begin a
 * segment. Repo-relative text (`src/lib/x.js:12`, `sessions/<ws>/file`) has no
 * leading separator and is left alone.
 * Applied per string VALUE via scrubValue — never to a JSON.stringify'd blob,
 * where Windows paths become double-backslash and no regex matches.
 */
const FIELD = '[^"\'`,;|\\n\\r]*';
const BOUND = '(^|[\\s=("\'`:;])';

export function scrubText(s) {
  let out = String(s);
  // Home rules consume to the END OF THE FIELD exactly like the general
  // rules below. The old whitespace-bounded match orphaned the tail once the
  // prefix became `~` (`C:\Users\John Smith\.dsh` -> `~ Smith\.dsh`;
  // `C:\Users\Jane\AppData\Local\Temp\x` -> `~\AppData\Local\Temp\x` — both
  // measured 2026-10-05) and the invariant cannot catch an orphaned tail
  // that no longer looks absolute. An unambiguous home path still normalises
  // to `~`; a field containing spaces is ambiguous, so it escalates to
  // `<abs-path>` rather than risk keeping a fragment.
  out = out.replace(new RegExp(`\\b[A-Za-z]:[\\\\/]Users[\\\\/]${FIELD}`, 'g'), (m) => (/\s/.test(m) ? '<abs-path>' : '~'));
  out = out.replace(new RegExp(`\\/(?:home|Users)\\/${FIELD}`, 'g'), (m) => (/\s/.test(m) ? '<abs-path>' : '~'));
  // Paths may contain spaces ("My Docs", "Program Files"). Stopping the match
  // at whitespace redacted only the leading segments and LEAKED THE TAIL —
  // measured on a real machine: `D:\Work\a b\c.log` came out as
  // `<abs-path> b\c.log`. Consume to the end of the field instead.
  out = out.replace(new RegExp(`\\b[A-Za-z]:[\\\\/]${FIELD}`, 'g'), '<abs-path>');
  out = out.replace(new RegExp(`${BOUND}\\/(?:[^\\/"'\`,;|\\n\\r]+\\/)${FIELD}`, 'g'), '$1<abs-path>');
  out = out.replace(new RegExp(`${BOUND}\\\\\\\\${FIELD}`, 'g'), '$1<unc-path>');
  out = out.replace(new RegExp(`${BOUND}\\.\\.[\\\\/]${FIELD}`, 'g'), '$1<rel-path>');
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]');
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return out;
}

/** Shapes that must never appear in a report. Used by the finalize() invariant. */
export function findPathShapes(text) {
  const t = String(text);
  const pats = [
    /\b[A-Za-z]:[\\/]/g,
    /(^|[\s=("'`:;])\/(?:[^/"'`,;|\n\r]+\/)/g,
    /(^|[\s=("'`:;])\\\\/g,
    /(^|[\s=("'`:;])\.\.[\\/]/g,
  ];
  const hits = [];
  for (const p of pats) for (const m of t.matchAll(p)) hits.push(m[0].trim());
  return hits;
}

/** Recursively scrub every string leaf of an evidence value. */
export function scrubValue(v) {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out = {};
    // Keys are scrubbed too: an object keyed by a path (`{ '/root/.dsh': … }`)
    // used to bypass redaction entirely, since only values passed through.
    for (const [k, x] of Object.entries(v)) out[scrubText(k)] = scrubValue(x);
    return out;
  }
  return v;
}

export function scrubStage(stage) {
  const out = { ...stage };
  if (out.details) out.details = scrubText(out.details);
  if (out.evidence) out.evidence = scrubValue(out.evidence);
  return out;
}

export function toMarkdown(report) {
  const L = [];
  L.push(`# dsh-rehearsal report — ${report.command}`);
  L.push('');
  L.push(`- generated: ${report.generatedAt}`);
  L.push(`- candidate: \`${report.target.candidateVersion ?? 'n/a'}\` | profile: \`${report.target.profile ?? 'n/a'}\``);
  L.push(`- **verdict: ${report.verdict}**`);
  if (report.warnings?.length) {
    for (const w of report.warnings) L.push(`- **WARNING**: ${scrubText(w)}`);
  }
  L.push(`- ${report.officialGating}`);
  L.push(`- rollback: ${report.rollback.note}`);
  L.push('');
  L.push('| stage | verdict | ms | notes |');
  L.push('| --- | --- | --- | --- |');
  for (const s of report.stages) {
    L.push(`| ${s.id} | ${s.verdict} | ${s.durationMs ?? '-'} | ${scrubText(s.details ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`);
  }
  for (const s of report.stages) {
    if (!s.evidence?.length) continue;
    L.push('');
    L.push(`## ${s.id} evidence`);
    for (const e of s.evidence.slice(0, 40)) {
      L.push(`- ${typeof e === 'string' ? scrubText(e) : '```json\n' + JSON.stringify(e, null, 2) + '\n```'}`);
    }
  }
  if (report.coverage) {
    L.push('');
    L.push('## Coverage');
    L.push('```json');
    L.push(JSON.stringify(report.coverage, null, 2));
    L.push('```');
  }
  return L.join('\n');
}

export function finalize(report) {
  finalizeVerdict(report);
  report.stages = report.stages.map(scrubStage);
  if (report.coverage) report.coverage = scrubValue(report.coverage);
  if (report.target) report.target = scrubValue(report.target);
  if (Array.isArray(report.warnings)) report.warnings = report.warnings.map((w) => scrubText(w));
  // Invariant rather than a filter: the rules above know the shapes seen so far,
  // and a later stage can compose one they do not. Surviving path-shaped text
  // marks the report unscrubbed; writeReport() then REFUSES to publish it —
  // an invariant that only warns still ships the leak it detected.
  const scanned = JSON.stringify(Object.fromEntries(Object.entries(report).filter(([k]) => k !== 'warnings')));
  const leftover = [...new Set(findPathShapes(scanned))];
  if (!report.privacy) report.privacy = {};
  if (leftover.length) {
    if (!Array.isArray(report.warnings)) report.warnings = [];
    report.warnings.push(`redaction gap: ${leftover.length} path-shaped token(s) survived scrubbing (e.g. ${leftover.slice(0, 3).join(', ')}) — treat this report as unsanitised until scrubText learns the shape`);
    // "scrubbed" means covered, not "the function ran". A report that failed the
    // invariant says so, rather than carrying a promise it did not keep.
    report.privacy.scrubbed = false;
  } else {
    report.privacy.scrubbed = true;
  }
  return report;
}

/**
 * The only sanctioned way to put a report on disk.
 *
 * finalize() runs on EVERY write, unconditionally: `privacy.scrubbed` is the
 * RESULT of the last scrub, not a permission token. Trusting it to skip work
 * left a real gap — a report finalized once, then mutated by a later stage,
 * reached disk with the mutation unscrubbed and the flag still claiming
 * `true` (measured 2026-10-05: a path injected after finalize shipped
 * verbatim).
 *
 * Fail-closed (review round 5, P1-2): when the invariant still finds
 * path-shaped text after scrubbing, the report is NOT written at all. The
 * earlier behaviour warned and wrote anyway, which contradicted the promise
 * that reports are sanitised before they reach disk — a warning next to
 * leaked data is not a gate.
 */
export function writeReport(dir, report) {
  const done = finalize(report);
  if (done.privacy.scrubbed !== true) {
    const gaps = (done.warnings ?? []).filter((w) => /redaction gap/.test(w)).length;
    throw new Error(`refusing to write an unsanitised report (${gaps} redaction gap warning(s); the offending tokens are listed in the in-memory report only)`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(done, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), toMarkdown(done));
  return done;
}
