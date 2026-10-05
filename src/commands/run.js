// `dsh-rehearsal run --to <version>` — the rehearsal pipeline.
// Stages: a-inventory -> b1-peer-graph -> c-shadow -> d-boot(×2 cold) ->
// e-sessions(migrate+integrity) -> e2-write-round -> f-report.
//
// Safety rules (see lib/shadow.js + lib/util.js): own candidate binary only,
// explicit shadow DSH_HOME, telemetry DISABLED, keyless, artifacts scrubbed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHome, runtimeEvidence, listProfiles, inspectProfile, pickLiveProfile } from '../lib/dshhome.js';
import { discoverSessions, classify, copySet } from '../lib/sessions.js';
import { analyzePeerGraph } from '../lib/peers.js';
import { installCandidate, mountReplayPlugin, headlessRun, writeReplayPatch, patchAdoptionGate } from '../lib/shadow.js';
import { readIntegrity, writeRound, matchSignatures, extractRoutes, sanitizeStderr, extractHistoryTools, classifyHistory, writeRoundVerdict } from '../lib/drill.js';
import { decodeAll } from '../lib/zfstd.js';
import { newReport, addStage, finalize, toMarkdown, writeReport } from '../lib/report.js';
import { stageTimer, validateVersionOption, claimOwnedDir } from '../lib/util.js';

export const BOOT_SIGNATURES = [
  { id: 'patch-entry-not-found', pattern: /patch:\s*entry\s*"[^"]+"\s*not found/i, note: 'upstream #1294 class: a patch row targets a missing entry (also seen as transient jitter — hence two cold boots)' },
  { id: 'port-in-use', pattern: /EADDRINUSE/i, note: 'address already in use' },
  { id: 'module-missing', pattern: /Cannot find module/i, note: 'broken install or native module issue' },
];

function bootFindings(stderr) {
  return [...BOOT_SIGNATURES.filter((s) => s.pattern.test(stderr)).map((s) => s.id), ...matchSignatures(stderr).map((s) => s.id)];
}

/**
 * Desktop scoping for the run verdict. `run` only ever drives the npm
 * candidate it installed itself, so when the drilled sessions come from a
 * desktop-hosted home the verdict describes the npm dependency closure and
 * the session data format — never the desktop app's own update channel. A
 * home counts as desktop-hosted when resolveHome discovered it from the host
 * catalog (origin `desktop:<id>`) or when the live profile follows the
 * measured desktop naming convention (`profiles/desktop`).
 */
export function desktopDataContext(origin, profileName, current, extra = {}) {
  const viaOrigin = typeof origin === 'string' && origin.startsWith('desktop:') ? origin : null;
  const viaProfile = profileName === 'desktop';
  const host = {
    homeOrigin: origin ?? null,
    liveProfile: profileName ?? null,
    currentRuntime: current ?? null,
    desktopScoped: Boolean(viaOrigin || viaProfile),
    scopedVia: [viaOrigin ? 'home-origin' : null, viaProfile ? 'profile-name' : null].filter(Boolean),
    desktopApp: viaOrigin ? origin.slice('desktop:'.length) : null,
    desktopRuntimeTested: false,
  };
  if (extra.currentAmbiguous) host.currentAmbiguous = extra.currentAmbiguous;
  if (extra.runtimeSources?.length) host.runtimeSources = extra.runtimeSources;
  // markers that exist but failed validation: first-class provenance, so
  // "current unknown" can explain WHY
  if (extra.runtimeUntrusted?.length) host.runtimeUntrusted = extra.runtimeUntrusted;
  if (!host.desktopScoped) return { scoped: false, host };
  const via = viaOrigin ? `the ${host.desktopApp} desktop home` : `the desktop-named profile "${profileName}"`;
  const runtime = current
    ? `bundled desktop runtime detected: ${current}`
    : 'bundled desktop runtime NOT detected (excluded-candidate plugins are classified high; re-run with --current to classify)';
  const warning =
    `desktop-scoped rehearsal: sessions come from ${via}; run drives the npm candidate headless against session COPIES — ` +
    `verdicts cover the npm dependency closure and the session format, not the desktop app's own update channel. ${runtime}.`;
  return { scoped: true, host, warning };
}

