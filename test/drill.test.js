// drill: stderr sanitization (P1-1 + round-3 tightening), tool pre-screen
// allowlist (P0-1 + round-3 fail-open fix), tool/result forensics, and
// bidirectional turn balance (P2-2). Also guards the assumed-context-window
// constant against re-scattering into a second magic literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  sanitizeStderr, firstDiagnostic, isDiagnostic,
  extractHistoryTools, classifyHistory, WRITE_CLASS_TOOLS, READONLY_TOOLS,
  classifyToolResults, readIntegrity, writeRoundVerdict,
} from '../src/lib/drill.js';
import { ASSUMED_CONTEXT_WINDOW_TOKENS } from '../src/lib/util.js';

test('sanitizeStderr drops replayed prose, keeps diagnostics (P1-1)', () => {
  const stderr = [
    'dsh: reasoning:',
    'first compose a synthetic assistant sentence that must never survive.', // prose -> dropped
    'then run the next synthetic step immediately.', // prose -> dropped
    'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key', // kept
    '    at file:///C:/x/lib/index.js:10:5', // kept via file://
  ].join('\n');
  const s = sanitizeStderr(stderr);
  assert.ok(!/synthetic assistant sentence|synthetic step/.test(s.summary), 'prose must not survive');
  assert.ok(/MISSING_CREDENTIAL/.test(s.summary), 'diagnostics must survive');
  assert.ok(/file:\/\//.test(s.summary), 'file:// stack evidence survives');
  assert.equal(s.dropped, 3, 'reasoning header + 2 prose lines counted as dropped');
});

test('round-3 leak path 1: joined `dsh: reasoning: | …prose` single line dies (no $ anchor)', () => {
  const joined = 'dsh: reasoning: | synthetic completion of a long turn. Done. | Report three steps briefly.';
  const s = sanitizeStderr(joined);
  assert.equal(s.dropped, 1);
  assert.ok(!/synthetic completion/.test(s.summary));
  // consistency: firstDiagnostic and sanitizeStderr share isDiagnostic
  assert.equal(firstDiagnostic(joined), undefined);
  assert.equal(isDiagnostic(joined), false);
});

test('round-3 leak path 2: prose starting with `at ` or `fail` dies', () => {
  const s = sanitizeStderr([
    'at the beginning we should check the file', // English prose — used to survive via `at\s`
    'failure to parse the record', // prose — used to survive via bare `fail`
    'dsh: Error: real diagnostic',
  ].join('\n'));
  assert.ok(!/beginning we should check|failure to parse/.test(s.summary));
  assert.ok(/Error: real diagnostic/.test(s.summary));
  assert.equal(s.dropped, 2);
});

test('firstDiagnostic skips reasoning marker and returns diagnostics', () => {
  const stderr = ['dsh: reasoning:', 'prose here', '    at file:///x.js:1:1', 'dsh: MISSING_CREDENTIAL: no API key'].join('\n');
  assert.equal(firstDiagnostic(stderr), 'dsh: MISSING_CREDENTIAL: no API key');
  assert.equal(firstDiagnostic('only prose\nmore prose'), undefined, 'prose-only stderr yields no diagnostic');
});

test('extractHistoryTools covers ALL four row shapes (census: run_code lives in dispatch rows)', () => {
  const text = [
    JSON.stringify({ type: 'session', seq: 0, data: {} }),
    JSON.stringify({ type: 'tool/call', seq: 1, data: { name: 'pwsh', arguments: '{}' } }),
    JSON.stringify({ type: 'tool-call-chunks', seq0: 2, data: { name: 'computer_script' } }),
    JSON.stringify({ type: 'tool/ptc-dispatch', seq: 3, data: { name: 'dtodo', isError: false } }),
    JSON.stringify({ type: 'tool/code-dispatch', seq: 4, data: { name: 'memory', arguments: {} } }),
    JSON.stringify({ type: 'tool/code-dispatch-start', seq: 5, data: { name: 'run_code' } }),
    JSON.stringify({ type: 'tool/call', seq: 6, data: { arguments: '{}' } }), // no name -> fail closed
    JSON.stringify({ type: 'tool/result', seq: 7, data: {} }), // results never carry tool identity
    'garbage-line',
  ].join('\n');
  const names = extractHistoryTools(text).sort();
  assert.deepEqual(names, ['__unnamed__', 'computer_script', 'dtodo', 'memory', 'pwsh', 'run_code']);
});

test('round-3 allowlist: mcp__/write-class/unknown all block; known read-only passes', () => {
  // the census names that used to slip through the denylist
  for (const t of ['mcp__chrome-devtools-mcp__evaluate_script', 'mcp__playwright-mcp__browser_navigate', 'job_kill', 'present', 'memory', 'dtodo', 'compress', '__unnamed__']) {
    const c = classifyHistory([t]);
    assert.equal(c.ok, false, `${t} must block`);
  }
  // known readonly
  assert.equal(classifyHistory(['read', 'glob', 'grep', 'read_image', 'web_fetch']).ok, true);
  // empty history (no tools at all) is drillable
  assert.equal(classifyHistory([]).ok, true);
  // mixed: one unknown poisons the whole session
  assert.equal(classifyHistory(['read', 'memory']).ok, false);
  const c = classifyHistory(['read', 'mcp__x__y']);
  assert.deepEqual(c.writeClass, ['mcp__x__y']);
  assert.equal(c.unknown.length, 0);
  const c2 = classifyHistory(['read', 'compress']);
  assert.deepEqual(c2.unknown, ['compress']);
  // run_code stays write-class
  assert.ok(WRITE_CLASS_TOOLS.has('run_code'));
  assert.ok(READONLY_TOOLS.has('read_image')); // the two PASS demos' tool
});

test('classifyToolResults buckets error-flagged / unknown-toolish / other', () => {
  const rows = [
    { type: 'tool/result', data: { isError: true } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'tool "x" not registered' }] } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'turn/end', data: {} },
  ];
  assert.deepEqual(classifyToolResults(rows), { total: 3, errorFlagged: 1, unknownToolish: 1, other: 1 });
});

