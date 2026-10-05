// Shadow-home lifecycle: candidate dsh installation into a private prefix,
// llm-replay mount, and environment rules. Safety rules encoded here:
//  - the ONLY dsh binary ever invoked is the one we npm-installed ourselves
//    (the desktop shim on PATH ignores DSH_HOME and pollutes the real home —
//    verified by review, 2026-10-02)
//  - telemetry explicitly DISABLED (candidate 0.2.0 defaults FEEDBACK_ONLY
//    and OTLP bypasses proxies)
//  - keyless by design: DEEPSEEK_API_KEY removed from the child environment

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, shadowEnv, ASSUMED_CONTEXT_WINDOW_TOKENS } from './util.js';

/**
 * Find npm's npm-cli.js: first beside the running node, then derived from
 * every `where npm` hit. Returns an absolute path or null.
 */
export function locateNpmCli() {
  const beside = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(beside)) return beside;
  try {
    const r = spawnSync('where.exe', ['npm'], { encoding: 'utf8', windowsHide: true });
    const hits = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const hit of hits) {
      const dir = path.dirname(hit);
      const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(cli)) return cli;
    }
  } catch { /* where.exe unavailable (non-Windows): try POSIX which */ }
  try {
    const r = spawnSync('which', ['npm'], { encoding: 'utf8', windowsHide: true });
    const hits = (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
    for (const hit of hits) {
      // resolve symlink chains (nvm/homebrew layouts)
      let cur = hit;
      for (let i = 0; i < 5 && fs.existsSync(cur); i++) {
        const dir = path.dirname(cur);
        const cli = path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (fs.existsSync(cli)) return path.resolve(cli);
        const st = fs.lstatSync(cur);
        if (!st.isSymbolicLink()) break;
        cur = fs.readlinkSync(cur);
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Install an exact @deepseek-ai/dsh version into a private prefix.
 * Reviews measured ~500 packages / 2-5 min per version; npm cache shortens
 * repeats. Returns the bin entry path (lib/bin.js) to invoke via node.
 */
export async function installCandidate(version, prefixDir, log = () => {}, { runScripts = false } = {}) {
  const pkgDir = path.join(prefixDir, 'node_modules', '@deepseek-ai', 'dsh');
  const pj = path.join(pkgDir, 'package.json');
  if (fs.existsSync(pj)) {
    try {
      const v = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
      if (v === version) {
        log(`candidate ${version} already present in ${prefixDir}`);
        return path.join(pkgDir, 'lib', 'bin.js');
      }
    } catch { /* fall through to a fresh install */ }
  }
  fs.mkdirSync(prefixDir, { recursive: true });
  log(`installing @deepseek-ai/dsh@${version} into ${prefixDir} (this takes a few minutes)...`);
  // Locate a usable npm without relying on PATH semantics:
  //  - Node >=20.12 refuses to spawn .cmd shims without a shell (CVE-2024-27980)
  //  - with shell:true, args containing spaces (e.g. "D:\My Program Files")
  //    get split unless hand-quoted — the current node may also be an embedded
  //    runtime (RStudio etc.) that ships no npm at all.
  // So: find npm.cmd via `where`, derive its bundled npm-cli.js, and run it
  // with plain node. No shell, no quoting hazards.
  // Lifecycle scripts of ~500 transitive packages are denied by default
  // (audit P2-8): the official pnpm profile allowlists only esbuild/lefthook/
  // node-pty/koffi etc., so a blanket npm run is a wider execution surface
  // than the user's own profile permits. Escape hatch: runScripts=true
  // (--run-scripts) when a native dep genuinely needs its build step.
  const installArgs = ['install', '--prefix', prefixDir, `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund', '--loglevel=error'];
  if (!runScripts) installArgs.push('--ignore-scripts');
  const npmCli = locateNpmCli();
  if (!npmCli) throw new Error('npm not located (searched beside the running node and via `where npm`) — install Node.js/npm and retry');
  const r = run(process.execPath, [npmCli, ...installArgs], { timeoutMs: 600000 });
  if (r.code !== 0 || !fs.existsSync(pj)) {
    throw new Error(`candidate install failed (exit ${r.code}${r.error ? `, ${r.error}` : ''}): ${r.stderr.split('\n').filter(Boolean).slice(-3).join(' | ') || r.error || 'no output'}`);
  }
  const installed = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
  if (installed !== version) throw new Error(`installed ${installed}, expected ${version}`);
  return path.join(pkgDir, 'lib', 'bin.js');
}

/**
 * Mount @deepseek-ai/dsh-llm-replay at the exact candidate version into the
 * shadow's headless profile, so the write-round stage can complete a turn
 * without any provider credentials. Uses our own candidate binary exclusively.
 *
 * llm-replay ships NO dsh.bundle (it is a test-support library), so the
 * install only lands the dependency in the profile; activation is done by
 * writeReplayPatch() writing insert rows into the profile patch layer.
 */
export function mountReplayPlugin(bin, shadowHome, version, log = () => {}) {
  const r = run(process.execPath, [bin, 'plugin', '--profile', 'headless', 'add', `@deepseek-ai/dsh-llm-replay@${version}`], {
    cwd: shadowHome,
    env: shadowEnv(shadowHome),
    timeoutMs: 300000,
  });
  const ok = r.code === 0;
  log(`llm-replay mount exit ${r.code}${r.code !== 0 ? `: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}` : ''}`);
  return { ok, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Write the shadow headless profile's patch layer: disable the official LLM
 * adapter rows (ids discovered from the live composition dump), optionally
 * suppress every leaf tool row (`tool-*`), and insert the replay row
 * configured as a replay-only adapter for every route observed in the drilled
 * sessions' request/header rows.
 *
 * Patch grammar (from --dump-config-schema): `disabled` lives on entry
 * metadata; NEW rows need the `insert:` key — a bare `- id:` row is treated
 * as a replace of an existing entry and is skipped with
 * `patch: entry "..." not found` when absent.
 *
 * SAFETY (audit P0-1 + round 3): with `suppressToolRows` (default TRUE —
 * library-level fail-open was the round-3 finding), every executor row is
 * disabled before the write round, matched by id OR by package NAME prefix:
 *   id:      ^tool- , ^terminal-
 *   name:    @deepseek-ai/dsh-tool- , -mcp- , -skill , -browser , -terminal , -jobs
 * The id-only match missed rows like skill-filesystem / workflow-ptc whose
 * ids do not start with `tool-`; the name prefixes close that (verified
 * against the real 96-row headless composition). The `tools` REGISTRY row is
 * never disabled — agent-loop depends on ctx.tools; `dsh-tools` is NOT
 * matched by the `dsh-tool-` prefix (hyphen boundary). Session-derived ids
 * and names are JSON.stringify'd (P2-7) so hostile values cannot break YAML.
 */
const TOOL_ROW_NAME_PREFIXES = [
  '@deepseek-ai/dsh-tool-',
  '@deepseek-ai/dsh-mcp-',
  '@deepseek-ai/dsh-skill', // matches dsh-skill, dsh-skill-filesystem, -badge
  '@deepseek-ai/dsh-browser',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-jobs',
];

export function writeReplayPatch(shadowHome, bin, { adapterNamePrefixes, providers, fixturePath, suppressToolRows = true }) {
  const dc = run(process.execPath, [bin, '--profile', 'headless', '--dump-config'], { cwd: shadowHome, env: shadowEnv(shadowHome), timeoutMs: 120000 });
  // Row-pair pass: dump lines are `- id: X` followed by an indented
  // `name: '...'`; name must be evaluated AFTER its id line, hence the
  // two-phase collect-then-decide (the old single-pass missed name-only
  // matches when the decision fired on the id line).
  const rows = [];
  if (dc.stdout) {
    let cur = null;
    for (const line of dc.stdout.split('\n')) {
      const idm = line.match(/^-\s+id:\s*(\S+)/);
      if (idm) {
        cur = { id: idm[1].replace(/^['"]|['"]$/g, ''), name: null };
        rows.push(cur);
        continue;
      }
      if (cur) {
        const nm = line.match(/^\s+name:\s*(\S+)/);
        if (nm) cur.name = nm[1].replace(/^['"]|['"]$/g, '');
      }
    }
  }
  const disableIds = [];
  const suppressedToolIds = [];
  for (const r of rows) {
    if (r.id === 'tools') continue; // registry: agent-loop needs ctx.tools
    if (r.name && adapterNamePrefixes.some((pfx) => r.name.startsWith(pfx))) {
      if (!disableIds.includes(r.id)) disableIds.push(r.id);
      continue;
    }
    if (!suppressToolRows) continue;
    const toolish =
      /^tool-/.test(r.id) ||
      /^terminal-/.test(r.id) ||
      (r.name !== null && TOOL_ROW_NAME_PREFIXES.some((pfx) => r.name.startsWith(pfx)));
    if (toolish && !disableIds.includes(r.id)) {
      disableIds.push(r.id);
      suppressedToolIds.push(r.id);
    }
  }
  const routes = providers
    .map((p) => {
      const models = p.models
        .map((m) => `            - id: ${JSON.stringify(String(m.id))}\n              contextWindow: ${Number(m.contextWindow) || ASSUMED_CONTEXT_WINDOW_TOKENS}`)
        .join('\n');
      return `        - id: ${JSON.stringify(String(p.id))}\n          name: ${JSON.stringify(String(p.name ?? p.id))}\n          models:\n${models}`;
    })
    .join('\n');
  // An empty providers list must be OMITTED (a bare `providers:` renders as
  // null and crashes the plugin at activation); catch-all mode is the
  // documented fallback but our spike showed adapter mode is what intercepts.
  const providersBlock = routes ? ['      providers:', ...routes.split('\n')] : [];
  // fixturePath is OPTIONAL: when omitted, llm-replay falls back to
  // $DSH_SNAPSHOT_FILE, which writeRound sets per session (per-session
  // fixtures cannot be expressed in one static patch file).
  const fileBlock = fixturePath ? [`      file: ${JSON.stringify(fixturePath).replace(/\\\\/g, '/')}`] : [];
  const patch = [
    ...disableIds.map((id) => `- id: ${id}\n  disabled: true`),
    '- insert:',
    '  - id: llm-replay',
    "    name: '@deepseek-ai/dsh-llm-replay'",
    '    config:',
    ...fileBlock,
    ...providersBlock,
  ].join('\n');
  fs.writeFileSync(path.join(shadowHome, 'profiles', 'headless', 'cordis.patch.yml'), patch + '\n');
  return { disableIds, suppressedToolIds, rowInserted: true };
}

/**
 * Opt-in adoption-gate patch (--preset-mode patch): the headless one-shot
 * runner refuses to adopt sessions whose header/log selects an agent preset
 * (`assertAdoptable` in dsh-headless). For preset sessions we neutralize ONLY
 * that adoption-policy check inside our private candidate prefix — session
 * data is never modified, and the preset's composition is NOT reconstructed
 * (format-level verdicts remain valid; composition-level behavior untested).
 */
export function patchAdoptionGate(prefixDir, log = () => {}) {
  const hl = path.join(prefixDir, 'node_modules', '@deepseek-ai', 'dsh-headless', 'lib', 'index.js');
  if (!fs.existsSync(hl)) {
    log('adoption-gate patch skipped: dsh-headless/lib/index.js not found');
    return { ok: false, reason: 'not-found' };
  }
  // The pristine backup is bound to the installed candidate version: a
  // reused --prefix-dir across candidates would otherwise patch candidate B
  // from candidate A's backup. When the installed version cannot be read at
  // all, do NOT guess which backup is valid — refuse the patch (review round
  // 5, P2-4): preset sessions then skip with this reason, and the failure
  // direction stays "no patch" rather than "patched from an unknown base".
  const backup = hl + '.rehearsal-orig';
  let candidateVersion = null;
  try {
    candidateVersion = JSON.parse(fs.readFileSync(path.join(prefixDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version ?? null;
  } catch { /* handled below */ }
  if (!candidateVersion) {
    log('adoption-gate patch skipped: candidate version unknown (cannot bind a pristine backup)');
    return { ok: false, reason: 'candidate-version-unknown' };
  }
  const stampFile = backup + '.candidate';
  let stamp = null;
  try { stamp = fs.readFileSync(stampFile, 'utf8').trim(); } catch { /* no stamp yet */ }
  if (!fs.existsSync(backup) || stamp !== candidateVersion) {
    if (fs.existsSync(backup)) {
      log(`adoption-gate backup re-seeded for candidate ${candidateVersion} (was ${stamp ?? 'unstamped'})`);
    }
    fs.copyFileSync(hl, backup);
    fs.writeFileSync(stampFile, candidateVersion);
  }
  const original = fs.readFileSync(backup, 'utf8');
  const re = /(function currentPreset\([^)]*\)\s*\{)/;
  if (!re.test(original)) {
    log('adoption-gate patch skipped: currentPreset signature not found (host layout changed)');
    return { ok: false, reason: 'signature-changed' };
  }
  fs.writeFileSync(hl, original.replace(re, '$1 return void 0; // dsh-rehearsal adoption-gate patch'));
  log('adoption-gate patched in private prefix (preset sessions adoptable; composition not reconstructed)');
  return { ok: true };
}

/**
 * One cold boot of the shadow headless profile. Verdicts come from artifacts
 * (stderr signatures, files), never from exit codes alone: a successful
 * keyless migration exits 1 with MISSING_CREDENTIAL.
 */
export function headlessRun(bin, shadowHome, args, cwd, timeoutMs = 180000) {
  return run(process.execPath, [bin, '--profile', 'headless', ...args], { cwd, env: shadowEnv(shadowHome), timeoutMs });
}