/**
 * Pure-desktop ambiguity gate: when no valid default home
 * exists and TWO OR MORE desktop homes validate, `run` refuses to choose an
 * experiment target implicitly — `check` (read-only) proceeds with the
 * first and a warning. One validating candidate proceeds labelled.
 */
export function desktopAmbiguityGate(resolved) {
  if (!resolved || typeof resolved.origin !== 'string' || !resolved.origin.startsWith('desktop:')) return { block: false };
  if ((resolved.desktopCandidates ?? 0) < 2) return { block: false };
  const ids = [resolved.origin, ...(resolved.alternates ?? [])].map((a) => a.replace(/^desktop:/, '')).join(', ');
  return {
    block: true,
    message: `run needs an explicit --home: ${resolved.desktopCandidates} desktop homes validated (${ids}); pass --home <dir> to choose the rehearsal target`,
  };
}

export async function cmdRun(opts) {
  if (!opts.to) throw new Error('run requires --to <version> (exact candidate version, e.g. 0.2.0-rc.2)');
  // Validate every version-valued option BEFORE anything expensive happens:
  // an invalid --to would otherwise attempt a network install of a
  // nonexistent version, and an invalid --current would silently turn the
  // peer classification into "current unknown".
  validateVersionOption(opts.to, '--to');
  validateVersionOption(opts.current, '--current');
  // CLI parses `--preset-mode patch` into opts['preset-mode'] (kebab-case
  // keys); accept both spellings so the flag actually takes effect. The
  // value must be one of the two documented modes — anything else used to
  // fall through to the default silently.
  const presetMode = opts.presetMode ?? opts['preset-mode'] ?? 'skip';
  if (!['skip', 'patch'].includes(presetMode)) {
    throw new Error(`--preset-mode must be skip or patch, got ${JSON.stringify(presetMode)}`);
  }
  // Same contract as --sample: a non-numeric budget used to become NaN, the
  // `>= budget` cap comparison then never fired, and the write round ran
  // unbounded over the candidate set instead of erroring.
  const rawWriteRounds = opts.writeRounds ?? opts['write-rounds'] ?? 3;
  const writeRounds = Number(rawWriteRounds);
  if (!Number.isInteger(writeRounds) || writeRounds < 1) throw new Error(`--writeRounds must be a positive integer, got ${JSON.stringify(rawWriteRounds)}`);
  // Home resolution (desktop compatibility): --home > DSH_HOME > a validated
  // default home > a validated host-catalog home. The origin rides in the
  // report as a LABEL (never a path) so a desktop-discovered run is auditable.
  const resolved = resolveHome(opts.home);
  const home = resolved.home;
  const report = newReport({ candidateVersion: opts.to, profile: null, command: 'run' });
  report.target.homeOrigin = resolved.origin;
  const artifactsDir = path.resolve(opts.artifacts ?? path.join(process.cwd(), '.dsh-rehearsal', `run-${opts.to}-${Date.now()}`));
  fs.mkdirSync(artifactsDir, { recursive: true });
  // best-effort ownership: a shared pre-existing --artifacts dir stays usable
  // (reports are additive), it just cannot be removed by `clean` later
  claimOwnedDir(artifactsDir, 'artifact');
  const gate = desktopAmbiguityGate(resolved);
  if (gate.block) {
    report.warnings.push(gate.message);
    finalize(report);
    write(artifactsDir, report);
    return { code: 3, report };
  }
  if (resolved.origin.startsWith('desktop:')) {
    console.log(`  [run] home resolved from host catalog: ${resolved.origin.slice('desktop:'.length)}`);
  }
  if (resolved.alternates.length) {
    // Printed NOW, not only in the end-of-run summary — the pipeline
    // installs ~500 packages before renderSummary() runs, and "also valid:
    // …" arriving minutes later is useless for a decision this early.
    const warn = `multiple valid homes detected (selected ${resolved.origin}; also valid: ${resolved.alternates.join(', ')}) — pass --home to disambiguate`;
    report.warnings.push(warn);
    console.log(`  [run] WARNING: ${warn}`);
  }
  let code = 3;

  // ---- A: inventory + session classification
  let ms = stageTimer();
  const names = listProfiles(home);
  const profiles = names.map((n) => inspectProfile(home, n));
  const live = opts.profile ? profiles.find((p) => p.name === opts.profile) : pickLiveProfile(profiles.filter((p) => p.exists));
  const { sessions } = discoverSessions(home);
  const sampleN = Number(opts.sample ?? 20);
  if (!Number.isInteger(sampleN) || sampleN < 1) throw new Error(`--sample must be a positive integer, got ${JSON.stringify(opts.sample)}`);
  const cls = classify(sessions, { sample: sampleN, full: opts.full, includePreset: presetMode === 'patch' });
  // Observability: selection is stratified, so preset-carrying
  // sessions get a proportional share instead of being tail-graded behind the
  // plain ones. Record the actual intersection: a `--preset-mode patch` run
  // that drills no preset session must say so, not silently patch the
  // candidate and claim the gate was applied.
  const selectedPresetCount = cls.selected.filter((s) => s.presetPatched).length;
  const drillablePresetCount = cls.drillable.filter((s) => s.presetPatched).length;
  if (presetMode === 'patch' && selectedPresetCount === 0) {
    report.warnings.push(
      `--preset-mode patch drilled NO preset-carrying session (selectedPresetCount=0 of ${cls.selected.length}; drillable presets=${drillablePresetCount}, ` +
      `presets skipped=${cls.skipped.preset.length}, already-v4=${cls.skipped.alreadyV4.length}). The adoption-gate patch is not exercised and was not applied.`,
    );
  }
  report.target.profile = live?.name ?? null;
  addStage(report, {
    id: 'a-inventory',
    title: 'inventory + session classification',
    verdict: live && sessions.length ? 'pass' : 'warn',
    durationMs: ms(),
    details: `live=${live?.name ?? 'none'}; sessions=${sessions.length}; drillable=${cls.drillable.length} (selected=${cls.selected.length}; selectedPreset=${selectedPresetCount}, drillablePreset=${drillablePresetCount}); skipped: preset=${cls.skipped.preset.length} alreadyV4=${cls.skipped.alreadyV4.length} cwdMissing=${cls.skipped.cwdMissing.length} headerError=${cls.skipped.headerError.length}`,
    evidence: [
      {
        selected: cls.selected.map((s) => ({ id: s.sessionId, fromGen: s.generations[0].gen, cwdExists: true, bytes: s.bytes, preset: Boolean(s.header?.agentPreset) })),
        skippedPresetSample: cls.skipped.preset.slice(0, 10).map((s) => ({ id: s.sessionId, preset: s.header?.agentPreset })),
        presetSampling: { presetSessionsInLibrary: sessions.filter((s) => s.header?.agentPreset).length, drillablePlain: cls.strata.plain, drillablePreset: cls.strata.preset, selectedPlain: cls.selected.length - selectedPresetCount, selectedPreset: selectedPresetCount, strategy: 'plain-first-preset-floor' },
      },
    ],
  });
  if (!live) {
    finalize(report);
    write(artifactsDir, report);
    return { code: 3, report };
  }

  // ---- B1: peer graph vs candidate (no downloads). current is auto-detected
  // from the running installation so findings split into newly-broken-by-this-
  // upgrade (high/blocking) vs pre-existing (warn).
  ms = stageTimer();
  // --current is authoritative when given; otherwise probe the chain with
  // provenance (profile node_modules → catalog bundles filtered by the home
  // origin → npm prefix; desktop-host version conflicts resolve to null).
  const evidence0 = opts.current
    ? { version: opts.current, sources: [{ host: '--current', version: opts.current, source: '--current' }], ambiguous: null }
    : runtimeEvidence(home, live.name, resolved.origin);
  const current = evidence0.version;
  const dctx = desktopDataContext(resolved.origin, live?.name ?? null, current, {
    currentAmbiguous: evidence0.ambiguous ?? undefined,
    runtimeSources: evidence0.sources,
    runtimeUntrusted: evidence0.untrusted,
  });
  if (dctx.scoped) report.warnings.push(dctx.warning);
  const nm = path.join(live.dir, 'node_modules');
  const pluginDetails = live.plugins.map((p) => {
    let peers = {}, deps = {};
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(nm, ...p.name.split('/'), 'package.json'), 'utf8'));
      peers = pj.peerDependencies ?? {};
      deps = pj.dependencies ?? {};
    } catch { /* declared only */ }
    return { name: p.name, version: p.version, peers, deps, reproducible: p.reproducible, source: p.source };
  });
  const findings = analyzePeerGraph(pluginDetails, { candidate: opts.to, current });
  const blocking = findings.filter((f) => f.severity === 'high');
  const preExisting = findings.filter((f) => f.kind === 'peer-incompatible-pre-existing');
  addStage(report, {
    id: 'b1-peer-graph',
    title: 'static peer graph vs candidate',
    verdict: blocking.length ? 'fail' : findings.length ? 'warn' : 'pass',
    blocking: true,
    durationMs: ms(),
    details: `${pluginDetails.length} plugins vs ${opts.to} (current=${current ?? 'unknown'}); ${findings.length} findings (${blocking.length} newly-broken high, ${preExisting.length} pre-existing)${current ? '' : '; current unknown: excluded-candidate plugins are classified high (re-run with --current)'}`,
    evidence: evidence0.sources.length || evidence0.untrusted?.length
      ? [...findings, {
          currentRuntime: {
            version: evidence0.version,
            sources: evidence0.sources,
            ambiguous: evidence0.ambiguous ?? undefined,
            untrusted: evidence0.untrusted?.length ? evidence0.untrusted : undefined,
          },
        }]
      : findings,
  });

  // ---- C: shadow build
  ms = stageTimer();
  const prefixDir = opts.prefixDir ?? path.join(artifactsDir, 'cli');
  const shadowHome = opts.shadowDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rehearsal-home-'));
  // Cleanup discipline: the shadow home
  // holds FULL session copies plus PLAINTEXT fixtures, so it must be removed
  // on EVERY exit path — success, early return, and throw — unless the
  // caller explicitly keeps it. cleanupShadow() is idempotent; the finally
  // block below is the safety net, F-stage records the outcome in the report.
  const keepShadow = Boolean(opts.keep || opts.shadowDir);
  const keepPrefix = Boolean(opts.keep || opts.prefixDir);
  let shadowCleanup = null;
  const cleanupShadow = () => {
    if (keepShadow) return (shadowCleanup = 'kept');
    if (shadowCleanup) return shadowCleanup;
    try {
      fs.rmSync(shadowHome, { recursive: true, force: true });
      shadowCleanup = 'removed';
    } catch {
      shadowCleanup = 'failed';
    }
    return shadowCleanup;
  };
  const cleanupPrefix = () => {
    if (keepPrefix) return;
    try { fs.rmSync(prefixDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  let bin = null;
  try { // OUTER: guarantees shadow/prefix cleanup on every exit path
    // Ownership gate, before anything is written or downloaded: a
    // --shadow-dir / --prefix-dir is only used when it is missing, empty, or
    // already carries this tool's marker. A non-empty unmarked directory is
    // somebody's data that happens to sit at a path we were handed.
    if (!claimOwnedDir(shadowHome, 'shadow')) {
      throw new Error(`--shadow-dir ${opts.shadowDir ?? shadowHome} holds data but carries no dsh-rehearsal ownership marker — refusing to write into a directory this tool does not own`);
    }
    if (!claimOwnedDir(prefixDir, 'prefix')) {
      throw new Error(`--prefix-dir ${opts.prefixDir ?? prefixDir} holds data but carries no dsh-rehearsal ownership marker — refusing to install into a directory this tool does not own`);
    }
    try {
    bin = await installCandidate(opts.to, prefixDir, (l) => console.log('  [c-shadow]', l), { runScripts: Boolean(opts['run-scripts']) });
    // Never modify the candidate for nothing: the adoption-gate
    // patch only matters when a preset-carrying session will actually drill.
    let gateApplied = false;
    if (presetMode === 'patch') {
      if (selectedPresetCount === 0) {
        console.log('  [c-shadow] --preset-mode patch: no preset session in the selection — candidate left UNPATCHED');
      } else {
        const gate = patchAdoptionGate(prefixDir, (l) => console.log('  [c-shadow]', l));
        gateApplied = gate.ok;
        if (!gate.ok) console.log('  [c-shadow] preset sessions will be skipped:', gate.reason);
      }
    }
    addStage(report, { id: 'c-shadow', title: 'shadow home + candidate install', verdict: 'pass', durationMs: ms(), details: `candidate bin: <tmp>/node_modules/@deepseek-ai/dsh/lib/bin.js; shadow home: <tmp>; install scripts ${opts['run-scripts'] ? 'ALLOWED (--run-scripts)' : 'denied (--ignore-scripts)'}; adoption-gate ${gateApplied ? `patched (${selectedPresetCount} preset session(s) in sample)` : presetMode === 'patch' ? 'NOT applied (no preset session selected)' : 'not requested'}` });
  } catch (e) {
    addStage(report, { id: 'c-shadow', title: 'shadow home + candidate install', verdict: 'fail', blocking: true, durationMs: ms(), details: String(e.message) });
    finalize(report);
    report.shadowCleanup = cleanupShadow(); // failure path: clean BEFORE write too
    write(artifactsDir, report);
    return { code: report.verdict === 'do-not-upgrade' ? 2 : 3, report };
  }

  // ---- D: two cold boots (upstream #1294: first boot can transiently fail)
  ms = stageTimer();
  const boots = [];
  for (let i = 0; i < 2; i++) {
    const r = headlessRun(bin, shadowHome, ['noop'], shadowHome, 180000);
    boots.push({ exit: r.code, findings: bootFindings(r.stderr), missingCredential: /MISSING_CREDENTIAL/i.test(r.stderr), stderr: sanitizeStderr(r.stderr, 3) });
  }
  const bootOk = boots.every((b) => b.missingCredential && b.findings.length === 0);
  const jitter = boots[0].findings.length !== boots[1].findings.length || JSON.stringify(boots[0].findings) !== JSON.stringify(boots[1].findings);
  addStage(report, {
    id: 'd-boot',
    title: 'two cold boots of the empty shadow headless profile',
    verdict: bootOk ? 'pass' : jitter ? 'warn' : 'fail',
    durationMs: ms(),
    details: bootOk ? 'both cold boots reached the model-call boundary (MISSING_CREDENTIAL) with no failure signatures' : jitter ? 'cold boots disagree — treated as reboot jitter, not incompatibility' : `signatures: ${JSON.stringify(boots.map((b) => b.findings))}`,
    evidence: boots,
  });

  // ---- E: session migration drill
  ms = stageTimer();
  const { copied, side } = copySet(home, shadowHome, cls.selected);
  const sessionResults = [];
  let migrated = 0;
  for (const s of cls.selected) {
    const res = { id: s.sessionId, fromGen: s.generations[0].gen, preset: Boolean(s.header?.agentPreset) };
    const before = s.generations.map((g) => path.basename(g.file));
    // launch in the SANDBOX cwd (rewritten header), never the real workspace
    const r = headlessRun(bin, shadowHome, ['--session-id', s.sessionId, 'noop'], s.shadowCwd ?? s.header.cwd, 240000);
    res.exit = r.code;
    res.signatures = matchSignatures(r.stderr);
    res.missingCredential = /MISSING_CREDENTIAL/i.test(r.stderr);
    res.stderr = sanitizeStderr(r.stderr, 4);
    const v4path = path.join(shadowHome, 'sessions', s.shadowWsName ?? s.workspaceDirName, s.sessionId, 'session.v4.jsonl.zstd');
    res.v4Created = fs.existsSync(v4path);
    if (res.v4Created) {
      res.integrity = readIntegrity(v4path);
      res.before = before;
      res.migrated = res.v4Created && res.integrity.ok;
      if (res.migrated) migrated++;
      res.preSeqMax = res.integrity.seqMax;
    }
    sessionResults.push(res);
  }
  const migrationFails = sessionResults.filter((r) => r.signatures?.some((x) => x.severity === 'high') || (r.v4Created && r.integrity && !r.integrity.ok));
  addStage(report, {
    id: 'e-sessions',
    title: 'keyless migration drill (lazy v0->v4) + read-side integrity',
    verdict: sessionResults.length === 0 ? 'skip' : migrationFails.length ? 'fail' : sessionResults.every((r) => r.v4Created) ? 'pass' : 'warn',
    durationMs: ms(),
    details: `copied=${copied.length} (side data: ${side.join(', ') || 'none'}); migrated=${migrated}/${sessionResults.length} (preset in sample=${sessionResults.filter((r) => r.preset).length}); verdicts artifact-driven (exit 1 + MISSING_CREDENTIAL is the expected keyless boundary)`,
    evidence: sessionResults.map(({ integrity, ...rest }) => ({ ...rest, typeHistogram: integrity?.typeHistogram, seq: [integrity?.seqMin, integrity?.seqMax], integrityIssues: integrity?.issues })),
  });
  const migratedPreset = sessionResults.filter((r) => r.preset && r.migrated).length;
  report.coverage = {
    sessions: {
      total: sessions.length,
      drillable: cls.drillable.length,
      selected: cls.selected.length,
      migrated,
      migratedShareOfDrillable: cls.drillable.length ? `${Math.round((migrated / cls.drillable.length) * 100)}%` : 'n/a',
      preset: {
        inLibrary: sessions.filter((s) => s.header?.agentPreset).length,
        drillable: drillablePresetCount,
        selected: selectedPresetCount,
        migrated: migratedPreset,
        selectionStrategy: 'plain-first-preset-floor',
      },
      skipped: {
        preset: cls.skipped.preset.length,
        alreadyV4: cls.skipped.alreadyV4.length,
        cwdMissing: cls.skipped.cwdMissing.length,
        headerError: cls.skipped.headerError.length,
      },
      note:
        presetMode !== 'patch'
          ? 'preset sessions are skipped; rerun with --preset-mode patch to include them (format-level verdicts only)'
          : selectedPresetCount === 0
            ? '--preset-mode patch was requested but NO preset session entered the sample: the adoption-gate was neither patched nor exercised'
            : `${selectedPresetCount} preset session(s) drilled with the adoption-gate patch (${migratedPreset} migrated); their composition was NOT reconstructed, so those verdicts are format-level only`,
    },
  };
  report.coverage.host = dctx.host;

  // ---- E2: keyless write round via @deepseek-ai/dsh-llm-replay
  // llm-replay ships no dsh.bundle: install only lands the dependency; the
  // replay adapter is activated by patch rows we write into the shadow
  // profile (official adapters disabled, replay inserted for every route the
  // drilled sessions actually used). Fixture per session = its own migrated
  // v4 generation, decompressed OUTSIDE the session dir.
  //
  // SAFETY — three stacked layers:
  //  a) process cwd is always the sandbox (header rewritten by copySet);
  //  b) unless --allow-tools, every `tool-*` row is disabled in the patch, so
  //     replayed historical tool calls cannot reach a real executor;
  //  c) pre-screen: the replay script can ONLY emit tools present in the
  //     session's own history — sessions whose history contains write-class
  //     tools are skipped entirely unless --allow-tools is given.
  const allowTools = Boolean(opts.allowTools ?? opts['allow-tools']);
  let skippedWriteTools = [];
  if (!opts.skipWrite) {
    ms = stageTimer();
    console.log(`  [e2-write] tool execution: ${allowTools ? 'ENABLED by --allow-tools (sandbox cwd only)' : 'SUPPRESSED (default)'}`);
    const migrated = sessionResults.filter((r) => r.migrated);
    const mount = mountReplayPlugin(bin, shadowHome, opts.to, (l) => console.log('  [e2-write]', l));
    const writeResults = [];
    if (mount.ok && migrated.length) {
      const routes = new Map();
      const fixtureBySession = new Map();
      const historyTools = new Map();
      for (const s of cls.selected) {
        const res = sessionResults.find((x) => x.id === s.sessionId);
        if (!res?.migrated) continue;
        const v4z = path.join(shadowHome, 'sessions', s.shadowWsName ?? s.workspaceDirName, s.sessionId, 'session.v4.jsonl.zstd');
        const fixture = path.join(shadowHome, `fixture-${s.sessionId}.jsonl`);
        // v4 logs are MULTI-FRAME zstd: naive zstdDecompressSync silently
        // reads only the first frame (which is why zfstd.js exists).
        fs.writeFileSync(fixture, decodeAll(fs.readFileSync(v4z)));
        fixtureBySession.set(s.sessionId, fixture);
        const text = fs.readFileSync(fixture, 'utf8');
        historyTools.set(s.sessionId, extractHistoryTools(text));
        for (const route of extractRoutes(text)) {
          if (!routes.has(route.id)) routes.set(route.id, route);
          else for (const m of route.models) if (!routes.get(route.id).models.some((x) => x.id === m.id)) routes.get(route.id).models.push(m);
        }
      }
      const patchRes = writeReplayPatch(shadowHome, bin, {
        adapterNamePrefixes: ['@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-llm-pi-ai'],
        providers: [...routes.values()],
        fixturePath: null,
        suppressToolRows: !allowTools,
      });
      console.log(`  [e2-write] patch: disabled adapters=[${patchRes.disableIds.filter((id) => !patchRes.suppressedToolIds.includes(id)).join(',')}], suppressed tool rows=${patchRes.suppressedToolIds.length}`);
      const budget = writeRounds;
      const candidates = cls.selected.filter((x) => fixtureBySession.has(x.sessionId));
      for (const s of candidates) {
        const tools = historyTools.get(s.sessionId) ?? [];
        // fail-closed ALLOWLIST: every replayed tool must be
        // a known read-only builtin; mcp__*/write-class/unknown/unnamed all
        // block. Denylist semantics were fail-open for MCP & third-party.
        const clsHist = classifyHistory(tools);
        if (!allowTools && !clsHist.ok) {
          skippedWriteTools.push({ id: s.sessionId, historyTools: tools, writeClass: clsHist.writeClass, unknown: clsHist.unknown });
          continue;
        }
        if (writeResults.length >= budget) break;
        const res = sessionResults.find((x) => x.id === s.sessionId);
        const wr = await writeRound({ bin, shadowHome, session: s, fixturePath: fixtureBySession.get(s.sessionId), preIntegrity: res.integrity });
        writeResults.push(wr);
      }
      if (skippedWriteTools.length) {
        console.log(`  [e2-write] pre-screen: ${skippedWriteTools.length} session(s) skipped — replayed tools outside the read-only allowlist (rerun with --allow-tools to include)`);
      }
    }
    const fails = writeResults.filter((r) => r.verdict === 'fail');
    const attempted = writeResults.length;
    // Preset-carrying sessions cannot yield a conclusive write round: under the
    // patched gate the replay adapter does not intercept their provider route
    // (measured: 2/2 -> MISSING_CREDENTIAL, rows land as assistant/attempt, not
    // assistant/message). That is a finding about the replay mechanism, so the
    // rounds are still RUN and reported — they just must not decide the stage
    // verdict when a plain session also ran.
    const plainRounds = writeResults.filter((r) => !r.preset);
    const presetRounds = writeResults.filter((r) => r.preset);
    const passed = writeResults.filter((r) => r.verdict === 'pass').length;
    const e2Verdict = writeRoundVerdict({ mountOk: mount.ok, results: writeResults });
    addStage(report, {
      id: 'e2-write-round',
      title: `keyless write round (llm-replay adapter; tools ${allowTools ? 'ENABLED (--allow-tools)' : 'SUPPRESSED'}; strict verdict)`,
      verdict: e2Verdict,
      blocking: fails.length > 0,
      durationMs: ms(),
      details: !mount.ok
        ? 'llm-replay mount failed — write path not exercised'
        : attempted === 0
          ? `no write round attempted (migrated candidates=${migrated.length}, skipped non-readonly=${skippedWriteTools.length})`
          : `${attempted} write rounds: ${writeResults.map((r) => `${r.id.slice(0, 13)}=${r.verdict}${r.preset ? '(preset)' : ''}`).join(', ')}; skipped non-readonly=${skippedWriteTools.length}; a 'fail' with v4-producer-source-kind is upstream #1229 class (read-side checks pass)`,
      evidence: writeResults,
    });
    if (mount.ok && attempted > 0 && passed === 0) {
      const allPreset = writeResults.every((r) => r.preset);
      report.warnings.push(
        `write round produced NO conclusive pass (${attempted} attempt(s): ${writeResults.map((r) => r.verdict).join('/')}). ` +
        (allPreset ? 'Every attempt was a preset-carrying session — replay does not intercept their provider route, so those rounds are format-level only. ' : '') +
        `Pre-screen blocked ${skippedWriteTools.length} session(s) on non-read-only history tools; write candidates are drawn from the sample only, so raise --sample to widen the pool.`,
      );
    }
    report.coverage = {
      ...report.coverage,
      writeRounds: {
        attempted,
        pass: passed,
        fail: fails.length,
        inconclusive: writeResults.filter((r) => r.verdict === 'inconclusive').length,
        plainAttempts: plainRounds.length,
        plainPass: plainRounds.filter((r) => r.verdict === 'pass').length,
        presetAttempts: presetRounds.length,
        presetPass: presetRounds.filter((r) => r.verdict === 'pass').length,
        skippedWriteTools: skippedWriteTools.length,
        toolExecution: allowTools ? 'enabled-by-flag' : 'suppressed',
        skippedSessions: skippedWriteTools.map((s) => ({ id: s.id, historyTools: s.historyTools, writeClass: s.writeClass, unknown: s.unknown })),
      },
    };
  }

  // ---- F: finalize
  // Record cleanup in the report BEFORE writing: success path cleans here,
  // any throw/early-return below is caught by the finally net.
  finalize(report);
  report.shadowCleanup = cleanupShadow();
  cleanupPrefix();
  write(artifactsDir, report);
  console.log(`\nreport: ${artifactsDir}`);
  code = report.verdict === 'upgrade-ok' ? 0 : report.verdict === 'upgrade-with-conditions' ? 1 : report.verdict === 'do-not-upgrade' ? 2 : 3;
  return { code, report, artifactsDir, shadowHome: keepShadow ? shadowHome : null };
  } finally {
    // Runs on success (idempotent no-op) AND on any throw/early return.
    if (shadowCleanup === null) cleanupShadow();
    cleanupPrefix();
  }
}

function write(dir, report) {
  // writeReport re-runs finalize() when needed, so a stage that forgets to
  // finalize cannot publish a report that still claims privacy.scrubbed=true
  writeReport(dir, report);
}
