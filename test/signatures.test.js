// Failure-signature regression locks (docs/FAILURE_MODES.md).
//
// Each signature gets a PAIR: the real log line must hit, a healthy line must
// not. Log lines below are copied from their cited source, not written to pass
// the regex — where no real line exists yet, the entry is marked `template` and
// the doc says so.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { matchSignatures, WRITE_FAIL_SIGNATURES } from '../src/lib/drill.js';
import { BOOT_SIGNATURES } from '../src/commands/run.js';

// dsh-desktop#1294 body, timeline row at 16:04:34 (verbatim):
//   patch: entry "llm-commandcode" not found / patch: entry "mnemon" not found
const REAL_1294 = 'dsh: patch: entry "llm-commandcode" not found\nnode:events:502';
// dsh-desktop#1229 title, verbatim quoted message:
const REAL_1229 = 'Error: format v4 message requires a producer-owned source kind';
// a healthy keyless boot boundary — must not hit any failure signature:
const HEALTHY_BOOT = 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key\n    at file:///x/lib/index.js:10:5';
// a healthy migrated session opening:
const HEALTHY_SESSION = 'session.v4.jsonl.zstd published, seq 0..1697, turn/end reason=completed';

const hits = (sigs, line) => sigs.filter((s) => s.pattern.test(line)).map((s) => s.id);

test('#1294 boot signature hits the real log line and not a healthy one', () => {
  assert.deepEqual(hits(BOOT_SIGNATURES, REAL_1294), ['patch-entry-not-found']);
  for (const s of BOOT_SIGNATURES) {
    assert.equal(s.pattern.test(HEALTHY_BOOT), false, `${s.id} must not fire on a healthy keyless boot`);
  }
});

test('#1229 write signature hits the real message and not healthy artifacts', () => {
  const sigs = matchSignatures(REAL_1229);
  assert.deepEqual(sigs.map((s) => s.id), ['v4-producer-source-kind']);
  assert.equal(sigs[0].severity, 'high');
  assert.deepEqual(matchSignatures(HEALTHY_SESSION), []);
  assert.deepEqual(matchSignatures(HEALTHY_BOOT), []);
});

test('generic boot signatures stay specific to their own failures', () => {
  assert.deepEqual(hits(BOOT_SIGNATURES, 'Error: listen EADDRINUSE: address already in use :::3000'), ['port-in-use']);
  assert.deepEqual(hits(BOOT_SIGNATURES, "Error: Cannot find module '@deepseek-ai/dsh-headless'"), ['module-missing']);
});

test('warn-only signatures match their host template and never claim incompatibility', () => {
  // template-derived: both were read out of the host's own message text and
  // have never fired in a rehearsal on this machine — docs/FAILURE_MODES.md 三
  const presetLine = 'dsh: session runs under agent preset "review-bot" which the one-shot runner does not compose';
  const cwdLine = 'dsh: session was recorded in /work/other, not /work/proj';
  assert.deepEqual(matchSignatures(presetLine).map((s) => s.id), ['preset-not-composed']);
  assert.deepEqual(matchSignatures(cwdLine).map((s) => s.id), ['cwd-mismatch']);
  for (const s of matchSignatures(presetLine).concat(matchSignatures(cwdLine))) {
    assert.equal(s.severity, 'warn', `${s.id} must stay warn: it reports a rehearsal defect, not a host incompatibility`);
  }
});

test('every detected signature id is listed in docs/FAILURE_MODES.md', () => {
  // otherwise the doc rots and an undocumented pattern becomes a silent
  // compatibility claim nobody reviewed.
  const doc = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'FAILURE_MODES.md'), 'utf8');
  const all = [...WRITE_FAIL_SIGNATURES, ...BOOT_SIGNATURES];
  assert.ok(all.length >= 6, 'signature inventory shrank');
  for (const s of all) assert.ok(doc.includes('`' + s.id + '`'), `${s.id} is detected in code but missing from docs/FAILURE_MODES.md`);
});
