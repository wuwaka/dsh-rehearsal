// Desktop-host compatibility: the host catalog, home discovery and
// validation, version probes (asar + plain), desktop scoping, and the run
// authorization gate. Offline: no dsh spawn, no npm installs — the run gate
// fires at the boundary before any network work, and the asar fixture is a
// REAL @electron/asar archive (hand-built buffers only for negative paths,
// where "wrong builder" can only make the test stricter, not weaker).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DESKTOP_HOSTS, homeCandidates, bundleProbes } from '../src/lib/desktops.js';
import { looksLikeDshHome, resolveHome, runtimeEvidence } from '../src/lib/dshhome.js';
import { readAsarFile } from '../src/lib/asar.js';
import { homeShape } from '../src/lib/report.js';
import { cmdCheck } from '../src/commands/check.js';
import { cmdRun, desktopAmbiguityGate, desktopDataContext } from '../src/commands/run.js';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');
const FIXTURE_ASAR = path.join(import.meta.dirname, 'fixtures', 'official-desktop.asar');
const FIXTURE_ASAR_NODESC = path.join(import.meta.dirname, 'fixtures', 'official-desktop-nodescriptor.asar');
const ENV_KEYS = ['HOME', 'USERPROFILE', 'DSH_HOME', 'LOCALAPPDATA', 'APPDATA', 'npm_config_prefix', 'XDG_CONFIG_HOME'];

/**
 * Run fn with process.platform and selected env vars overridden, restoring
 * both afterwards. process.platform is a non-writable but CONFIGURABLE
 * property, so defineProperty is the only override route — this is what
 * makes the darwin/linux probe layouts testable off-platform (the v0.3.0
 * macOS path bug shipped precisely because nothing exercised darwin).
 */
async function withPlatform(platform, env, fn) {
  const savedPlatform = process.platform;
  const savedEnv = {};
  Object.defineProperty(process, 'platform', { value: platform });
  for (const [k, v] of Object.entries(env)) {
    savedEnv[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: savedPlatform });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/** Point HOME/USERPROFILE at a fresh fixture dir and wipe discovery-relevant env. */
function envSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'dsh-rehearsal-dstest-'));
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeProfile(home, name = 'web') {
  const prof = path.join(home, 'profiles', name);
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    dependencies: {},
  }));
  return prof;
}

function makeBetaHome(homeBase) {
  return makeProfile(path.join(homeBase, '.dsh-beta'));
}

/**
 * Create the dataelement fixture AT the path the catalog actually probes on
 * this platform (APPDATA on win32, HOME on darwin, XDG_CONFIG_HOME/HOME on
 * linux) — a hand-joined path is how the macOS/Linux CI run drifted from the
 * catalog and lost discovery.
 */
function makeDataelementHome() {
  const host = DESKTOP_HOSTS.find((h) => h.id === 'dshdesktop-dataelement');
  const c = homeCandidates(host);
  assert.ok(c.length, 'dataelement must expose a home candidate on this platform');
  return makeProfile(c[0].home);
}

function installOfficial(localAppData, asarBytes) {
  const res = path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar'), asarBytes);
}

function installCommunity(localAppData, version) {
  const nm = path.join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
}

/**
 * Minimal REAL-format asar writer for NEGATIVE-path fixtures only: header
 * pickle framing identical to the official archive (whose positive parsing
 * is covered by the real-tool fixture). A builder bug here can only make a
 * negative assertion vacuous, never let a wrong version through.
 */
function buildMiniAsar(entries) {
  const files = {};
  const blobs = [];
  let offset = 0;
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = files;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] ??= { files: {} }).files;
    node[parts[parts.length - 1]] = e.unpacked
      ? { size: e.data.length, unpacked: true }
      : { size: e.data.length, offset: String(offset) };
    if (!e.unpacked) { blobs.push(e.data); offset += e.data.length; }
  }
  const jsonBuf = Buffer.from(JSON.stringify({ files }));
  const padded = (jsonBuf.length + 3) & ~3;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeUInt32LE(jsonBuf.length, 4);
  jsonBuf.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, ...blobs]);
}

