// Offline coverage for the write-round safety layer in src/lib/shadow.js and
// the interrupted-run sweep in src/lib/util.js. The candidate binary is faked
// with a script that prints canned --dump-config output — writeReplayPatch
// only consumes the dump's stdout, so no network, no npm, no real dsh.
// Round 8 pins the fail-closed contract: a failed dump, an unparseable dump,
// or a suppression pass that yields ZERO rows must abort the write path.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeReplayPatch } from '../src/lib/shadow.js';
import { sweepStaleShadowHomes, claimOwnedDir, readOwner } from '../src/lib/util.js';

// A faithful slice of the real headless composition: the tools REGISTRY row
// (never disabled), one official adapter, and leaf executor rows whose ids do
// NOT start with `tool-` (the historical id-only matcher's blind spot).
const DUMP_OK = [
  "- id: tools",
  "  name: '@deepseek-ai/dsh-tools'",
  "- id: llm-deepseek",
  "  name: '@deepseek-ai/dsh-llm-deepseek'",
  "- id: tool-terminal",
  "  name: '@deepseek-ai/dsh-terminal'",
  "- id: skill-filesystem",
  "  name: '@deepseek-ai/dsh-skill-filesystem'",
].join('\n');

const ADAPTER_PREFIXES = ['@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-llm-pi-ai'];

