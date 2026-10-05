// Multi-frame zstd reader.
//
// Why this exists: dsh session logs (session.vN.jsonl[.zstd]) are MULTI-FRAME
// zstd files — one frame per write batch. Node's zlib zstdDecompressSync /
// createZstdDecompress silently decode ONLY the first frame and do not error
// (verified 2026-10-02: a 3,776,880-byte v4 log decoded to 233 bytes / 1 line
// via zlib, while manual frame splitting yields 1,395 frames / 3,005 lines).
// Any tool that reads session logs with plain zlib will silently see "one
// line" — this module is the guard against that failure mode.
//
// Frame boundaries cannot be obtained from zlib (it stops after frame one),
// so we split on the zstd magic (0x28 B5 2F FD). A magic sequence can in
// principle occur inside compressed payload, so occurrences are treated as
// CANDIDATE boundaries with backtracking: a candidate is accepted when the
// frame decodes cleanly and the remainder recursively decodes; otherwise the
// frame is extended to the next candidate.

import { zstdDecompressSync } from 'node:zlib';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function isMagicAt(buf, i) {
  return i + 4 <= buf.length && buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd;
}

/** Offsets of all magic occurrences (candidate frame starts). Precomputed once. */
export function magicOffsets(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (isMagicAt(buf, i)) out.push(i);
  }
  return out;
}

/**
 * Decode a multi-frame zstd buffer to a single Buffer.
 * Backtracks over ambiguous magic occurrences. Throws on unrecoverable input.
 */
export function decodeAll(buf) {
  if (!buf || buf.length === 0) throw new Error('empty zstd input');
  const offsets = magicOffsets(buf);
  const parts = [];
  const failed = new Set();
  if (!decodeFrom(buf, 0, offsets, 0, parts, failed)) {
    // Fallback: single frame spanning everything (payload may contain a magic
    // sequence that breaks naive splitting, or the file is simply one frame).
    return zstdDecompressSync(buf);
  }
  return Buffer.concat(parts);
}

// idx: pointer into `offsets` — next candidate boundary strictly greater than `start`.
function decodeFrom(buf, start, offsets, idx, parts, failed) {
  if (start >= buf.length) return true;
  let i = idx;
  while (i < offsets.length && offsets[i] <= start) i++;
  // Candidates: each subsequent magic, then end-of-buffer.
  for (; i <= offsets.length; i++) {
    const end = i < offsets.length ? offsets[i] : buf.length;
    if (end <= start) continue;
    // String key: numeric start*2^32+end exceeds MAX_SAFE_INTEGER for files
    // >~2.1MB, silently merging distinct failed boundaries.
    const key = `${start}:${end}`;
    if (failed.has(key)) continue;
    let decoded;
    try {
      decoded = zstdDecompressSync(buf.subarray(start, end));
    } catch {
      failed.add(key);
      continue;
    }
    // Accept the boundary only if the remainder also fully decodes.
    parts.push(decoded);
    if (decodeFrom(buf, end, offsets, i + (end < buf.length ? 1 : 0), parts, failed)) return true;
    // Remainder failed: this boundary is a dead end — undo and extend the frame.
    failed.add(key);
    parts.pop();
  }
  return false;
}

/** Decode to UTF-8 text and split into non-empty lines. */
export function decodeLines(buf) {
  return decodeAll(buf)
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Frame count for tests / sanity checks. */
export function frameCount(buf) {
  return magicOffsets(buf).length;
}