// ---- T1: catalog sanity ----

test('T1 catalog: unique ids, array order is the normative priority (drift lock), official has no homes', () => {
  const ids = DESKTOP_HOSTS.map((h) => h.id);
  assert.deepEqual(ids, ['deepseek-harness-desktop', 'dsh-desktop-anywhere-labs', 'dshdesktop-dataelement']);
  assert.equal(new Set(ids).size, ids.length);
  for (const h of DESKTOP_HOSTS) {
    assert.ok(h.label, `${h.id} needs a label`);
    for (const c of [...(h.homes ?? []), ...(h.bundles ?? [])]) {
      assert.ok(['measured-machine', 'measured-source', 'inferred'].includes(c.note), `${h.id}: provenance note required`);
    }
    for (const b of h.bundles ?? []) {
      assert.ok(['win32', 'darwin', 'linux'].includes(b.platform), `${h.id}: platform must be explicit`);
      assert.ok(['asar', 'plain'].includes(b.container));
      // every probe declares its marker KIND and, for asar, the archive
      // segments (win32: resources/app.asar; darwin: app.asar directly)
      assert.ok(['descriptor', 'package'].includes(b.kind), `${h.id}: kind must be explicit`);
      assert.ok(b.container !== 'asar' || Array.isArray(b.archive), `${h.id}: asar probes declare archive segments`);
    }
  }
  const official = DESKTOP_HOSTS.find((h) => h.id === 'deepseek-harness-desktop');
  assert.deepEqual(official.homes, [], 'official desktop uses the default home — nothing to discover');
});

test('T1 homeCandidates dedupes resolved paths and never emits cross-env duplicates', (t) => {
  const dir = envSandbox(t);
  process.env.APPDATA = dir;
  const synthetic = {
    id: 'synthetic',
    homes: [
      { platform: process.platform, env: 'USERPROFILE', segs: ['.dsh-beta'] },
      { platform: process.platform, env: 'HOME', segs: ['.dsh-beta'] },
      { platform: process.platform, env: 'APPDATA', segs: ['other-home'] },
    ],
  };
  const c = homeCandidates(synthetic);
  assert.equal(c.length, 2, 'same resolved path via two envs collapses to one candidate');
  const host = DESKTOP_HOSTS.find((h) => h.id === 'dsh-desktop-anywhere-labs');
  assert.equal(homeCandidates(host).length, 1, 'exactly one beta-home candidate per platform');
  assert.equal(path.basename(homeCandidates(host)[0].home), '.dsh-beta');
});

// ---- T2: home validation ----

test('T2 looksLikeDshHome requires real harness data, not bare directories', (t) => {
  const dir = envSandbox(t);
  assert.equal(looksLikeDshHome(dir), false, 'empty dir is not a home');
  fs.mkdirSync(path.join(dir, 'profiles', 'node_modules', 'x'), { recursive: true });
  assert.equal(looksLikeDshHome(dir), false, 'profiles/node_modules is not a profile');
  fs.mkdirSync(path.join(dir, 'profiles', 'bare'), { recursive: true });
  assert.equal(looksLikeDshHome(dir), false, 'a profile dir without its package.json manifest does not count');
  // an unrelated project manifest must not qualify — the harness writes the
  // composition structure (`dsh.profile.bundles`) into every real profile
  // manifest, and nothing weaker is accepted (round 5, P2-5)
  fs.mkdirSync(path.join(dir, 'profiles', 'unrelated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profiles', 'unrelated', 'package.json'), JSON.stringify({ name: 'unrelated-project' }));
  assert.equal(looksLikeDshHome(dir), false, 'a manifest without the dsh field is not a harness profile');
  fs.writeFileSync(path.join(dir, 'profiles', 'unrelated', 'package.json'), JSON.stringify({ name: 'some-project', dsh: {} }));
  assert.equal(looksLikeDshHome(dir), false, 'an empty dsh object is not a harness profile');
  fs.writeFileSync(path.join(dir, 'profiles', 'unrelated', 'package.json'), JSON.stringify({ name: 'some-project', dsh: { profile: {} } }));
  assert.equal(looksLikeDshHome(dir), false, 'a dsh object without a bundles array is not a harness profile');
  fs.rmSync(path.join(dir, 'profiles', 'unrelated'), { recursive: true, force: true });
  makeProfile(dir);
  assert.equal(looksLikeDshHome(dir), true, 'profile manifest counts');
  const s = path.join(dir, 'sessions-only');
  fs.mkdirSync(path.join(s, 'sessions', 'ws', 'sid'), { recursive: true });
  assert.equal(looksLikeDshHome(s), false, 'sessions tree without generation files does not count');
  fs.writeFileSync(path.join(s, 'sessions', 'ws', 'sid', 'session.v0.jsonl.zstd'), 'x');
  assert.equal(looksLikeDshHome(s), true, 'a real session generation file counts');
});

