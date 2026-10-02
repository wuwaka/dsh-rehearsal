// zfstd: multi-frame decoding with the naive-zlib regression guard.
// The real-world trigger (reviews, 2026-10-02): a 3,776,880-byte v4 session
// log that plain zlib reads as 233 bytes / 1 line. The fixture reproduces the
// shape (one zstd frame per JSONL line, 1400 frames ≈ the real 1395) with
// synthetic data only — no user content in tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { decodeAll, decodeLines, frameCount } from '../src/lib/zfstd.js';
import { zstdDecompressSync } from 'node:zlib';

function makeFrames(n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const line = JSON.stringify({ type: i === 0 ? 'header' : i % 2 ? 'turn/start' : 'turn/end', seq: i, time: 't', data: { i, pad: 'x'.repeat(40) } });
    parts.push(zstdCompressSync(Buffer.from(line + '\n', 'utf8')));
  }
  return Buffer.concat(parts);
}

test('multi-frame: 1400 synthetic frames decode fully, seq contiguous', () => {
  const buf = makeFrames(1400);
  assert.equal(frameCount(buf), 1400);
  const lines = decodeLines(buf);
  assert.equal(lines.length, 1400);
  const seqs = lines.map((l) => JSON.parse(l).seq);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1);
});

test('regression: naive whole-buffer zlib decode silently returns only the first frame', () => {
  const buf = makeFrames(50);
  const naive = zstdDecompressSync(buf).toString('utf8').split('\n').filter(Boolean);
  assert.ok(naive.length < 50, 'expected the naive path to under-read (this guard fails if Node ever fixes multi-frame support — then zfstd can simplify)');
  assert.equal(decodeLines(buf).length, 50);
});

test('single-frame file decodes', () => {
  const buf = zstdCompressSync(Buffer.from('{"type":"header","seq":0}\n', 'utf8'));
  assert.equal(decodeLines(buf).length, 1);
});

test('empty payload edge: zero frames -> decodeAll throws', () => {
  assert.throws(() => decodeAll(Buffer.alloc(0)));
});
