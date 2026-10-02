// sessions: discovery, header parsing, classification and the copy set —
// over a fully synthetic DSH_HOME (no user data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { discoverSessions, classify, copySet, readHeader, encodeCwdDir } from '../src/lib/sessions.js';

function makeSessionFile(dir, name, { version = 0, id, cwd, preset } = {}) {
  const header = { type: 'header', version, id, cwd, time: 't' };
  if (preset) header.agentPreset = preset;
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: 'turn/start', seq: 1, time: 't', data: {} }),
    JSON.stringify({ type: 'turn/end', seq: 2, time: 't', data: {} }),
  ];
  const fname = version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`;
  // Real dsh logs are multi-frame; keep the fixture honest with one frame per line.
  const buf = Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(l + '\n', 'utf8'))));
  fs.writeFileSync(path.join(dir, fname), buf);
}

function mkHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-fixture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('discover + readHeader: generation, preset and cwd come from the first frame', (t) => {
  const home = mkHome(t);
  const s1 = path.join(home, 'sessions', '--C-Users-x--', 'session-aaa');
  fs.mkdirSync(s1, { recursive: true });
  makeSessionFile(s1, 'session.jsonl.zstd', { version: 0, id: 'session-aaa', cwd: home });
  const { sessions } = discoverSessions(home);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].maxGen, 0);
  assert.equal(sessions[0].header.version, 0);
  assert.equal(sessions[0].header.cwd, home);
  assert.equal(sessions[0].header.agentPreset, undefined);
});

test('classify: preset and already-v4 skipped; nonexistent real cwd is now DRILLABLE (sandbox rewrite made the gate obsolete)', (t) => {
  const home = mkHome(t);
  const mk = (ws, id, opts) => {
    const d = path.join(home, 'sessions', ws, id);
    fs.mkdirSync(d, { recursive: true });
    if (opts.v4too) makeSessionFile(d, 'x', { ...opts, version: 4, id });
    makeSessionFile(d, 'y', { ...opts, version: 0, id });
  };
  mk('w1', 'session-plain', { version: 0, id: 'session-plain', cwd: home });
  mk('w2', 'session-ptc', { version: 0, id: 'session-ptc', cwd: home, preset: 'ptc' });
  mk('w3', 'session-done', { version: 0, id: 'session-done', cwd: home, v4too: true });
  // real cwd directory no longer needs to exist: copySet rewrites header.cwd
  // into a fresh sandbox dir (round-3 nit b — coverage win for moved/deleted
  // workspaces)
  mk('w4', 'session-gone', { version: 0, id: 'session-gone', cwd: 'X:/definitely/not/there' });
  // header WITHOUT a cwd field at all cannot be adopted anywhere -> cwdMissing
  const w5 = path.join(home, 'sessions', 'w5', 'session-nocwd');
  fs.mkdirSync(w5, { recursive: true });
  makeSessionFile(w5, 'session.jsonl.zstd', { version: 0, id: 'session-nocwd', cwd: undefined });

  const { sessions } = discoverSessions(home);
  const { drillable, selected, skipped } = classify(sessions, { sample: 10 });
  const ids = drillable.map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ['session-gone', 'session-plain']);
  assert.equal(selected.length, 2);
  assert.equal(skipped.preset.length, 1);
  assert.equal(skipped.alreadyV4.length, 1);
  assert.equal(skipped.cwdMissing.length, 1);
  assert.equal(skipped.cwdMissing[0].sessionId, 'session-nocwd');
});

test('copySet places copies in the encoded sandbox workspace dir and never copies credentials', (t) => {
  const home = mkHome(t);
  const s1 = path.join(home, 'sessions', '--D-Work-proj--', 'session-bbb');
  fs.mkdirSync(s1, { recursive: true });
  makeSessionFile(s1, 'session.jsonl.zstd', { version: 0, id: 'session-bbb', cwd: home });
  fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', 'session-bbb.json'), '{}');
  fs.writeFileSync(path.join(home, 'storages', 'session_projcache.json'), '{}');
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), '{}');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'secret');

  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-shadow-'));
  t.after(() => fs.rmSync(shadow, { recursive: true, force: true }));
  const { sessions } = discoverSessions(home);
  const { copied, side, shadowCwd } = copySet(home, shadow, sessions);
  assert.deepEqual(copied, ['session-bbb']);
  const wsName = encodeCwdDir(shadowCwd.get('session-bbb'));
  assert.ok(fs.existsSync(path.join(shadow, 'sessions', wsName, 'session-bbb', 'session.jsonl.zstd')), 'copy lives in encoded sandbox dir');
  assert.ok(fs.existsSync(path.join(shadow, 'storages', 'session_projcache', 'sessions', 'session-bbb.json')));
  assert.ok(fs.existsSync(path.join(shadow, 'storages', 'workspace.json')));
  assert.ok(side.includes('storages/session_projcache/'));
  assert.equal(fs.existsSync(path.join(shadow, '.credentials.yaml')), false);
});

test('readHeader returns parseError marker for garbage input', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-bad-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const f = path.join(tmp, 'session.jsonl.zstd');
  fs.writeFileSync(f, Buffer.from('not zstd at all'));
  const h = readHeader(f);
  assert.ok(h.parseError);
});

test('copySet rewrites the copied header cwd into the shadow sandbox; original untouched (P0-1)', (t) => {
  const home = mkHome(t);
  const s1 = path.join(home, 'sessions', '--ws--', 'session-sb');
  fs.mkdirSync(s1, { recursive: true });
  const realCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-realcwd-'));
  t.after(() => fs.rmSync(realCwd, { recursive: true, force: true }));
  makeSessionFile(s1, 'session.jsonl.zstd', { version: 0, id: 'session-sb', cwd: realCwd });

  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-shadow-'));
  t.after(() => fs.rmSync(shadow, { recursive: true, force: true }));
  const { sessions } = discoverSessions(home);
  const { shadowCwd } = copySet(home, shadow, sessions);

  const sandbox = shadowCwd.get('session-sb');
  assert.ok(sandbox && sandbox.startsWith(shadow), 'sandbox cwd lives under the shadow home');
  assert.ok(fs.existsSync(sandbox), 'sandbox dir created');
  // the harness derives the physical path from header.cwd, so the copy must
  // live in the workspace dir named by that encoding
  const wsName = encodeCwdDir(sandbox);
  const dstFile = path.join(shadow, 'sessions', wsName, 'session-sb', 'session.jsonl.zstd');
  assert.ok(fs.existsSync(dstFile), `copy placed in encoded sandbox workspace dir ${wsName}`);
  const dstHeader = readHeader(dstFile);
  assert.equal(dstHeader.cwd, sandbox, 'copied header cwd rewritten to sandbox');
  // original in the real home must be untouched
  assert.equal(readHeader(path.join(s1, 'session.jsonl.zstd')).cwd, realCwd);
});

test('encodeCwdDir follows the harness rule (expected values derived by hand, not read back from the function)', () => {
  assert.equal(encodeCwdDir('C:\\Users\\Jane'), '--C-Users-Jane--');
  assert.equal(encodeCwdDir('C:\\Users\\Jane\\Desktop'), '--C-Users-Jane-Desktop--');
  // printable ASCII is kept verbatim, INCLUDING '-' and '~'
  assert.equal(encodeCwdDir('D:\\My-Drive\\a~b'), '--D-My-Drive-a~b--');
  // non-ASCII -> ~XXXX per code unit (4 uppercase hex, NO closing tilde);
  // space is U+0020 and is NOT kept: 我=6211 的=7684 ' '=0020 项=9879 目=76EE
  assert.equal(encodeCwdDir('D:\\Work\\我的 项目'), '--D-Work-~6211~7684~0020~9879~76EE--');
  assert.equal(encodeCwdDir('/home/alice/proj'), '--home-alice-proj--');
});

test('plain (uncompressed) session.jsonl is discovered and header-readable (P2-9)', (t) => {
  const home = mkHome(t);
  const s1 = path.join(home, 'sessions', '--ws--', 'session-plain');
  fs.mkdirSync(s1, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'header', version: 4, id: 'session-plain', cwd: home }),
    JSON.stringify({ type: 'turn/start', seq: 1, time: 't', data: {} }),
  ];
  fs.writeFileSync(path.join(s1, 'session.jsonl'), lines.join('\n') + '\n');
  const { sessions } = discoverSessions(home);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].maxGen, 0);
  assert.equal(sessions[0].header.id, 'session-plain');
  assert.equal(sessions[0].headerError, undefined);
});

test('selection is stratified: presets get a proportional share but still drill LAST (round 4)', (t) => {
  const home = mkHome(t);
  const mk = (name, preset, mtimeSec) => {
    const dir = path.join(home, 'sessions', '--ws--', name);
    fs.mkdirSync(dir, { recursive: true });
    makeSessionFile(dir, null, { version: 0, id: name, cwd: home, preset });
    // Preset sessions are made the NEWEST: under the old tail-graded sampler
    // they still lost their mtime advantage to the preset flag. Now they get a
    // proportional share, so this fixture pins BOTH halves of the behaviour.
    fs.utimesSync(path.join(dir, 'session.jsonl.zstd'), mtimeSec, mtimeSec);
  };
  for (let i = 0; i < 4; i++) mk(`session-plain${i}`, undefined, 1000);
  for (let i = 0; i < 2; i++) mk(`session-pres${i}`, 'danger-full-access', 9000 + i);

  const { sessions } = discoverSessions(home);
  assert.equal(sessions.filter((s) => s.header.agentPreset).length, 2);

  const small = classify(sessions, { sample: 3, includePreset: true });
  assert.equal(small.selected.length, 3);
  assert.ok(small.selected.filter((s) => s.presetPatched).length >= 1, 'a 3-session sample must reach the preset stratum');
  assert.ok(small.selected[small.selected.length - 1].presetPatched, 'presets still ORDER last for drilling');
  assert.deepEqual(small.strata, { plain: 4, preset: 2 });

  const half = classify(sessions, { sample: 6, includePreset: true });
  assert.equal(half.selected.filter((s) => s.presetPatched).length, 2, 'proportional share of a 2/6 stratum');

  // The property that matters: presets are guaranteed representation, but never
  // at the cost of starving the plain stratum (proportional fill did exactly
  // that and turned 2 write-round PASS into 2 inconclusive).
  const five = classify(sessions, { sample: 5, includePreset: true });
  assert.equal(five.selected.length, 5);
  assert.equal(five.selected.filter((s) => !s.presetPatched).length, 4, 'ALL plain sessions are taken before presets expand');
  assert.equal(five.selected.filter((s) => s.presetPatched).length, 1, 'preset floor is one slot, not a proportional share');

  const skipMode = classify(sessions, { sample: 99, includePreset: false });
  assert.equal(skipMode.selected.filter((s) => s.presetPatched).length, 0);
  assert.equal(skipMode.skipped.preset.length, 2);
});