// ---- T3/T4: home resolution ----

test('T3 resolveHome: flag and env win, never gated, non-string or blank fails readably', (t) => {
  const dir = envSandbox(t);
  const r1 = resolveHome(path.join(dir, 'explicit-home'));
  assert.equal(r1.origin, 'flag');
  assert.equal(r1.home, path.resolve(path.join(dir, 'explicit-home')));
  assert.equal(r1.alternates.length, 0);
  assert.throws(() => resolveHome(true), /--home must be a path string/, 'bare --home from parseArgs must fail readably');
  assert.throws(() => resolveHome(''), /--home must not be empty/, 'an explicit blank --home is a mistake, not "unset"');
  assert.throws(() => resolveHome('   '), /--home must not be empty/);
  process.env.DSH_HOME = path.join(dir, 'env-home');
  const r2 = resolveHome();
  assert.equal(r2.origin, 'env');
  assert.equal(r2.home, path.resolve(path.join(dir, 'env-home')));
  assert.equal(desktopAmbiguityGate(r2).block, false, 'explicit origins are never gated');
});

test('T4 resolveHome aligns with upstream resolveDshHome: tilde expands, blank env is unset', (t) => {
  const dir = envSandbox(t);
  process.env.DSH_HOME = '~/.dsh-tilde';
  const r = resolveHome();
  assert.equal(r.origin, 'env');
  assert.equal(r.home, path.join(dir, '.dsh-tilde'));
  process.env.DSH_HOME = '   ';
  assert.equal(resolveHome().origin, 'default', 'whitespace-only DSH_HOME is unset');
});

test('T3 resolveHome: a valid default home wins; catalog homes become alternates', (t) => {
  const dir = envSandbox(t);
  process.env.APPDATA = dir;
  makeProfile(path.join(dir, '.dsh'));
  makeDataelementHome();
  const r = resolveHome();
  assert.equal(r.origin, 'default');
  assert.deepEqual(r.alternates, ['desktop:dshdesktop-dataelement']);
  assert.equal(r.desktopCandidates, 1);
  assert.equal(desktopAmbiguityGate(r).block, false, 'existing-user behavior is preserved, selection stays visible');
});

test('T3 resolveHome: an invalid (empty) default home does not shadow catalog discovery', (t) => {
  const dir = envSandbox(t);
  process.env.APPDATA = dir;
  fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
  makeDataelementHome();
  const r = resolveHome();
  assert.equal(r.origin, 'desktop:dshdesktop-dataelement');
  assert.equal(r.desktopCandidates, 1);
  assert.equal(desktopAmbiguityGate(r).block, false, 'single validating desktop home proceeds');
});

