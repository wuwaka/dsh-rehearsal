// Desktop host catalog (桌面宿主探测表): where known dsh desktop hosts install
// their app bundle, and which isolated DSH_HOMEs they are known to keep.
//
// Provenance discipline: every candidate carries `note` —
//   'measured-machine'  verified on a real machine's disk
//   'measured-source'   derived from the host's own source at a pinned commit
//   'inferred'          platform-convention guess, validated before acceptance
// Provenance NEVER affects selection priority (invariant); the catalog's
// array order IS the normative priority (test-locked in docs.test.js's
// sibling, test/desktops.test.js). Baseline upstream commits the paths were
// read at: deepseek-ai/deepseek-harness@5badb15,
// anywhere-labs/dsh-desktop@a1ff68b, dataelement/dsh-desktop@beb6821.
//
// Acceptance rule: an inferred candidate can only ever degrade into "not
// found" — homes must pass looksLikeDshHome() and bundle probes must yield a
// semver version, so a wrong guess never selects the wrong target.
//
// Not catalogued on purpose (home identical to the default AND no readable
// runtime marker): myYangyunfan/dsh_desktop (Tauri, shares ~/.dsh, sidecar
// binary), vibeinging/dsh-desktop (defaults to ~/.dsh, runtime inside its
// own asar). They are covered by the default home and documented in the
// ecosystem table instead of gaining fake-precision probes here.

import path from 'node:path';

export const DESKTOP_HOSTS = [
  {
    id: 'deepseek-harness-desktop',
    label: 'DeepSeek Harness Desktop (official)',
    // The official desktop keeps its data in the default home
    // (profiles/desktop — apps/desktop/src/paths.ts), so there is no
    // isolated home to discover.
    homes: [],
    bundles: [
      // Windows: the whole dsh tree lives INSIDE resources/app.asar at dsh/
      // (apps/desktop/README.md:121,397); desktop-runtime.json carries
      // sharedPackages (an ARRAY — use .find) whose @deepseek-ai/dsh version
      // upstream pins equal to release.version.
      {
        platform: 'win32',
        install: { env: 'LOCALAPPDATA', segs: ['Programs', 'DeepSeek Harness'] },
        container: 'asar', file: 'dsh/desktop-runtime.json', note: 'measured-machine',
      },
      {
        platform: 'win32',
        install: { env: 'LOCALAPPDATA', segs: ['Programs', 'DeepSeek Harness'] },
        container: 'asar', file: 'dsh/node_modules/@deepseek-ai/dsh/package.json', note: 'measured-source',
      },
      {
        platform: 'darwin',
        install: { env: null, segs: ['/Applications/DeepSeek Harness.app/Contents/Resources'] },
        container: 'asar', file: 'dsh/desktop-runtime.json', note: 'inferred',
      },
      {
        platform: 'darwin',
        install: { env: 'HOME', segs: ['Applications', 'DeepSeek Harness.app', 'Contents', 'Resources'] },
        container: 'asar', file: 'dsh/desktop-runtime.json', note: 'inferred',
      },
      // Linux target is an AppImage (squashfs) — not readable externally,
      // deliberately uncatalogued and declared unsupported.
    ],
  },
  {
    id: 'dsh-desktop-anywhere-labs',
    label: 'DSH Desktop (AnywhereLab community)',
    homes: [
      // Beta channel only: stable OWNS ~/.dsh (product-identity.ts
      // homeDirectoryName '.dsh'), which the default home already covers.
      // win32 resolves via USERPROFILE ONLY — upstream desktopChannelHome
      // uses os.homedir(), which is USERPROFILE there; a HOME-based win32
      // candidate would fabricate candidates under Git Bash.
      { platform: 'win32', env: 'USERPROFILE', segs: ['.dsh-beta'], note: 'measured-source' },
      { platform: 'darwin', env: 'HOME', segs: ['.dsh-beta'], note: 'measured-source' },
      { platform: 'linux', env: 'HOME', segs: ['.dsh-beta'], note: 'measured-source' },
    ],
    bundles: [
      {
        platform: 'win32',
        install: { env: 'LOCALAPPDATA', segs: ['Programs', 'DSH Desktop'] },
        container: 'plain',
        file: ['resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'],
        note: 'measured-machine',
      },
      {
        platform: 'win32',
        install: { env: 'LOCALAPPDATA', segs: ['Programs', 'DSH Desktop Beta'] },
        container: 'plain',
        file: ['resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'],
        note: 'inferred',
      },
      {
        platform: 'darwin',
        install: { env: null, segs: ['/Applications/DSH Desktop.app/Contents/Resources'] },
        container: 'plain',
        file: ['app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'],
        note: 'inferred',
      },
      {
        platform: 'darwin',
        install: { env: 'HOME', segs: ['Applications', 'DSH Desktop.app', 'Contents', 'Resources'] },
        container: 'plain',
        file: ['app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'],
        note: 'inferred',
      },
    ],
  },
  {
    id: 'dshdesktop-dataelement',
    label: 'DSHDesktop (dataelement community)',
    homes: [
    // The only ISOLATED home in the catalog: userData is explicitly
    // redirected to appData/dsh-desktop (src/main/index.ts:519,524) and the
    // harness home is {userData}/harness. Their own code reads
    // profiles/<p>/package.json (host-plugin-state.ts:35 and others), which
    // is what looksLikeDshHome checks. appData is platform-dependent:
    // %APPDATA% on Windows, ~/Library/Application Support on macOS,
    // $XDG_CONFIG_HOME or ~/.config on Linux — the same setPath line on all
    // three platforms.
    { platform: 'win32', env: 'APPDATA', segs: ['dsh-desktop', 'harness'], note: 'measured-source' },
    { platform: 'darwin', env: 'HOME', segs: ['Library', 'Application Support', 'dsh-desktop', 'harness'], note: 'measured-source' },
    { platform: 'linux', env: 'XDG_CONFIG_HOME', segs: ['dsh-desktop', 'harness'], note: 'measured-source' },
    { platform: 'linux', env: 'HOME', segs: ['.config', 'dsh-desktop', 'harness'], note: 'measured-source' },
    ],
    // Harness runs under Electron's Node mode (electron-node-executable.ts:
    // "no longer ships a standalone Node"); no externally readable version
    // marker — left empty, current falls back to the profile/npm probes.
    bundles: [],
  },
];

/** Stable identity of a resolved path (win32 case-insensitive) for dedupe. */
export function pathKey(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function resolveCandidate(cand) {
  if (cand.platform && cand.platform !== process.platform) return null;
  const base = cand.env ? process.env[cand.env] : null;
  if (cand.env && !base) return null;
  return cand.env ? path.join(base, ...cand.segs) : path.join(...cand.segs);
}

/** Resolved home candidates for one host, in catalog order, path-deduped. */
export function homeCandidates(host) {
  const seen = new Set();
  const out = [];
  for (const h of host.homes ?? []) {
    const p = resolveCandidate(h);
    if (p === null) continue;
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hostId: host.id, home: p, note: h.note });
  }
  return out;
}

/** Resolved bundle probes for one host, in catalog order. */
export function bundleProbes(host) {
  const out = [];
  for (const b of host.bundles ?? []) {
    const root = resolveCandidate(b.install);
    if (root === null) continue;
    out.push({ hostId: host.id, installRoot: root, container: b.container, file: b.file, note: b.note });
  }
  return out;
}

/** All validated home candidates across the catalog, normative order. */
export function allHomeCandidates() {
  const seen = new Set();
  const out = [];
  for (const host of DESKTOP_HOSTS) {
    for (const c of homeCandidates(host)) {
      const key = pathKey(c.home);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
