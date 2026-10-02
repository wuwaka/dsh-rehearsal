// Read-only discovery over a real DSH_HOME: profiles, layers, installed
// plugins with exact versions, session-library stats. File parsing only —
// this module never spawns dsh and never writes to the scanned home.

import fs from 'node:fs';
import path from 'node:path';
import { countRows, simpleListAfter } from './yaml-lite.js';

export function defaultHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh');
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
 * broken by the candidate. Probes, in order:
 *   1. the profile's node_modules (mirrors the dsh installation closure)
 *   2. the npm global install beside the PATH dsh shim
 * Returns null when undetectable — callers must treat that as "unknown",
 * never as "matches candidate".
 */
export function detectCurrentDshVersion(home, profileName) {
  const candidates = [
    profileName ? path.join(home, 'profiles', profileName, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : null,
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    // Desktop installs carry the runtime inside the app bundle and refuse to
    // let the npm CLI manage their profile — the only way to see their
    // current version is the bundled package.json.
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      : null,
    process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v && semverLike(v)) return v;
    } catch { /* next probe */ }
  }
  return null;
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