test('T3 resolveHome: pure-desktop ambiguity surfaces for run to gate on', (t) => {
  const dir = envSandbox(t);
  process.env.APPDATA = dir;
  makeDataelementHome();
  makeBetaHome(dir);
  const r = resolveHome();
  assert.equal(r.origin, 'desktop:dsh-desktop-anywhere-labs', 'catalog order is the priority');
  assert.deepEqual(r.alternates, ['desktop:dshdesktop-dataelement']);
  assert.equal(r.desktopCandidates, 2);
  const gate = desktopAmbiguityGate(r);
  assert.equal(gate.block, true);
  assert.match(gate.message, /--home/);
  assert.match(gate.message, /dshdesktop-dataelement/, 'the message names the other candidates');
});

test('T3 resolveHome: nothing valid falls back to the default path honestly', (t) => {
  const dir = envSandbox(t);
  const r = resolveHome();
  assert.equal(r.origin, 'default');
  assert.equal(r.home, path.join(dir, '.dsh'));
  assert.equal(fs.existsSync(r.home), false);
});

// ---- T5: asar reader over the REAL-tool fixture ----

test('T5 readAsarFile parses a real @electron/asar archive; A1/A2 hold on real data', () => {
  const desc = JSON.parse(readAsarFile(FIXTURE_ASAR, 'dsh/desktop-runtime.json').toString('utf8'));
  assert.equal(desc.schemaVersion, 1);
  assert.ok(Array.isArray(desc.sharedPackages), 'A1: sharedPackages is an array, not a name-keyed object');
  assert.equal(desc.files.length, 0, 'the inventory was trimmed for the fixture; shape is otherwise verbatim');
  const pkg = JSON.parse(readAsarFile(FIXTURE_ASAR, 'dsh/node_modules/@deepseek-ai/dsh/package.json').toString('utf8'));
  assert.equal(pkg.version, desc.release.version, 'A2 on real data: upstream pins the harness version to release.version');
});

test('T5 unpacked, absent, directory and path-traversal entries are misses', () => {
  assert.equal(readAsarFile(FIXTURE_ASAR, 'dsh/native/binding.node'), null, 'unpacked entry: no cross-container stitching');
  assert.equal(readAsarFile(FIXTURE_ASAR, 'dsh/missing.json'), null);
  assert.equal(readAsarFile(FIXTURE_ASAR, 'dsh'), null, 'a directory entry is not a file');
  assert.equal(readAsarFile(FIXTURE_ASAR, ''), null);
  assert.equal(readAsarFile(FIXTURE_ASAR, '../escape'), null);
  assert.equal(readAsarFile(FIXTURE_ASAR, 'dsh/../desktop-runtime.json'), null);
  assert.equal(readAsarFile(path.join(os.tmpdir(), `no-such-asar-${Date.now()}`), 'x'), null);
});

test('T5 malformed archives are misses, not exceptions (truncated header, broken size pickle)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-asar-neg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = fs.readFileSync(FIXTURE_ASAR);
  const truncated = path.join(dir, 'truncated.asar');
  fs.writeFileSync(truncated, real.slice(0, 100));
  assert.equal(readAsarFile(truncated, 'dsh/desktop-runtime.json'), null);
  const badPickle = path.join(dir, 'badpickle.asar');
  const broken = Buffer.from(real);
  broken.writeUInt32LE(9, 0);
  fs.writeFileSync(badPickle, broken);
  assert.equal(readAsarFile(badPickle, 'dsh/desktop-runtime.json'), null, 'first size-pickle uint32 must be 4');
});

// ---- T6/T7: version probes ----
//
// These fixtures live at the MEASURED win32 install paths, so the probes
// run under a win32 platform override — before the platform gate was fixed,
// CI only "passed" on macOS/Linux because the gate was dead code and every
// platform probed every path. The gate is real now; the override is the
// honest way to exercise the win32 layout off-Windows.

const withWin32 = (localAppData, fn) => withPlatform('win32', { LOCALAPPDATA: localAppData }, fn);

