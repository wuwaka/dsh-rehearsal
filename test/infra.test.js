// Infrastructure fixes from the audit:
//  P2-3 yaml-lite counts insert-block rows, P2-4 listProfiles excludes
//  node_modules/hidden dirs, P2-6 shadowEnv never mutates the parent env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countRows, simpleListAfter } from '../src/lib/yaml-lite.js';
import { listProfiles, detectCurrentDshVersion } from '../src/lib/dshhome.js';
import { shadowEnv, redactedEnvNames } from '../src/lib/util.js';
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

test('detectCurrentDshVersion prefers the profile-scoped install over machine probes (P2-1)', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dshPkg = path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(dshPkg, { recursive: true });

  // a profile-level install is authoritative for that home, and must be found
  // before any machine-wide probe (Desktop bundle / npm prefix)
  fs.writeFileSync(path.join(dshPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  assert.equal(detectCurrentDshVersion(home, 'web'), '0.2.0-rc.2');

  // garbage is never reported as a version — callers must see null and treat
  // it as "unknown", never as "matches the candidate"
  fs.writeFileSync(path.join(dshPkg, 'package.json'), '{ not json');
  const asText = detectCurrentDshVersion(home, 'web');
  assert.ok(asText === null || /^\d+\.\d+\.\d+/.test(asText), `unexpected: ${asText}`);
  fs.writeFileSync(path.join(dshPkg, 'package.json'), JSON.stringify({ version: 'nightly-build' }));
  const asJunk = detectCurrentDshVersion(home, 'web');
  assert.ok(asJunk === null || /^\d+\.\d+\.\d+/.test(asJunk), `non-semver leaked: ${asJunk}`);

  assert.equal(detectCurrentDshVersion(home, undefined), detectCurrentDshVersion(home, null), 'missing profile name must not throw');
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
});
