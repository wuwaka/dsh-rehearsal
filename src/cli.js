#!/usr/bin/env node
// dsh-rehearsal CLI entry.
//
// Exit codes: 0 upgrade-ok | 1 upgrade-with-conditions | 2 do-not-upgrade |
// 3 rehearsal-failed (tool error, missing inputs, unusable home).

import fs from 'node:fs';
import path from 'node:path';
import { cmdCheck, writeArtifacts } from './commands/check.js';
import { cmdRun } from './commands/run.js';

const USAGE = `dsh-rehearsal — upgrade rehearsal CLI for DeepSeek Harness (dsh)

Commands:
  check [--home <dir>] [--profile <name>] [--candidate <ver>] [--current <ver>]
      Read-only static pre-flight: live-profile detection, patch layers,
      session-library generation stats, plugin peer graph vs candidate.
      No downloads, no spawns, no writes outside .dsh-rehearsal/.

  run --to <ver> [--profile <name>] [--sample N|--full] [--preset-mode skip|patch]
      [--writeRounds N] [--allow-tools] [--run-scripts] [--skip-write]
      [--keep] [--prefix-dir <dir>] [--shadow-dir <dir>] [--home <dir>]
      [--current <ver>]
      Full rehearsal: candidate install into a private prefix (install
      scripts DENIED by default — --run-scripts to allow), two cold boots
      of a shadow headless profile, keyless real-session migration drill
      with read-side integrity, then a keyless write round via
      @deepseek-ai/dsh-llm-replay (replay-only adapter, per-session
      fixture, strict pass = turn closed + assistant message durable).
      Write-round safety (three stacked layers): session copies get their
      header cwd rewritten into a shadow sandbox; tool rows are SUPPRESSED
      by default; sessions whose own history contains write-class tools
      are pre-screened OUT. --allow-tools lifts layers b+c for a session
      whose history you accept executing (cwd stays sandboxed).
      --preset-mode patch also drills sessions carrying an agentPreset by
      neutralizing the one-shot adoption gate inside the private prefix
      (session bytes untouched; composition NOT reconstructed — those
      verdicts are format-level only).

  report <dir> [--format json|md]
      Re-render a report directory.

Home discovery (check/run): --home > $DSH_HOME > a validated default home
(~/.dsh) > a validated host-catalog home (official DeepSeek Harness Desktop;
community DSH Desktop, DSHDesktop). Desktop-origin homes are labelled in
reports (never their paths); run proceeds on a single validating desktop home
and demands --home when several validate.

Safety rules baked in:
  - the ONLY dsh binary invoked is one we npm-install ourselves (the PATH
    desktop shim ignores DSH_HOME and can touch your real home)
  - DSH_TELEMETRY_MODE=DISABLED and DEEPSEEK_API_KEY removed for every child
  - verdicts come from artifacts, never from exit codes (a successful keyless
    migration exits 1 with MISSING_CREDENTIAL)
  - reports never contain message content; paths are scrubbed, and a report
    whose scrub invariant fails is refused, not written
  - --shadow-dir / --prefix-dir are never auto-cleaned (a shadow dir holds
    plaintext session copies); clean --yes only removes the default directory
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else opts._.push(a);
  }
  return opts;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  // `--help` arrives here as the command word, so it must be matched before
  // parseArgs/switch — otherwise the conventional invocation of an installed
  // CLI falls through to "unknown command" and exits 3, which this tool
  // documents as "the rehearsal itself failed".
  if (cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  if (cmd === '-v' || cmd === '--version' || cmd === '-V') {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    console.log(`${pkg.name} ${pkg.version} (node ${process.version})`);
    return;
  }
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'check': {
      const { report, code } = await cmdCheck(opts);
      console.log(renderSummary(report));
      process.exit(code);
      break;
    }
    case 'run': {
      const { report, code } = await cmdRun(opts);
      console.log(renderSummary(report));
      process.exit(code);
      break;
    }
    case 'report': {
      const dir = opts._[0];
      if (!dir || !fs.existsSync(path.join(dir, 'report.json'))) {
        console.error('report: pass a directory containing report.json');
        process.exit(3);
      }
      const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
      const fmt = opts.format ?? 'md';
      if (fmt === 'json') console.log(JSON.stringify(report, null, 2));
      else {
        // re-render through the same markdown path used at write time
        const { toMarkdown } = await import('./lib/report.js');
        console.log(toMarkdown(report));
      }
      break;
    }
    case 'clean': {
      const base = path.resolve(opts.artifacts ?? path.join(process.cwd(), '.dsh-rehearsal'));
      if (!fs.existsSync(base)) {
        console.log('nothing to clean:', base);
        break;
      }
      if (!opts.yes) {
        console.log('would remove:', base, '(rerun with --yes)');
        break;
      }
      const trash = base + '.trash-' + Date.now();
      fs.renameSync(base, trash);
      fs.rmSync(trash, { recursive: true, force: true });
      console.log('removed', base);
      break;
    }
    case 'help':
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(3);
  }
}

function renderSummary(report) {
  const lines = [];
  lines.push(`dsh-rehearsal ${report.command} — verdict: ${report.verdict}`);
  for (const s of report.stages) {
    lines.push(`  [${s.verdict.toUpperCase().padEnd(12)}] ${s.id}${s.details ? ' — ' + s.details.slice(0, 140) : ''}`);
  }
  for (const w of report.warnings ?? []) {
    lines.push(`  ! WARNING: ${w}`);
  }
  lines.push(`rollback note: ${report.rollback.note}`);
  return lines.join('\n');
}

main().catch((e) => {
  console.error('dsh-rehearsal failed:', e.message);
  if (process.env.DSH_REHEARSAL_DEBUG) console.error(e.stack);
  process.exit(3);
});
