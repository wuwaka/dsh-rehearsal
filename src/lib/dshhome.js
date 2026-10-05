// Read-only discovery over a real DSH_HOME: profiles, layers, installed
// plugins with exact versions, session-library stats. File parsing only —
// this module never spawns dsh and never writes to the scanned home.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
 * when it holds REAL harness data: a profile with its package.json manifest,
 * or a session generation file under sessions/<ws>/<id>/ (bare directories
 * do not qualify).
 */
export function looksLikeDshHome(dir) {
  try {
    const profilesDir = path.join(dir, 'profiles');
    if (fs.existsSync(profilesDir)) {
      for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
        if (fs.existsSync(path.join(profilesDir, e.name, 'package.json'))) return true;
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
 * A non-string --home (bare `--home` from parseArgs) fails with a readable
 * error instead of a path.join TypeError. Selection itself never auto-picks
 * between several desktop homes: `run` gates on that (see
 * desktopAmbiguityGate), `check` takes the first with a warning.
 */
export function resolveHome(explicitHome) {
  if (explicitHome !== undefined && explicitHome !== null && typeof explicitHome !== 'string') {
    throw new Error(`--home must be a path string, got ${typeof explicitHome}`);
  }
  if (typeof explicitHome === 'string' && explicitHome.trim()) {
    return { home: path.resolve(expandTilde(explicitHome.trim())), origin: 'flag', alternates: [], desktopCandidates: 0 };
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
 *   2. the npm-global-style profiles/node_modules beside the profiles
 *   3. desktop bundles from the host catalog — a `desktop:<id>` home origin
 *      only trusts its own host; other origins probe all hosts
 *   4. the npm global install beside the PATH dsh shim
 * Returns null when undetectable — callers must treat that as "unknown",
 * never as "matches candidate". Callers wanting provenance and the
 * multi-host conflict verdict use runtimeEvidence() instead.
 */
export function detectCurrentDshVersion(home, profileName, origin) {
  return runtimeEvidence(home, profileName, origin).version;
}

/**
 * Same probe chain as detectCurrentDshVersion with provenance: every hit
 * carries { host, version, source }. When desktop hosts DISAGREE on their
 * bundled runtime (two hosts installed, one shared home), "current" is
 * genuinely unknowable: version is null and `ambiguous` lists the
 * contenders — peers.js then classifies excluded-candidate plugins as high,
 * and the report states that consequence explicitly.
 */
export function runtimeEvidence(home, profileName, origin) {
  const sources = [];
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
        return { version: v, sources: [{ host: 'profile-node_modules', version: v, source: 'profile-node_modules' }], ambiguous: null };
      }
    } catch { /* next probe */ }
  }

  const scopedId = typeof origin === 'string' && origin.startsWith(DESKTOP_ORIGIN_PREFIX)
    ? origin.slice(DESKTOP_ORIGIN_PREFIX.length)
    : null;
  for (const host of DESKTOP_HOSTS) {
    if (scopedId && host.id !== scopedId) continue;
    for (const probe of bundleProbes(host)) {
      const v = readDesktopBundleVersion(probe);
      if (v) push(host.id, v, probe.container === 'asar' ? 'desktop-runtime.json' : 'package.json');
    }
  }
  if (sources.length) {
    const versions = new Set(sources.map((s) => s.version));
    if (versions.size === 1) return { version: sources[0].version, sources, ambiguous: null };
    return { version: null, sources, ambiguous: sources.map((s) => ({ host: s.host, version: s.version })) };
  }

  // npm prefix is a FALLBACK only: the old first-hit chain never let the
  // PATH shim's version compete with profile/desktop evidence, and under
  // `npm test` the injected npm_config_prefix makes this probe hit a real
  // global dsh that may predate the profile's runtime — a fallback keeps
  // that from manufacturing false ambiguity.
  if (!sources.length && process.env.npm_config_prefix) {
    try {
      const v = JSON.parse(
        fs.readFileSync(path.join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
      ).version;
      if (v && semverLike(v)) push('npm-prefix', v, 'npm-prefix');
    } catch { /* absent */ }
  }

  if (!sources.length) return { version: null, sources, ambiguous: null };
  const versions = new Set(sources.map((s) => s.version));
  if (versions.size === 1) return { version: sources[0].version, sources, ambiguous: null };
  return { version: null, sources, ambiguous: sources.map((s) => ({ host: s.host, version: s.version })) };
}

/**
 * Version from one catalog bundle probe. asar containers read the official
 * desktop-runtime.json (schemaVersion 1; sharedPackages is an ARRAY — use
 * find; upstream pins @deepseek-ai/dsh's version equal to release.version,
 * so a mismatch means a descriptor we do not know how to trust → null).
 * plain containers read a package.json version. Anything else → null.
 */
function readDesktopBundleVersion(probe) {
  try {
    if (probe.container === 'asar') {
      const raw = readAsarFile(path.join(probe.installRoot, 'resources', 'app.asar'), probe.file);
      if (!raw) return null;
      const j = JSON.parse(raw.toString('utf8'));
      if (!j || j.schemaVersion !== 1 || !Array.isArray(j.sharedPackages)) return null;
      const entry = j.sharedPackages.find((e) => e && e.name === '@deepseek-ai/dsh');
      const v = entry && typeof entry.version === 'string' ? entry.version : null;
      if (!v || !semverLike(v) || j.release?.version !== v) return null;
      return v;
    }
    const pjPath = path.join(probe.installRoot, ...(Array.isArray(probe.file) ? probe.file : [probe.file]));
    const v = JSON.parse(fs.readFileSync(pjPath, 'utf8')).version;
    return typeof v === 'string' && semverLike(v) ? v : null;
  } catch {
    return null;
  }
}

function semverLike(v) {
  return /^\d+\.\d+\.\d+/.test(String(v));
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