test('T6 official bundle: desktop-runtime.json feeds the version through the catalog', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    installOfficial(dir, fs.readFileSync(FIXTURE_ASAR));
    const e = runtimeEvidence(path.join(dir, 'no-profile-home'), 'web', undefined);
    const hit = e.sources.find((s) => s.host === 'deepseek-harness-desktop');
    assert.ok(hit, 'official bundle detected');
    assert.equal(hit.version, '0.2.0-rc.2');
    assert.equal(hit.source, 'desktop-runtime.json');
    assert.equal(e.version, '0.2.0-rc.2');
    assert.equal(e.ambiguous, null);
  });
});

test('T6 anywhere-labs plain bundle path (the old hardcoded probe, now catalogued and labelled)', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    installCommunity(dir, '0.2.0-rc.2');
    const e = runtimeEvidence(path.join(dir, 'h'), 'web', undefined);
    const hit = e.sources.find((s) => s.host === 'dsh-desktop-anywhere-labs');
    assert.equal(hit?.version, '0.2.0-rc.2');
    assert.equal(hit?.source, 'package.json');
  });
});

test('T6 non-semver versions are never reported as a runtime version', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    installCommunity(dir, 'nightly-build');
    assert.equal(runtimeEvidence(path.join(dir, 'h'), 'web', undefined).version, null);
  });
});

test('T6 descriptor integrity: object-shaped sharedPackages and schema drift are misses (A1/A2)', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    const objShaped = buildMiniAsar([{
      path: 'dsh/desktop-runtime.json',
      data: Buffer.from(JSON.stringify({
        schemaVersion: 1,
        release: { version: '1.0.0' },
        sharedPackages: { '@deepseek-ai/dsh': { name: '@deepseek-ai/dsh', version: '1.0.0' } },
      })),
    }]);
    installOfficial(dir, objShaped);
    assert.equal(runtimeEvidence(path.join(dir, 'h'), 'web', undefined).version, null, 'object-shaped descriptor must never yield a version');
    installOfficial(dir, buildMiniAsar([{
      path: 'dsh/desktop-runtime.json',
      data: Buffer.from(JSON.stringify({ schemaVersion: 2, release: { version: '1.0.0' }, sharedPackages: [] })),
    }]));
    assert.equal(runtimeEvidence(path.join(dir, 'h'), 'web', undefined).version, null, 'schemaVersion != 1 is not trusted');
  });
});

test('T7 a desktop:<id> origin only trusts its own host bundles', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    installOfficial(dir, fs.readFileSync(FIXTURE_ASAR));
    const e = runtimeEvidence(path.join(dir, 'h'), 'web', 'desktop:dshdesktop-dataelement');
    assert.equal(e.version, null, 'dataelement owns no probes; the machine-level official bundle must be ignored');
    assert.equal(e.sources.length, 0);
    const e2 = runtimeEvidence(path.join(dir, 'h'), 'web', 'desktop:deepseek-harness-desktop');
    assert.equal(e2.version, '0.2.0-rc.2', 'the scoped host itself is probed');
  });
});

test('T7 two hosts with the SAME bundled version resolve with full provenance', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    installOfficial(dir, fs.readFileSync(FIXTURE_ASAR));
    installCommunity(dir, '0.2.0-rc.2');
    const e = runtimeEvidence(path.join(dir, 'h'), 'web', undefined);
    assert.equal(e.version, '0.2.0-rc.2');
    assert.equal(e.ambiguous, null);
    assert.ok(e.sources.length >= 2, 'provenance keeps every hit');
  });
});

test('T7 two hosts with CONFLICTING versions: null + currentAmbiguous, never a silent pick', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    installOfficial(dir, fs.readFileSync(FIXTURE_ASAR));
    installCommunity(dir, '0.1.1-rc.2');
    const e = runtimeEvidence(path.join(dir, 'h'), 'web', undefined);
    assert.equal(e.version, null);
    assert.deepEqual(e.ambiguous.map((a) => a.host).sort(), ['deepseek-harness-desktop', 'dsh-desktop-anywhere-labs']);
    assert.deepEqual(e.ambiguous.map((a) => a.version).sort(), ['0.1.1-rc.2', '0.2.0-rc.2']);
  });
});

