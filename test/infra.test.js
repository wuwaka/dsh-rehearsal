// Infrastructure fixes from the audit:
//  P2-3 yaml-lite counts insert-block rows, P2-4 listProfiles excludes
//  node_modules/hidden dirs, P2-6 shadowEnv never mutates the parent env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countRows, simpleListAfter } from '../src/lib/yaml-lite.js';
import { listProfiles, detectCurrentDshVersion, runtimeEvidence } from '../src/lib/dshhome.js';
import { shadowEnv, redactedEnvNames, claimOwnedDir, readOwner, isOwnedArtifactsDir, sanitizedEnv, stripUrlCredentials, run } from '../src/lib/util.js';
import { patchAdoptionGate } from '../src/lib/shadow.js';

const DESKTOP_LIKE = `- id: desktop-shell
  name: dsh-plugin-desktop
  config:
    mode: compatibility
    providers:
      opencode:
        models:
          - id: big-pickle
            contextWindow: 128000
          - id: mimo-v2.5
            contextWindow: 128000
- insert:
  - name: '@deepseek-ai/dsh-browser-use'
  - name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'
  - id: plugin-with-id
`;

test('P2-3 (round-3 corrected): countRows counts top rows + insert children, NEVER config depth', () => {
  // 1 top `- id:` + 3 insert children (2 by - name:, 1 by - id:) = 4;
  // the 2 model ids under providers>opencode>models are config entries.
  assert.equal(countRows(DESKTOP_LIKE), 4);
  // real desktop anatomy regression: 14 col-0 + 2 insert(- name:) = 16,
  // NOT 26 (the any-indent overcount the round-3 auditor caught)
  const desktopish = ['- id: a', '- insert:', "  - name: 'pkg-x'", '    config:', '      models:', '        - id: deepseek-flash'].join('\n');
  assert.equal(countRows(desktopish), 2);
});

test('yaml-lite simpleListAfter still works', () => {
  const ws = 'nodeLinker: hoisted\nminimumReleaseAgeExclude:\n  - foo@1.0.0\n  - bar@2.0.0\nother: 1\n';
  assert.deepEqual(simpleListAfter(ws, 'minimumReleaseAgeExclude'), ['foo@1.0.0', 'bar@2.0.0']);
  assert.deepEqual(simpleListAfter(ws, 'missing'), []);
});

test('P2-4: listProfiles skips node_modules and hidden dirs', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-prof-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const d of ['desktop', 'web', 'node_modules', '.lock-tmp']) {
    fs.mkdirSync(path.join(home, 'profiles', d), { recursive: true });
  }
  assert.deepEqual(listProfiles(home).sort(), ['desktop', 'web']);
});

test('P2-6: shadowEnv is a complete env with secrets stripped, parent untouched', () => {
  const before = process.env.SECRET_PROBE_TOKEN;
  process.env.SECRET_PROBE_TOKEN = 'super-secret-value';
  process.env.PLAIN_VAR = 'ok';
  try {
    const env = shadowEnv('/tmp/shadow-home');
    assert.equal(env.SECRET_PROBE_TOKEN, undefined, 'secret stripped from child env');
    assert.equal(env.PLAIN_VAR, 'ok', 'non-secret preserved');
    assert.equal(env.DSH_HOME, '/tmp/shadow-home');
    assert.equal(env.DSH_TELEMETRY_MODE, 'DISABLED');
    assert.ok(env.Path || env.PATH, 'complete env carries PATH');
    assert.equal(process.env.SECRET_PROBE_TOKEN, 'super-secret-value', 'parent env NEVER mutated');
    assert.ok(redactedEnvNames().includes('SECRET_PROBE_TOKEN'));
  } finally {
    delete process.env.SECRET_PROBE_TOKEN;
    delete process.env.PLAIN_VAR;
  }
});

test('sanitizedEnv strips URL-embedded userinfo credentials from surviving values (round 8)', (t) => {
  // a credential can hide in a VALUE whose NAME matches nothing: proxy and
  // registry endpoints are the common carriers (http://user:token@host/...)
  process.env.R8_HTTP_PROXY = 'http://user:secret@proxy.example.com:8080';
  process.env.R8_NPM_CONFIG_REGISTRY = 'https://user:token@registry.example.org/';
  process.env.R8_PLAIN_URL = 'https://registry.npmjs.org/';
  try {
    const env = sanitizedEnv();
    assert.equal(env.R8_HTTP_PROXY, 'http://proxy.example.com:8080/', 'proxy userinfo stripped');
    assert.equal(env.R8_NPM_CONFIG_REGISTRY, 'https://registry.example.org/', 'registry userinfo stripped');
    assert.equal(env.R8_PLAIN_URL, 'https://registry.npmjs.org/', 'URL without userinfo unchanged');
    assert.equal(process.env.R8_HTTP_PROXY, 'http://user:secret@proxy.example.com:8080', 'parent env NEVER mutated');
    // a child must not see the secret either
    const r = run(process.execPath, ['-e', 'console.log((process.env.R8_HTTP_PROXY.match(/secret|user/) ?? ["clean"]).join(""))'], { env: sanitizedEnv() });
    assert.equal(r.stdout.trim(), 'clean', 'userinfo credentials do not reach the child');
  } finally {
    delete process.env.R8_HTTP_PROXY;
    delete process.env.R8_NPM_CONFIG_REGISTRY;
    delete process.env.R8_PLAIN_URL;
  }
});

