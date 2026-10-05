// Read-only discovery over a real DSH_HOME: profiles, layers, installed
// plugins with exact versions, session-library stats. File parsing only —
// this module never spawns dsh and never writes to the scanned home.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { countRows, simpleListAfter } from './yaml-lite.js';
import { readAsarFile } from './asar.js';
import { allHomeCandidates, bundleProbes, DESKTOP_HOSTS, pathKey } from './desktops.js';
import { GEN_RE } from './sessions.js';

/**
 * Never throws. With neither USERPROFILE nor HOME set (a bare container), the
 * old expression reached path.join(undefined, '.dsh') and the CLI died with
 * Node's "path argument must be of type string" instead of a usable answer.
 * DSH_HOME semantics mirror upstream resolveDshHome: blank means unset, `~`
 * expands against the same base.
 */
export function defaultHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim()) return path.resolve(expandTilde(env.trim()));
  const base = process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
  return path.join(base, '.dsh');
}

/** Report label for target.homeOrigin — a static slug, never a path. */
export const DESKTOP_ORIGIN_PREFIX = 'desktop:';

function homeBase() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/** Expand `~` / `~\` / `~/` prefixes (upstream expandHomePath parity). */
function expandTilde(p) {
  if (p === '~') return homeBase();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeBase(), p.slice(2));
  return p;
}

/**
 * Structural check for "this directory is a DSH_HOME" — the acceptance gate
 * for catalog-discovered homes, so an inferred path can only ever degrade
 * into "not found", never into rehearsing the wrong target. A home counts
 * when it holds REAL harness data:
 *   - a profile whose manifest carries the harness `dsh` field (what the
 *     harness writes into profiles/<name>/package.json; a random sibling
 *     project named profiles/foo/package.json does not qualify), or
 *   - a session generation file under sessions/<ws>/<id>/ (bare directories
 *     do not qualify).
 */