test('T7 a profile-scoped install outranks desktop bundles (P2-1 parity, tier-1 authority)', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    installCommunity(dir, '0.2.0-rc.2');
    const home = path.join(dir, 'home');
    const nm = path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const e = runtimeEvidence(home, 'web', undefined);
    assert.equal(e.version, '9.9.9', 'the profile closure is authoritative — machine bundles never compete');
    assert.deepEqual(e.sources, [{ host: 'profile-node_modules', version: '9.9.9', source: 'profile-node_modules' }]);
  });
});

test('T7 the npm prefix is a fallback, never a competitor', async (t) => {
  const dir = envSandbox(t);
  await withPlatform('win32', { LOCALAPPDATA: dir, npm_config_prefix: dir }, async () => {
    const nm = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ version: '0.1.1-rc.2' }));
    assert.equal(runtimeEvidence(path.join(dir, 'h'), 'web', undefined).version, '0.1.1-rc.2', 'used when nothing else hits');
    installCommunity(dir, '0.2.0-rc.2');
    const e = runtimeEvidence(path.join(dir, 'h'), 'web', undefined);
    assert.equal(e.version, '0.2.0-rc.2', 'a desktop hit outranks the prefix shim');
    assert.ok(!e.sources.some((s) => s.host === 'npm-prefix'), 'the shim version must not manufacture ambiguity');
  });
});

test('T7 the platform gate filters probes: a darwin override must not leak win32 roots (regression)', async (t) => {
  const dir = envSandbox(t);
  const sentinel = path.join(dir, 'localappdata-sentinel');
  await withPlatform('darwin', { HOME: dir, LOCALAPPDATA: sentinel, USERPROFILE: dir, APPDATA: null }, async () => {
    const official = DESKTOP_HOSTS.find((h) => h.id === 'deepseek-harness-desktop');
    const probes = bundleProbes(official);
    assert.ok(probes.length >= 2, 'darwin probes exist');
    for (const p of probes) {
      assert.ok(!p.installRoot.includes('localappdata-sentinel'), `win32 probe leaked under a darwin platform: ${p.installRoot}`);
      assert.deepEqual(p.archive, ['app.asar'], 'macOS keeps app.asar directly under Contents/Resources');
    }
    const anyHome = homeCandidates(DESKTOP_HOSTS.find((h) => h.id === 'dsh-desktop-anywhere-labs'));
    assert.ok(anyHome.some((c) => c.home.includes('.dsh-beta')), 'beta home still resolves under darwin');
  });
});