function fakeBin(dir, { stdout = '', code = 0 } = {}) {
  const bin = path.join(dir, `fake-bin-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(bin, `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${code});\n`);
  return bin;
}

function shadowScaffold() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-shadowtest-'));
  fs.mkdirSync(path.join(home, 'profiles', 'headless'), { recursive: true });
  return home;
}

test('writeReplayPatch: suppresses tool rows by id AND name prefix, quotes every id, keeps the tools registry row', () => {
  const home = shadowScaffold();
  const bin = fakeBin(home, { stdout: DUMP_OK });
  const res = writeReplayPatch(home, bin, {
    adapterNamePrefixes: ADAPTER_PREFIXES,
    providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', contextWindow: 128000 }] }],
    fixturePath: null,
    suppressToolRows: true,
  });
  assert.equal(res.ok, true);
  // registry row never disabled; adapter disabled via name prefix; leaf rows
  // matched by id (tool-terminal) and by name prefix (skill-filesystem)
  assert.equal(res.disableIds.includes('tools'), false);
  for (const id of ['llm-deepseek', 'tool-terminal', 'skill-filesystem']) {
    assert.ok(res.disableIds.includes(id), `expected ${id} in disableIds`);
  }
  assert.equal(res.suppressedToolIds.includes('skill-filesystem'), true);
  const patch = fs.readFileSync(path.join(home, 'profiles', 'headless', 'cordis.patch.yml'), 'utf8');
  // every disable id is a JSON string: a hostile id could otherwise break YAML
  for (const id of res.disableIds) {
    assert.ok(patch.includes(`- id: ${JSON.stringify(id)}`), `disable row for ${id} is not quoted`);
    assert.ok(!patch.includes(`- id: ${id}\n`), `unquoted id row leaked for ${id}`);
  }
  assert.ok(patch.includes('- insert:'), 'insert block missing');
  assert.ok(patch.includes("id: \"llm-replay\"") || patch.includes('id: llm-replay'), 'replay row missing');
  assert.ok(patch.includes('providers:'), 'providers block missing');
  fs.rmSync(home, { recursive: true, force: true });
});

test('writeReplayPatch: dump-config failing (exit != 0) fails closed — no patch file is written', () => {
  const home = shadowScaffold();
  const bin = fakeBin(home, { stdout: DUMP_OK, code: 1 });
  const res = writeReplayPatch(home, bin, { adapterNamePrefixes: ADAPTER_PREFIXES, providers: [], fixturePath: null });
  assert.deepEqual(res, { ok: false, reason: 'dump-config-failed', disableIds: [], suppressedToolIds: [], rowInserted: false });
  assert.equal(fs.existsSync(path.join(home, 'profiles', 'headless', 'cordis.patch.yml')), false, 'a failed dump must not leave a patch file');
  fs.rmSync(home, { recursive: true, force: true });
});

test('writeReplayPatch: empty dump output fails closed', () => {
  const home = shadowScaffold();
  const bin = fakeBin(home, { stdout: '' });
  const res = writeReplayPatch(home, bin, { adapterNamePrefixes: ADAPTER_PREFIXES, providers: [], fixturePath: null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'dump-config-failed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('writeReplayPatch: output that parses to zero rows fails closed (dump format drift)', () => {
  const home = shadowScaffold();
  const bin = fakeBin(home, { stdout: 'composition dump: ok\nnothing machine-readable here\n' });
  const res = writeReplayPatch(home, bin, { adapterNamePrefixes: ADAPTER_PREFIXES, providers: [], fixturePath: null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'dump-config-unparsed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('writeReplayPatch: suppression requested but ZERO rows matched fails closed — suppression must never silently no-op', () => {
  const home = shadowScaffold();
  // a dump with only the adapter row: parses fine, but there is no tool row
  const bin = fakeBin(home, { stdout: "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n" });
  const res = writeReplayPatch(home, bin, { adapterNamePrefixes: ADAPTER_PREFIXES, providers: [], fixturePath: null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'tool-suppression-empty');
  assert.equal(fs.existsSync(path.join(home, 'profiles', 'headless', 'cordis.patch.yml')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('writeReplayPatch: with suppression not requested, a composition without tool rows is fine', () => {
  const home = shadowScaffold();
  const bin = fakeBin(home, { stdout: "- id: llm-deepseek\n  name: '@deepseek-ai/dsh-llm-deepseek'\n" });
  const res = writeReplayPatch(home, bin, { adapterNamePrefixes: ADAPTER_PREFIXES, providers: [], fixturePath: null, suppressToolRows: false });
  assert.equal(res.ok, true);
  assert.deepEqual(res.suppressedToolIds, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('sweepStaleShadowHomes: removes only directories carrying the shadow ownership marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-sweeptest-'));
  const marked = path.join(root, 'dsh-rehearsal-home-marked');
  const unmarked = path.join(root, 'dsh-rehearsal-home-bare');
  const otherKind = path.join(root, 'dsh-rehearsal-home-artifact');
  const notOurs = path.join(root, 'dsh-rehearsal-home-unreadable');
  fs.mkdirSync(marked, { recursive: true });
  fs.mkdirSync(path.join(marked, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(marked, 'sessions', 'x'), 'plaintext');
  fs.writeFileSync(path.join(marked, '.dsh-rehearsal-owner'), 'dsh-rehearsal-shadow-v1\n');
  fs.mkdirSync(unmarked, { recursive: true });
  fs.mkdirSync(otherKind, { recursive: true });
  fs.writeFileSync(path.join(otherKind, '.dsh-rehearsal-owner'), 'dsh-rehearsal-artifact-v1\n');
  fs.mkdirSync(notOurs, { recursive: true });
  fs.writeFileSync(path.join(notOurs, '.dsh-rehearsal-owner'), 'somebody-else-v1\n');
  const removed = sweepStaleShadowHomes(root);
  assert.deepEqual(removed, ['dsh-rehearsal-home-marked']);
  assert.equal(fs.existsSync(marked), false, 'the marked shadow home must be removed');
  assert.equal(fs.existsSync(unmarked), true, 'an unmarked same-name directory must survive');
  assert.equal(fs.existsSync(otherKind), true, 'a different owner kind must survive');
  assert.equal(fs.existsSync(notOurs), true, 'a foreign marker must survive');
  assert.equal(readOwner(unmarked), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sweepStaleShadowHomes: tolerates an unreadable scan root and reports nothing', () => {
  const removed = sweepStaleShadowHomes(path.join(os.tmpdir(), `dshr-sweep-missing-${Date.now()}`));
  assert.deepEqual(removed, []);
});

test('ownership marker: a claimed shadow home is what the sweep gates on (sanity, matches claimOwnedDir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-claimtest-'));
  assert.equal(claimOwnedDir(dir, 'shadow'), true);
  assert.equal(readOwner(dir), 'dsh-rehearsal-shadow-v1');
  fs.rmSync(dir, { recursive: true, force: true });
});
