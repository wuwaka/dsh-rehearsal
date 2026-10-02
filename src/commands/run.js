// `dsh-rehearsal run --to <version>` — the rehearsal pipeline.
// Stages: a-inventory -> b1-peer-graph -> c-shadow -> d-boot(×2 cold) ->
// e-sessions(migrate+integrity) -> e2-write-round -> f-report.
//
// Safety rules (see lib/shadow.js + lib/util.js): own candidate binary only,
// explicit shadow DSH_HOME, telemetry DISABLED, keyless, artifacts scrubbed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultHome, listProfiles, inspectProfile, pickLiveProfile, detectCurrentDshVersion } from '../lib/dshhome.js';
import { discoverSessions, classify, copySet } from '../lib/sessions.js';
import { analyzePeerGraph } from '../lib/peers.js';
import { installCandidate, mountReplayPlugin, headlessRun, writeReplayPatch, patchAdoptionGate } from '../lib/shadow.js';
import { readIntegrity, writeRound, matchSignatures, extractRoutes, sanitizeStderr, extractHistoryTools, classifyHistory, writeRoundVerdict } from '../lib/drill.js';
import { decodeAll } from '../lib/zfstd.js';
import { newReport, addStage, finalize, toMarkdown } from '../lib/report.js';
import { stageTimer } from '../lib/util.js';

const BOOT_SIGNATURES = [
  { id: 'patch-entry-not-found', pattern: /patch:\s*entry\s*"[^"]+"\s*not found/i, note: 'upstream #1294 class: a patch row targets a missing entry (also seen as transient jitter — hence two cold boots)' },
  { id: 'port-in-use', pattern: /EADDRINUSE/i, note: 'address already in use' },
  { id: 'module-missing', pattern: /Cannot find module/i, note: 'broken install or native module issue' },
];

function bootFindings(stderr) {
  return [...BOOT_SIGNATURES.filter((s) => s.pattern.test(stderr)).map((s) => s.id), ...matchSignatures(stderr).map((s) => s.id)];
}

export async function cmdRun(opts) {
  if (!opts.to) throw new Error('run requires --to <version> (exact candidate version, e.g. 0.2.0-rc.2)');
  const home = opts.home ?? defaultHome();
  const report = newReport({ candidateVersion: opts.to, profile: null, command: 'run' });
  const artifactsDir = path.resolve(opts.artifacts ?? path.join(process.cwd(), '.dsh-rehearsal', `run-${opts.to}-${Date.now()}`));
  fs.mkdirSync(artifactsDir, { recursive: true });
  let code = 3;

  // ---- A: inventory + session classification
  let ms = stageTimer();
  const names = listProfiles(home);
  const profiles = names.map((n) => inspectProfile(home, n));
  const live = opts.profile ? profiles.find((p) => p.name === opts.profile) : pickLiveProfile(profiles.filter((p) => p.exists));
  const { sessions } = discoverSessions(home);
  // CLI parses `--preset-mode patch` into opts['preset-mode'] (kebab-case
  // keys); accept both spellings so the flag actually takes effect.
  const presetMode = opts.presetMode ?? opts['preset-mode'] ?? 'skip';
  const sampleN = Number(opts.sample ?? 20);
  if (!Number.isInteger(sampleN) || sampleN < 1) throw new Error(`--sample must be a positive integer, got ${JSON.stringify(opts.sample)}`);
  const cls = classify(sessions, { sample: sampleN, full: opts.full, includePreset: presetMode === 'patch' });
  // Observability (audit round 4): selection is stratified, so preset-carrying
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
  // upgrade (high/blocking) vs pre-existing (warn) — audit P2-1.
  ms = stageTimer();
  const current = opts.current ?? detectCurrentDshVersion(home, live.name);
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
    details: `${pluginDetails.length} plugins vs ${opts.to} (current=${current ?? 'unknown'}); ${findings.length} findings (${blocking.length} newly-broken high, ${preExisting.length} pre-existing)`,
    evidence: findings,
  });

  // ---- C: shadow build
  ms = stageTimer();
  const prefixDir = opts.prefixDir ?? path.join(artifactsDir, 'cli');
  const shadowHome = opts.shadowDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rehearsal-home-'));
  // Cleanup discipline (audit round 3, P2-5 completion): the shadow home
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
    try {
    bin = await installCandidate(opts.to, prefixDir, (l) => console.log('  [c-shadow]', l), { runScripts: Boolean(opts['run-scripts']) });
    // Never modify the candidate for nothing (audit round 4): the adoption-gate
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

  // ---- E2: keyless write round via @deepseek-ai/dsh-llm-replay
  // llm-replay ships no dsh.bundle: install only lands the dependency; the
  // replay adapter is activated by patch rows we write into the shadow
  // profile (official adapters disabled, replay inserted for every route the
  // drilled sessions actually used). Fixture per session = its own migrated
  // v4 generation, decompressed OUTSIDE the session dir.
  //
  // SAFETY (audit P0-1) — three stacked layers:
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
        // reads only the first frame (the trap zfstd.js exists for).
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
      const budget = Number(opts.writeRounds ?? 3);
      const candidates = cls.selected.filter((x) => fixtureBySession.has(x.sessionId));
      for (const s of candidates) {
        const tools = historyTools.get(s.sessionId) ?? [];
        // fail-closed ALLOWLIST (audit round 3): every replayed tool must be
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
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), toMarkdown(report));
}