test('T7 darwin official probe hits Contents/Resources/app.asar; the doubled segment misses (N1)', async (t) => {
  const dir = envSandbox(t);
  await withPlatform('darwin', { HOME: dir, LOCALAPPDATA: null, APPDATA: null }, async () => {
    const res = path.join(dir, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources');
    fs.mkdirSync(res, { recursive: true });
    fs.copyFileSync(FIXTURE_ASAR, path.join(res, 'app.asar'));
    const home = path.join(dir, 'no-profile-home');
    const e = runtimeEvidence(home, null, 'desktop:deepseek-harness-desktop');
    assert.equal(e.version, '0.2.0-rc.2', JSON.stringify(e.sources));
    assert.equal(e.sources[0].source, 'desktop-runtime.json');
    // the exact pre-fix join (Resources/resources/app.asar) must stay a miss
    fs.rmSync(path.join(res, 'app.asar'));
    fs.mkdirSync(path.join(res, 'resources'), { recursive: true });
    fs.copyFileSync(FIXTURE_ASAR, path.join(res, 'resources', 'app.asar'));
    const e2 = runtimeEvidence(home, null, 'desktop:deepseek-harness-desktop');
    assert.equal(e2.version, null, 'Resources/resources/app.asar must never be accepted');
  });
});

test('T7 descriptor absent → the package.json fallback carries the version (N2)', async (t) => {
  const dir = envSandbox(t);
  await withPlatform('win32', { LOCALAPPDATA: dir }, async () => {
    installOfficial(dir, fs.readFileSync(FIXTURE_ASAR_NODESC));
    const e = runtimeEvidence(path.join(dir, 'h'), null, 'desktop:deepseek-harness-desktop');
    assert.equal(e.version, '0.2.0-rc.2');
    assert.equal(e.sources[0].source, 'package.json', 'the fallback hit is labelled by its own source');
  });
});

test('T7 descriptor present but untrusted → NO fallback, and the marker is listed (N2)', async (t) => {
  const dir = envSandbox(t);
  await withPlatform('win32', { LOCALAPPDATA: dir }, async () => {
    const desc = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      release: { version: '1.0.0' },
      sharedPackages: { '@deepseek-ai/dsh': { name: '@deepseek-ai/dsh', version: '1.0.0' } },
    }));
    const pkg = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }));
    installOfficial(dir, buildMiniAsar([
      { path: 'dsh/desktop-runtime.json', data: desc },
      { path: 'dsh/node_modules/@deepseek-ai/dsh/package.json', data: pkg },
    ]));
    const e = runtimeEvidence(path.join(dir, 'h'), null, 'desktop:deepseek-harness-desktop');
    assert.equal(e.version, null, 'an untrusted descriptor must not be bypassed through the fallback');
    assert.equal(e.untrusted.length, 1, 'the untrusted marker is reported, not silently dropped');
    assert.equal(e.untrusted[0].host, 'deepseek-harness-desktop');
  });
});

test('T7 without npm_config_prefix no global tree is discovered (documented contract)', (t) => {
  const dir = envSandbox(t);
  const nm = path.join(dir, 'npm-global', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const e = runtimeEvidence(path.join(dir, 'h'), null, undefined);
  assert.equal(e.version, null, 'a global install outside npm scripts is not probed: pass --current');
  assert.deepEqual(e.sources, []);
});

test('T7 untrusted markers reach the report evidence through check (round 5 P2-1)', async (t) => {
  const dir = envSandbox(t);
  await withWin32(dir, async () => {
    makeProfile(path.join(dir, '.dsh'));
    const desc = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      release: { version: '1.0.0' },
      sharedPackages: { '@deepseek-ai/dsh': { name: '@deepseek-ai/dsh', version: '1.0.0' } },
    }));
    installOfficial(dir, buildMiniAsar([{ path: 'dsh/desktop-runtime.json', data: desc }]));
    const artifacts = path.join(dir, 'artifacts');
    const { report } = await cmdCheck({ artifacts });
    const b1 = report.stages.find((s) => s.id === 'b1-peer-graph');
    const cr = b1.evidence.find((e) => e.currentRuntime);
    assert.ok(cr, 'currentRuntime evidence must appear even with zero hits but an untrusted marker');
    assert.equal(cr.currentRuntime.version, null);
    assert.equal(cr.currentRuntime.untrusted.length, 1);
    assert.equal(cr.currentRuntime.untrusted[0].host, 'deepseek-harness-desktop');
    const raw = fs.readFileSync(path.join(artifacts, 'report.json'), 'utf8');
    assert.ok(!raw.includes(dir), 'the sandbox path still never reaches the report');
  });
});

// ---- T8: desktop scoping ----