test('readIntegrity flags a stray turn/end (P2-2, no clamping)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-int-'));
  const rows = [
    JSON.stringify({ type: 'session', seq: 0, time: 't', data: {} }),
    JSON.stringify({ type: 'turn/end', seq: 1, time: 't', data: { reason: { kind: 'completed' } } }),
  ];
  const f = path.join(tmp, 'session.v4.jsonl.zstd');
  fs.writeFileSync(f, Buffer.concat(rows.map((l) => zstdCompressSync(Buffer.from(l + '\n', 'utf8')))));
  const r = readIntegrity(f);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /stray turn\/end/.test(i.error)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readIntegrity passes a balanced turn pair', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrh-int2-'));
  const rows = [
    JSON.stringify({ type: 'session', seq: 0, time: 't', data: {} }),
    JSON.stringify({ type: 'turn/start', seq: 1, time: 't', data: {} }),
    JSON.stringify({ type: 'turn/end', seq: 2, time: 't', data: { reason: { kind: 'completed' } } }),
  ];
  const f = path.join(tmp, 'session.v4.jsonl.zstd');
  fs.writeFileSync(f, Buffer.concat(rows.map((l) => zstdCompressSync(Buffer.from(l + '\n', 'utf8')))));
  assert.equal(readIntegrity(f).ok, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('writeRoundVerdict: preset-only rounds cannot decide the stage (round 4)', () => {
  const R = (verdict, preset = false) => ({ verdict, preset });
  assert.equal(writeRoundVerdict({ mountOk: false, results: [R('pass')] }), 'inconclusive');
  assert.equal(writeRoundVerdict({ mountOk: true, results: [] }), 'skip');
  // The regression this guards: stratified sampling put presets into the write
  // pool, and 2/2 preset rounds come back inconclusive because replay never
  // intercepts their route. Before: PASS + inconclusive dragged the whole
  // stage to inconclusive and hid the one conclusive result.
  assert.equal(writeRoundVerdict({ results: [R('pass'), R('inconclusive', true)] }), 'pass', 'a plain pass is not spoiled by a structurally inconclusive preset round');
  assert.equal(writeRoundVerdict({ results: [R('inconclusive', true), R('inconclusive', true)] }), 'inconclusive', 'preset-only attempts yield no write evidence at all');
  assert.equal(writeRoundVerdict({ results: [R('pass'), R('fail', true)] }), 'fail', 'any fail still blocks');
  assert.equal(writeRoundVerdict({ results: [R('inconclusive'), R('pass')] }), 'inconclusive', 'a plain inconclusive is real uncertainty');
});

test('the assumed context window lives in exactly one place', () => {
  // Regression lock: 256000 used to sit as a bare literal in drill.js
  // (extractRoutes' default model entry) and again in shadow.js (the settings
  // serializer's fallback). It must exist only as ASSUMED_CONTEXT_WINDOW_TOKENS
  // in util.js, and both consumers must reference the named constant.
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');
  const files = ['src/lib/util.js', 'src/lib/drill.js', 'src/lib/shadow.js'];
  const hits = [];
  for (const f of files) {
    src(f).split(/\r?\n/).forEach((l, i) => {
      if (/256000/.test(l)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, ['src/lib/util.js:' + (src('src/lib/util.js').split(/\r?\n/).findIndex((l) => l.includes('ASSUMED_CONTEXT_WINDOW_TOKENS =')) + 1)],
    `the literal must appear only at the constant's definition, found: ${hits.join(', ')}`);
  assert.equal(ASSUMED_CONTEXT_WINDOW_TOKENS, 256000);
  assert.match(src('src/lib/drill.js'), /ASSUMED_CONTEXT_WINDOW_TOKENS/, 'drill.js must use the named constant');
  assert.match(src('src/lib/shadow.js'), /ASSUMED_CONTEXT_WINDOW_TOKENS/, 'shadow.js must use the named constant');
});
