// Read-only ASAR archive access for desktop runtime probing.
//
// Format (validated against a real official package on 2026-10-05: the
// 0.2.0-rc.2 win-x64 install, 121,348,951 B archive with a 3,392,064 B
// header): an 8-byte size pickle (uint32 = 4, then uint32 = header pickle
// bytes), the header pickle (uint32 payload size, uint32 string length,
// then the JSON file table), and file data starting at 8 +
// headerPickleBytes. Each entry carries `size`, a decimal-string `offset`,
// and optional `unpacked` / `link` markers.
//
// Safety posture: READ-ONLY via openSync/readSync with partial reads (the
// official app.asar is ~121 MB with a ~3.2 MB header — never read it whole);
// every failure mode returns null so callers cannot distinguish a probe miss
// from a parse error ("not found" either way); `unpacked` and `link` entries
// are misses too — no cross-container stitching; paths are `/`-separated and
// empty, `.`, and `..` segments are rejected (mirrors the upstream
// runtimePath discipline). The header size is capped at ~19x the measured
// official 0.2.0-rc.2 header (3,392,064 B on 2026-10-05) so upstream growth
// is tolerated but unbounded reads are not.

import fs from 'node:fs';

export const ASAR_HEADER_CAP_BYTES = 64 * 1024 * 1024;

function readExact(fd, buf, position) {
  let read = 0;
  while (read < buf.length) {
    const n = fs.readSync(fd, buf, read, buf.length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
  return read;
}

/**
 * Read one in-archive file. Returns a Buffer, or null for: absent archive,
 * malformed header, rejected path, directory entries, and `unpacked`/`link`
 * entries — callers treat null as "not available here".
 */
export function readAsarFile(archivePath, internalPath) {
  let fd;
  try {
    const segments = String(internalPath ?? '').split('/');
    if (!internalPath || segments.some((s) => s === '' || s === '.' || s === '..')) return null;

    fd = fs.openSync(archivePath, 'r');
    const fileSize = fs.fstatSync(fd).size;

    const b8 = Buffer.alloc(8);
    if (readExact(fd, b8, 0) !== 8) return null;
    if (b8.readUInt32LE(0) !== 4) return null;
    const headerPickleSize = b8.readUInt32LE(4);
    if (!Number.isSafeInteger(headerPickleSize) || headerPickleSize < 8 || headerPickleSize > ASAR_HEADER_CAP_BYTES) return null;
    if (8 + headerPickleSize > fileSize) return null;

    const hb = Buffer.alloc(headerPickleSize);
    if (readExact(fd, hb, 8) !== headerPickleSize) return null;
    if (hb.readUInt32LE(0) !== headerPickleSize - 4) return null;
    const jsonLen = hb.readUInt32LE(4);
    if (!Number.isSafeInteger(jsonLen) || jsonLen < 0 || 8 + jsonLen > headerPickleSize) return null;
    let header;
    try {
      header = JSON.parse(hb.slice(8, 8 + jsonLen).toString('utf8'));
    } catch {
      return null;
    }
    if (!header || typeof header !== 'object' || !header.files) return null;

    let node = header;
    for (const seg of segments) {
      node = node?.files?.[seg];
      if (!node || typeof node !== 'object') return null;
    }
    if (node.files || node.unpacked || node.link !== undefined) return null;
    const size = node.size;
    const off = typeof node.offset === 'string' ? Number(node.offset) : NaN;
    if (!Number.isSafeInteger(size) || size < 0) return null;
    if (!Number.isSafeInteger(off) || off < 0) return null;

    const dataOffset = 8 + headerPickleSize;
    if (dataOffset + off + size > fileSize) return null;
    const buf = Buffer.alloc(size);
    if (size > 0 && readExact(fd, buf, dataOffset + off) !== size) return null;
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}