test('T8 desktopDataContext: scoping, honesty fields and warning wording', () => {
  const plain = desktopDataContext('default', 'web', '0.2.0-rc.2');
  assert.equal(plain.scoped, false);
  assert.equal(plain.host.desktopRuntimeTested, false);
  assert.deepEqual(plain.host.scopedVia, []);

  const viaOrigin = desktopDataContext('desktop:dsh-desktop-anywhere-labs', 'web', '0.2.0-rc.2');
  assert.equal(viaOrigin.scoped, true);
  assert.equal(viaOrigin.host.desktopApp, 'dsh-desktop-anywhere-labs');
  assert.deepEqual(viaOrigin.host.scopedVia, ['home-origin']);
  assert.match(viaOrigin.warning, /npm candidate/);
  assert.match(viaOrigin.warning, /not the desktop app's own update channel/);

  const noCurrent = desktopDataContext('desktop:dshdesktop-dataelement', 'web', null);
  assert.match(noCurrent.warning, /NOT detected/);
  assert.match(noCurrent.warning, /--current/);

  const viaProfile = desktopDataContext('default', 'desktop', null);
  assert.equal(viaProfile.scoped, true, 'the measured desktop profile naming counts as desktop-hosted');
  assert.deepEqual(viaProfile.host.scopedVia, ['profile-name']);

  const conflicted = desktopDataContext('default', 'web', null, {
    currentAmbiguous: [{ host: 'a', version: '1.0.0' }, { host: 'b', version: '2.0.0' }],
  });
  assert.equal(conflicted.host.desktopScoped, false, 'a version conflict alone is not desktop scoping');
  assert.equal(conflicted.host.currentAmbiguous.length, 2);
});

// ---- T9: run authorization ----

test('T9 run gates on pure-desktop ambiguity before any network work', async (t) => {
  const dir = envSandbox(t);
  process.env.APPDATA = dir;
  makeDataelementHome();
  makeBetaHome(dir);
  const { code, report } = await cmdRun({ to: '0.2.0-rc.2', artifacts: path.join(dir, 'artifacts') });
  assert.equal(code, 3);
  assert.match(report.warnings.join('\n'), /explicit --home/);
  assert.match(JSON.stringify(report), /dshdesktop-dataelement/);
  assert.equal(report.stages.length, 0, 'no stage ran — the gate precedes the pipeline');
  assert.equal(desktopAmbiguityGate({ origin: 'desktop:dshdesktop-dataelement', desktopCandidates: 1, alternates: [] }).block, false, 'a single validating candidate proceeds');
});

// ---- T10: end-to-end check on a discovered desktop home ----

test('T10 check discovers a dataelement home end-to-end, labels the origin, leaks no path', (t) => {
  const dir = envSandbox(t);
  process.env.APPDATA = dir;
  makeDataelementHome();
  const artifacts = path.join(dir, 'artifacts');
  const r = spawnSync(process.execPath, [CLI, 'check', '--artifacts', artifacts], {
    encoding: 'utf8', env: process.env, windowsHide: true, timeout: 120000,
  });
  assert.ok([0, 1, 2].includes(r.status), `exit must be a decision, got ${r.status}: ${r.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(artifacts, 'report.json'), 'utf8'));
  assert.equal(report.target.homeOrigin, 'desktop:dshdesktop-dataelement');
  const inv = report.stages.find((s) => s.id === 'a-inventory');
  assert.match(inv.details, /home=desktop:dshdesktop-dataelement;/, 'inventory describes the origin, not the path');
  const raw = fs.readFileSync(path.join(artifacts, 'report.json'), 'utf8') + fs.readFileSync(path.join(artifacts, 'report.md'), 'utf8');
  assert.ok(!raw.includes(dir), 'the sandbox path never reaches the report');
});

// ---- T11: homeShape origin passthrough ----

test('T11 homeShape passes desktop origins through and keeps legacy shapes intact', () => {
  assert.equal(homeShape('X:\\dsh', 'X:\\def', 'desktop:dshdesktop-dataelement'), 'desktop:dshdesktop-dataelement');
  const shaped = homeShape('/somewhere', '/elsewhere', 'desktop:dsh-desktop-anywhere-labs');
  assert.ok(!shaped.includes('/') && !shaped.includes('\\'), 'the label never carries a path separator');
  assert.equal(homeShape('/somewhere', '/elsewhere', 'flag'), 'custom', 'non-desktop origins keep legacy shapes');
  const d = path.join(os.homedir(), '.dsh');
  assert.equal(homeShape(d, d), 'default', 'two-argument calls behave exactly as before');
});