export function looksLikeDshHome(dir) {
  try {
    const profilesDir = path.join(dir, 'profiles');
    if (fs.existsSync(profilesDir)) {
      for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(profilesDir, e.name, 'package.json'), 'utf8'));
          if (pkg && typeof pkg === 'object' && pkg.dsh && typeof pkg.dsh === 'object') return true;
        } catch { /* no or unreadable manifest: keep looking */ }
      }
    }
    const sessionsDir = path.join(dir, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      for (const ws of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!ws.isDirectory()) continue;
        let sessions;
        try { sessions = fs.readdirSync(path.join(sessionsDir, ws.name), { withFileTypes: true }); } catch { continue; }
        for (const s of sessions) {
          if (!s.isDirectory()) continue;
          let files;
          try { files = fs.readdirSync(path.join(sessionsDir, ws.name, s.name)); } catch { continue; }
          if (files.some((f) => GEN_RE.test(f))) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve the DSH_HOME `check`/`run` operate on. Precedence:
 *   1. explicit --home flag          → origin 'flag'
 *   2. DSH_HOME env (blank = unset)  → origin 'env'
 *   3. default home (~/.dsh) IF it validates as a real home → origin 'default'
 *   4. host-catalog homes (catalog order = priority, validated) → origin
 *      `desktop:<id>`; multiple valid candidates surface as `alternates`
 *   5. fallback: the default home path (downstream reports "no usable
 *      profile" honestly, unchanged from before)
 * A non-string --home (bare `--home` from parseArgs) and an explicitly
 * blank --home both fail with a readable error instead of a path.join
 * TypeError or a silent fall-through to auto-discovery. Selection itself
 * never auto-picks between several desktop homes: `run` gates on that (see
 * desktopAmbiguityGate), `check` takes the first with a warning.
 */
export function resolveHome(explicitHome) {
  if (explicitHome !== undefined && explicitHome !== null && typeof explicitHome !== 'string') {
    throw new Error(`--home must be a path string, got ${typeof explicitHome}`);
  }
  if (typeof explicitHome === 'string') {
    const trimmed = explicitHome.trim();
    // An explicit-but-blank --home is a mistake, not "unset": silently
    // falling through would run the rehearsal against an auto-discovered
    // home while the user believes they chose one.
    if (!trimmed) throw new Error('--home must not be empty');
    return { home: path.resolve(expandTilde(trimmed)), origin: 'flag', alternates: [], desktopCandidates: 0 };
  }
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim()) {
    return { home: path.resolve(expandTilde(env.trim())), origin: 'env', alternates: [], desktopCandidates: 0 };
  }
  const def = defaultHome();
  const seen = new Set([pathKey(def)]);
  const desktop = [];
  for (const c of allHomeCandidates()) {
    if (!looksLikeDshHome(c.home)) continue;
    const key = pathKey(c.home);
    if (seen.has(key)) continue;
    seen.add(key);
    desktop.push({ origin: DESKTOP_ORIGIN_PREFIX + c.hostId, home: c.home });
  }
  if (fs.existsSync(def) && looksLikeDshHome(def)) {
    return {
      home: def,
      origin: 'default',
      alternates: desktop.map((d) => d.origin),
      desktopCandidates: desktop.length,
    };
  }
  if (desktop.length) {
    const [first, ...rest] = desktop;
    return { home: first.home, origin: first.origin, alternates: rest.map((d) => d.origin), desktopCandidates: desktop.length };
  }
  return { home: def, origin: 'default', alternates: [], desktopCandidates: 0 };
}

export function listProfiles(home) {
  const dir = path.join(home, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    // profiles/node_modules is pnpm's symlink farm, not a profile (audit
    // P2-4); dot-dirs are scratch/lock artifacts.
    .filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/**
 * Best-effort detection of the CURRENTLY RUNNING dsh runtime version
 * (audit P2-1): needed to classify peer findings as pre-existing vs newly
 * broken by the candidate. Probe chain:
 *   1. the profile's node_modules (mirrors the dsh installation closure)
 *   2. profiles/node_modules beside the profiles (pnpm's shared closure)
 *   3. desktop bundles from the host catalog — a `desktop:<id>` home origin
 *      only trusts its own host; other origins probe all hosts
 *   4. the npm prefix, but ONLY when `npm_config_prefix` is present in the
 *      environment (npm sets it while running scripts). A plain global
 *      install outside npm does not set it and is not discovered — pass
 *      `--current` in that case.
 * Returns null when undetectable — callers must treat that as "unknown",
 * never as "matches candidate". Callers wanting provenance and the
 * multi-host conflict verdict use runtimeEvidence() instead.
 */
export function detectCurrentDshVersion(home, profileName, origin) {
  return runtimeEvidence(home, profileName, origin).version;
}

/**
 * Same probe chain as detectCurrentDshVersion with provenance: every hit
 * carries { host, version, source }, and markers that exist but fail
 * validation are listed in `untrusted` instead of being silently dropped.
 * When desktop hosts DISAGREE on their bundled runtime (two hosts installed,
 * one shared home — including hosts installed but never launched), "current"
 * is genuinely unknowable: version is null and `ambiguous` lists the
 * contenders — peers.js then classifies excluded-candidate plugins as high,
 * and the report states that consequence explicitly.
 */
export function runtimeEvidence(home, profileName, origin) {
  const sources = [];
  const untrusted = [];
  const push = (host, version, source) => { if (version) sources.push({ host, version, source }); };

  const pkgCandidates = [
    profileName ? path.join(home, 'profiles', profileName, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : null,
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ].filter(Boolean);
  for (const p of pkgCandidates) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v && semverLike(v)) {
        // tier 1 is AUTHORITATIVE for the home: the profile's own closure is
        // the runtime that wrote these sessions, so a machine-level desktop
        // bundle never competes with it (old first-hit behavior preserved)
        return { version: v, sources: [{ host: 'profile-node_modules', version: v, source: 'profile-node_modules' }], ambiguous: null, untrusted: [] };
      }
    } catch { /* next probe */ }
  }

  const scopedId = typeof origin === 'string' && origin.startsWith(DESKTOP_ORIGIN_PREFIX)
    ? origin.slice(DESKTOP_ORIGIN_PREFIX.length)
    : null;
  // Group probes by (host, installRoot) so the package.json fallback applies
  // per INSTALL LOCATION, and only when that location's descriptor is
  // ABSENT: a descriptor that exists but fails validation (schema drift,
  // version mismatch) is untrusted, and falling back would bypass the
  // integrity cross-check the descriptor exists for.
  const groups = [];
  const groupIndex = new Map();
  for (const host of DESKTOP_HOSTS) {
    if (scopedId && host.id !== scopedId) continue;
    for (const probe of bundleProbes(host)) {
      const key = `${probe.hostId}\u0000${probe.installRoot}`;
      let g = groupIndex.get(key);
      if (!g) { g = { hostId: probe.hostId, probes: [] }; groupIndex.set(key, g); groups.push(g); }
      g.probes.push(probe);
    }
  }
  for (const g of groups) {
    const descriptor = g.probes.find((p) => p.kind === 'descriptor');
    const pkg = g.probes.find((p) => p.kind === 'package');
    const record = (r) => {
      if (r.status === 'hit') push(g.hostId, r.version, r.source);
      else if (r.status === 'untrusted') untrusted.push({ host: g.hostId, source: r.source ?? (descriptor ? 'desktop-runtime.json' : 'package.json') });
    };
    if (descriptor) {
      const r = readDesktopBundleVersion(descriptor);
      if (r.status === 'hit' || r.status === 'untrusted') record(r);
      else if (pkg) record(readDesktopBundleVersion(pkg)); // descriptor absent → fallback
    } else if (pkg) {
      record(readDesktopBundleVersion(pkg));
    }
  }
  if (sources.length) {
    const versions = new Set(sources.map((s) => s.version));
    if (versions.size === 1) return { version: sources[0].version, sources, ambiguous: null, untrusted };
    return { version: null, sources, ambiguous: sources.map((s) => ({ host: s.host, version: s.version })), untrusted };
  }

  // npm prefix is a FALLBACK only, and only when npm_config_prefix is
  // present (npm sets it for its own child processes): the probe reads that
  // variable rather than discovering a global install on its own.
  if (process.env.npm_config_prefix) {
    try {
      const v = JSON.parse(
        fs.readFileSync(path.join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
      ).version;
      if (v && semverLike(v)) push('npm-prefix', v, 'npm-prefix');
    } catch { /* absent */ }
  }
  if (!sources.length) return { version: null, sources, ambiguous: null, untrusted };
  return { version: sources[0].version, sources, ambiguous: null, untrusted };
}

/**
 * Read one catalog bundle probe. Returns
 *   { status: 'hit', version, source } — a usable runtime version
 *   { status: 'miss' }                 — the marker file is not there
 *   { status: 'untrusted' }            — the marker exists but fails validation
 * asar descriptor probes parse desktop-runtime.json (schemaVersion 1;
 * `sharedPackages` is an ARRAY — use find; upstream pins the @deepseek-ai/dsh
 * version equal to release.version, so a mismatch is untrusted, never
 * fallback-worthy). asar/plain package probes parse a package.json version.
 * The `archive` segments locate app.asar relative to installRoot — the win32
 * layout is <root>\resources\app.asar while macOS installs keep the archive
 * directly at <root>/app.asar under .../Contents/Resources.
 */
function readDesktopBundleVersion(probe) {
  try {
    if (probe.container === 'asar') {
      const raw = readAsarFile(path.join(probe.installRoot, ...(probe.archive ?? ['resources', 'app.asar'])), probe.file);
      if (!raw) return { status: 'miss' };
      let j;
      try { j = JSON.parse(raw.toString('utf8')); } catch { return { status: 'untrusted' }; }
      const source = probe.kind === 'package' ? 'package.json' : 'desktop-runtime.json';
      if (probe.kind === 'package') {
        const v = j && typeof j === 'object' ? j.version : null;
        return isValidVersion(v) ? { status: 'hit', version: v, source } : { status: 'untrusted' };
      }
      if (!j || j.schemaVersion !== 1 || !Array.isArray(j.sharedPackages)) return { status: 'untrusted' };
      const entry = j.sharedPackages.find((e) => e && e.name === '@deepseek-ai/dsh');
      const v = entry && typeof entry.version === 'string' ? entry.version : null;
      if (!isValidVersion(v) || j.release?.version !== v) return { status: 'untrusted' };
      return { status: 'hit', version: v, source };
    }
    const pjPath = path.join(probe.installRoot, ...(Array.isArray(probe.file) ? probe.file : [probe.file]));
    let v;
    try {
      v = JSON.parse(fs.readFileSync(pjPath, 'utf8')).version;
    } catch (e) {
      return e?.code === 'ENOENT' ? { status: 'miss' } : { status: 'untrusted' };
    }
    return isValidVersion(v) ? { status: 'hit', version: v, source: 'package.json' } : { status: 'untrusted' };
  } catch {
    return { status: 'untrusted' };
  }
}

function isValidVersion(v) {
  return typeof v === 'string' && semver.valid(v) !== null;
}

function semverLike(v) {
  return isValidVersion(v);
}

/**
 * Heuristic for "which profile is the live one" — never assume `web`.
 * Reviews (2026-10-02) measured desktop=11 bundles/198 patch lines vs web=4/4;
 * ranking by bundles, then patch lines, then newest mtime picked the real one.
 */
export function inspectProfile(home, name) {
  const dir = path.join(home, 'profiles', name);
  const out = { name, dir, exists: fs.existsSync(dir), bundles: [], patchLayers: {}, plugins: [], stats: {} };
  if (!out.exists) return out;

  // Profile manifest: package.json -> dsh.profile.bundles + dependencies.
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      out.manifest = {
        bundles: pkg?.dsh?.profile?.bundles ?? [],
        dependencies: pkg?.dependencies ?? {},
      };
      out.bundles = out.manifest.bundles;
    } catch (e) {
      out.errors = [{ file: 'package.json', error: String(e.message) }];
    }
  }

  // Patch layers: profile-level cordis.patch.yml, plus the home-level layer
  // that the reviews found missing from naive inventories.
  const profilePatch = path.join(dir, 'cordis.patch.yml');
  if (fs.existsSync(profilePatch)) out.patchLayers.profile = countRows(fs.readFileSync(profilePatch, 'utf8'));
  const homePatch = path.join(home, 'cordis.patch.yml');
  if (fs.existsSync(homePatch)) out.patchLayers.home = countRows(fs.readFileSync(homePatch, 'utf8'));

  // Exact installed versions come from the profile's own node_modules (or the
  // pnpm lock as a fallback). link:/file:/github: deps are flagged: reviews
  // found 3/7 desktop deps are not reproducible in a shadow.
  const nm = path.join(dir, 'node_modules');
  for (const dep of Object.keys(out.manifest?.dependencies ?? {})) {
    const entry = { name: dep, version: null, source: out.manifest.dependencies[dep], reproducible: true };
    if (typeof entry.source === 'string' && /^(link:|file:|github:|git\+|https?:)/.test(entry.source)) {
      entry.reproducible = false;
    }
    const pj = path.join(nm, ...dep.split('/'), 'package.json');
    if (fs.existsSync(pj)) {
      try {
        entry.version = JSON.parse(fs.readFileSync(pj, 'utf8')).version ?? null;
      } catch {
        entry.version = null;
      }
    }
    out.plugins.push(entry);
  }

  // pnpm-workspace.yaml flags that change shadow semantics.
  const ws = path.join(dir, 'pnpm-workspace.yaml');
  if (fs.existsSync(ws)) {
    const text = fs.readFileSync(ws, 'utf8');
    out.workspace = {
      hasAllowBuilds: /allowBuilds\s*:/.test(text),
      hasMinimumReleaseAge: /minimumReleaseAge/i.test(text),
      minimumReleaseAgeExclude: simpleListAfter(text, 'minimumReleaseAgeExclude'),
    };
  }

  // Live-profile stats.
  const mtimes = [];
  for (const f of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) mtimes.push(fs.statSync(p).mtimeMs);
  }
  out.stats = {
    bundleCount: out.bundles.length,
    patchRowCount: Object.values(out.patchLayers).reduce((a, b) => a + b, 0),
    pluginCount: out.plugins.length,
    newestMtimeMs: mtimes.length ? Math.max(...mtimes) : 0,
  };
  return out;
}

export function pickLiveProfile(profiles) {
  const ranked = [...profiles].sort(
    (a, b) =>
      b.stats.bundleCount - a.stats.bundleCount ||
      b.stats.patchRowCount - a.stats.patchRowCount ||
      b.stats.newestMtimeMs - a.stats.newestMtimeMs,
  );
  return ranked[0] ?? null;
}

export function readSettingsShape(home) {
  const settingsYaml = path.join(home, 'settings.yaml');
  const imported = path.join(home, 'settings.yaml.imported');
  // Reviews: some machines have no active settings.yaml, only settings.yaml.imported.
  if (fs.existsSync(settingsYaml)) return { kind: 'settings.yaml', path: settingsYaml };
  if (fs.existsSync(imported)) return { kind: 'settings.yaml.imported', path: imported };
  return { kind: 'none', path: null };
}

/** Marketplace-held compatibility FACTS (no verdicts) if the dsh-market cache exists. */
export function readMarketFacts(home, profileName) {
  const p = path.join(home, 'profiles', profileName, '.dsh-market', 'discovery-compatibility-v1.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { schema: j.schema, count: Object.keys(j.entries ?? {}).length, path: p };
  } catch {
    return null;
  }
}