test('stripUrlCredentials: unit contract — non-URLs, unparseable values and query strings pass through', () => {
  assert.equal(stripUrlCredentials('https://u:p@host/path'), 'https://host/path');
  assert.equal(stripUrlCredentials('http://user:P@ss@host:8080'), 'http://host:8080/', 'only the LAST @ separates userinfo');
  assert.equal(stripUrlCredentials('C:\\Users\\somebody\\file'), 'C:\\Users\\somebody\\file', 'a path is not a URL');
  assert.equal(stripUrlCredentials('not a url'), 'not a url');
  assert.equal(stripUrlCredentials('http://[::1:bad'), 'http://[::1:bad', 'unparseable URL passes through unchanged');
  assert.equal(stripUrlCredentials(42), 42, 'non-string values are returned as-is');
});

test('detectCurrentDshVersion prefers the profile-scoped install over machine probes (P2-1)', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dshPkg = path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(dshPkg, { recursive: true });

  // a profile-level install is authoritative for that home, and must be found
  // before any machine-wide probe (Desktop bundle / npm prefix)
  fs.writeFileSync(path.join(dshPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  assert.equal(detectCurrentDshVersion(home, 'web'), '0.2.0-rc.2');

  // a marker that EXISTS but is unusable is untrusted: current resolves to
  // null and the chain STOPS — machine-level bundles (a desktop install that
  // may belong to another host) must never answer for the profile's own
  // runtime. The old fall-through let a broken profile marker be silently
  // replaced by whatever version the machine happened to carry.
  fs.writeFileSync(path.join(dshPkg, 'package.json'), '{ not json');
  assert.equal(detectCurrentDshVersion(home, 'web'), null, 'unreadable profile marker must not fall through');
  fs.writeFileSync(path.join(dshPkg, 'package.json'), JSON.stringify({ version: 'nightly-build' }));
  assert.equal(detectCurrentDshVersion(home, 'web'), null, 'non-semver profile marker must not fall through');
  const ev = runtimeEvidence(home, 'web', undefined);
  assert.equal(ev.version, null);
  assert.equal(ev.sources.length, 0);
  assert.equal(ev.untrusted.length, 1, 'the untrusted marker is provenance, not silence');
  assert.equal(ev.untrusted[0].host, 'profile-node_modules');

  assert.equal(detectCurrentDshVersion(home, undefined), detectCurrentDshVersion(home, null), 'missing profile name must not throw');
});

test('sanitizedEnv keeps the install path credential-stripped (round 7)', (t) => {
  // with --run-scripts the dependency lifecycle scripts execute; before this
  // fix they inherited the full parent environment, secret-shaped vars and all
  process.env.R7_SECRET_PROBE_TOKEN = 'super-secret-value';
  process.env.R7_PLAIN_VAR = 'ok';
  try {
    const env = sanitizedEnv();
    assert.equal(env.R7_SECRET_PROBE_TOKEN, undefined, 'secret stripped');
    assert.equal(env.R7_PLAIN_VAR, 'ok', 'plain vars preserved');
    assert.equal(env.DSH_HOME, undefined, 'the install env is not a shadow env');
    const r = run(process.execPath, ['-e', 'console.log(process.env.R7_SECRET_PROBE_TOKEN ?? "absent")'], { env: sanitizedEnv() });
    assert.equal(r.stdout.trim(), 'absent', 'a child actually cannot see the secret');
    assert.equal(process.env.R7_SECRET_PROBE_TOKEN, 'super-secret-value', 'parent untouched');
  } finally {
    delete process.env.R7_SECRET_PROBE_TOKEN;
    delete process.env.R7_PLAIN_VAR;
  }
  // wiring lock: the candidate install must pass this env to its npm spawn
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'lib', 'shadow.js'), 'utf8');
  const block = src.slice(src.indexOf('export async function installCandidate'), src.indexOf('export function mountReplayPlugin'));
  assert.match(block, /env:\s*sanitizedEnv\(\)/, 'npm install must run credential-stripped');
});

