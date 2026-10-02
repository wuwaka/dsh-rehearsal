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
 */
export function homeShape(home) {
  if (typeof home !== 'string' || !home) return 'unknown';
  const def = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
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
      scrubbed: true,
      // Honest capability statement (audit P1-1): reports never carry message
      // bodies; stderr evidence is filtered to diagnostic lines only, and
      // messages are never read by the tool itself (session bodies are only
      // ever byte-scanned for poison-row counts, never stored or echoed).
      messageContentInReports: false,
      stderrEvidence: 'filtered to dsh:/error/stack diagnostic lines; prose dropped and counted',
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
 * Scrub ONE STRING. Rules (audit P1-2 broadened):
 *  1. user home dirs on any platform -> `~` (C:\Users\<n>, /home/<u>, /Users/<u>)
 *  2. ANY other drive-rooted absolute path -> `<abs-path>` (any drive letter,
 *     forward AND back slashes, and spaces inside the path are consumed too)
 *  3. credential shapes
 * Applied per string VALUE via scrubValue — never to a JSON.stringify'd blob,
 * where Windows paths become double-backslash and no regex matches.
 */
export function scrubText(s) {
  let out = String(s);
  out = out.replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g, '~');
  out = out.replace(/\/(?:home|Users)\/[^/\s"']+/g, '~');
  // Paths may contain spaces ("My Docs", "Program Files"). Stopping the match
  // at whitespace redacted only the leading segments and LEAKED THE TAIL —
  // measured on a real machine: `D:\Work\a b\c.log` came out as
  // `<abs-path> b\c.log`. Consume to the end of the field instead, delimited
  // by the separators that actually appear in details/stderr summaries
  // (quote, pipe, comma, semicolon, EOL) so prose around a path survives.
  out = out.replace(/\b[A-Za-z]:[\\/][^"'|,;\n\r]*/g, '<abs-path>');
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]');
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return out;
}

/** Recursively scrub every string leaf of an evidence value. */
export function scrubValue(v) {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrubValue(x);
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
  return report;
}
