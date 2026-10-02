// `dsh-rehearsal check` — read-only static pre-flight (stages A + B1).
// No downloads, no spawns, no writes outside the artifact directory. Works
// while DSH Desktop is running and covers the desktop profile the npm CLI
// refuses to touch, because it only parses files.

import fs from 'node:fs';
import path from 'node:path';
import { defaultHome, listProfiles, inspectProfile, pickLiveProfile, readSettingsShape, readMarketFacts, detectCurrentDshVersion } from '../lib/dshhome.js';
import { discoverSessions } from '../lib/sessions.js';
import { analyzePeerGraph } from '../lib/peers.js';
import { newReport, addStage, finalize, toMarkdown, homeShape, writeReport } from '../lib/report.js';
import { stageTimer } from '../lib/util.js';

export async function cmdCheck(opts) {
  const home = opts.home ?? defaultHome();
  const report = newReport({ candidateVersion: opts.candidate ?? null, profile: null, command: 'check' });
  const artifactsDir = path.resolve(opts.artifacts ?? path.join(process.cwd(), '.dsh-rehearsal', `check-${Date.now()}`));
  fs.mkdirSync(artifactsDir, { recursive: true });

  // ---- A: inventory
  let ms = stageTimer();
  const names = listProfiles(home);
  const profiles = names.map((n) => inspectProfile(home, n));
  const live = opts.profile ? profiles.find((p) => p.name === opts.profile) : pickLiveProfile(profiles.filter((p) => p.exists));
  const { sessions } = discoverSessions(home);
  const genDist = {};
  const presetDist = {};
  for (const s of sessions) {
    genDist[s.maxGen] = (genDist[s.maxGen] || 0) + 1;
    const k = s.header?.agentPreset ? String(s.header.agentPreset) : '(none)';
    presetDist[k] = (presetDist[k] || 0) + 1;
  }
  addStage(report, {
    id: 'a-inventory',
    title: 'inventory (file-parse only)',
    verdict: live ? 'pass' : 'fail',
    blocking: true,
    durationMs: ms(),
    details: live
      ? `home=${homeShape(home, defaultHome())}; profiles=[${names.join(', ')}]; live=${live.name} (bundles=${live.stats.bundleCount}, patchRows=${live.stats.patchRowCount}, plugins=${live.stats.pluginCount}, ${live.plugins.filter((p) => !p.reproducible).length} non-reproducible); sessions=${sessions.length} (genDist=${JSON.stringify(genDist)}, presets=${JSON.stringify(presetDist)}); settings=${readSettingsShape(home).kind}`
      : `no usable profile found under the given DSH_HOME (home=${homeShape(home, defaultHome())})`,
    evidence: live
      ? [
          { live: live.name, ranked: profiles.filter((p) => p.exists).map((p) => ({ name: p.name, ...p.stats })), patchLayers: live.patchLayers, workspace: live.workspace ?? null, marketFacts: readMarketFacts(home, live.name) },
        ]
      : [],
  });
  report.target.profile = live?.name ?? null;

  if (!live) {
    finalize(report);
    writeArtifacts(artifactsDir, report);
    return { report, code: 3 };
  }

  // ---- B1: peer graph. current auto-detected ONCE, reused by the analysis
  // and the details line (round-3 nit: was probed twice).
  ms = stageTimer();
  const current = opts.current ?? detectCurrentDshVersion(home, live.name);
  const pluginDetails = [];
  const nm = path.join(live.dir, 'node_modules');
  for (const p of live.plugins) {
    const pjPath = path.join(nm, ...p.name.split('/'), 'package.json');
    let peers = {};
    let deps = {};
    try {
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      peers = pj.peerDependencies ?? {};
      deps = pj.dependencies ?? {};
    } catch {
      /* not installed on disk (declared only) */
    }
    pluginDetails.push({ name: p.name, version: p.version, peers, deps, reproducible: p.reproducible, source: p.source });
  }
  const findings = analyzePeerGraph(pluginDetails, { candidate: opts.candidate, current });
  const blockingFindings = findings.filter((f) => f.severity === 'high');
  const preExisting = findings.filter((f) => f.kind === 'peer-incompatible-pre-existing');
  const noCandidate = !opts.candidate;
  addStage(report, {
    id: 'b1-peer-graph',
    title: 'static peer graph (no downloads)',
    // Without a candidate there is nothing to compare against: the
    // newly-broken count would be a number computed from no input. Report the
    // static facts, but say the headline question was not asked.
    verdict: noCandidate ? 'warn' : blockingFindings.length ? 'fail' : findings.length ? 'warn' : 'pass',
    blocking: true,
    durationMs: ms(),
    details: `${noCandidate ? 'no --candidate given, newly-broken comparison NOT exercised; ' : ''}${pluginDetails.length} plugins analyzed against candidate=${opts.candidate ?? 'n/a'} current=${current ?? 'n/a'}; ${findings.length} findings (${blockingFindings.length} newly-broken high, ${preExisting.length} pre-existing)`,
    evidence: findings,
  });
  if (noCandidate) {
    report.warnings.push('no --candidate: the "0 newly-broken high" figure is an unrun comparison, not a clean result. Re-run with --candidate <version> to answer the upgrade question.');
  }

  finalize(report);
  writeArtifacts(artifactsDir, report);
  const code = report.verdict === 'upgrade-ok' ? 0 : report.verdict === 'upgrade-with-conditions' ? 1 : report.verdict === 'do-not-upgrade' ? 2 : 3;
  return { report, code };
}

export function writeArtifacts(dir, report) {
  // routed through writeReport so an un-finalized report cannot reach disk
  // claiming privacy.scrubbed=true
  writeReport(dir, report);
  return dir;
}