test('claimOwnedDir adopts empty dirs, reuses its own marker, refuses foreign content (round 6)', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-own-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const fresh = path.join(base, 'fresh');
  assert.equal(claimOwnedDir(fresh, 'shadow'), true);
  assert.equal(readOwner(fresh), 'dsh-rehearsal-shadow-v1');
  assert.equal(claimOwnedDir(fresh, 'shadow'), true, 'same kind reuses its marker');
  assert.equal(claimOwnedDir(fresh, 'prefix'), false, 'another kind must not take over');

  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty);
  assert.equal(claimOwnedDir(empty, 'prefix'), true, 'an empty existing dir is adoptable');

  const full = path.join(base, 'full');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'x.txt'), 'x');
  assert.equal(claimOwnedDir(full, 'shadow'), false, 'non-empty unmarked dirs are refused');
  assert.equal(readOwner(full), null, 'a refused dir is left exactly as found');

  assert.throws(() => claimOwnedDir(path.join(base, 'no-such-kind'), 'bogus'), /unknown owner kind/);
});

test('isOwnedArtifactsDir: markers, aggregate parents, legacy layout, refusals (round 6)', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-owned2-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const mark = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.dsh-rehearsal-owner'), 'dsh-rehearsal-artifact-v1\n');
  };

  const own = path.join(base, 'own');
  mark(own);
  assert.equal(isOwnedArtifactsDir(own), true);

  const agg = path.join(base, 'agg');
  mark(path.join(agg, 'check-1'));
  assert.equal(isOwnedArtifactsDir(agg), true, 'every child marked');

  const mixed = path.join(base, 'mixed');
  mark(path.join(mixed, 'check-1'));
  fs.writeFileSync(path.join(mixed, 'loose.txt'), 'x');
  assert.equal(isOwnedArtifactsDir(mixed), false, 'a loose file disqualifies the parent');

  const legacy = path.join(base, '.dsh-rehearsal');
  fs.mkdirSync(path.join(legacy, 'run-0.2.0-rc.2-1790945328460'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'run-0.2.0-rc.2-1790945328460', 'report.json'), '{}');
  fs.mkdirSync(path.join(legacy, 'check-1791188357615'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'check-interrupted'), { recursive: true }); // empty child: interrupted run
  assert.equal(isOwnedArtifactsDir(legacy), true, 'pre-marker default layout stays cleanable (report or empty children)');

  const fakeParent = path.join(base, 'elsewhere');
  fs.mkdirSync(fakeParent, { recursive: true });
  const fake = path.join(fakeParent, '.dsh-rehearsal');
  fs.mkdirSync(path.join(fake, 'check-important'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'check-important', 'secret.txt'), 'x');
  assert.equal(isOwnedArtifactsDir(fake), false, 'a name without artifact structure is not ours');

  const wrongName = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(wrongName, 'check-9'), { recursive: true });
  assert.equal(isOwnedArtifactsDir(wrongName), false, 'the legacy fallback is scoped to the tool default name');

  const corrupt = path.join(base, 'corrupt');
  fs.mkdirSync(corrupt);
  fs.writeFileSync(path.join(corrupt, '.dsh-rehearsal-owner'), 'garbage\n');
  fs.mkdirSync(path.join(corrupt, 'check-1'));
  assert.equal(isOwnedArtifactsDir(corrupt), false, 'a corrupt marker is not a marker');

  assert.equal(isOwnedArtifactsDir(path.join(base, 'absent')), false);
});

test('P2-6: patchAdoptionGate re-seeds its backup when the candidate version changes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hl = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-headless', 'lib');
  fs.mkdirSync(hl, { recursive: true });
  const dshPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(dshPkg, { recursive: true });
  const writeCandidate = (version, marker) => {
    fs.writeFileSync(path.join(dshPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
    fs.writeFileSync(path.join(hl, 'index.js'), `// ${marker}\nfunction currentPreset(ctx) { return ctx; }\n`);
  };
  writeCandidate('1.0.0', 'candidate-one');
  assert.equal(patchAdoptionGate(dir).ok, true);
  assert.match(fs.readFileSync(path.join(hl, 'index.js'), 'utf8'), /candidate-one/);

  // a reused --prefix-dir gets candidate B installed over candidate A: the
  // patch must be derived from B, not from A's stale backup
  writeCandidate('2.0.0', 'candidate-two');
  assert.equal(patchAdoptionGate(dir).ok, true);
  const after = fs.readFileSync(path.join(hl, 'index.js'), 'utf8');
  assert.match(after, /candidate-two/, 'the patch base must be the freshly installed candidate');
  assert.match(after, /return void 0;/);
  assert.ok(!after.includes('candidate-one'), 'candidate A content must not survive into B');

  // version unreadable: refuse to patch rather than guess which backup is valid
  fs.rmSync(path.join(dshPkg, 'package.json'));
  const before = fs.readFileSync(path.join(hl, 'index.js'), 'utf8');
  const refused = patchAdoptionGate(dir);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'candidate-version-unknown');
  assert.equal(fs.readFileSync(path.join(hl, 'index.js'), 'utf8'), before, 'the live file stays untouched');
});
