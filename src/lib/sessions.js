// Session-library discovery, sampling and the shadow copy set.
//
// Constraints learned from reviews + hands-on verification (2026-10-02):
//  - headers live in the FIRST frame of the oldest generation file
//  - sessions whose header carries agentPreset are refused by the one-shot
//    runner ("runs under agent preset X, which the one-shot runner does not
//    compose") — sampled accordingly, never silently dropped
//  - the process cwd must equal the session's recorded cwd, else open fails
//  - workspace directory names under sessions/ are pre-encoded from the cwd
//    (e.g. ~6211~7684 for two non-ASCII code units) — we always reuse the
//    on-disk name verbatim instead of reimplementing the encoding
//  - side data lives OUTSIDE the session dir: storages/session_projcache
//    (two coexisting shapes on disk) + workspace.json; .credentials.yaml is
//    never copied
//  - attachments live under ~/.dsh/attachments with an unverified layout in
//    v1 — not copied; read-side attachment checks are therefore omitted (and
//    reported as such) rather than faked

import fs from 'node:fs';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { decodeAll } from './zfstd.js';

const GEN_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

export function discoverSessions(home) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return { root, sessions: [] };
  const sessions = [];
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const sDir = path.join(wsDir, s.name);
      const gens = [];
      for (const f of fs.readdirSync(sDir)) {
        const m = f.match(GEN_RE);
        if (m) gens.push({ file: f, gen: m[1] ? Number(m[1]) : 0, path: path.join(sDir, f) });
      }
      if (!gens.length) continue;
      gens.sort((a, b) => a.gen - b.gen);
      const header = readHeader(gens[0].path);
      sessions.push({
        sessionId: s.name,
        workspaceDirName: ws.name,
        dir: sDir,
        generations: gens,
        maxGen: gens[gens.length - 1].gen,
        header,
        mtimeMs: fs.statSync(gens[gens.length - 1].path).mtimeMs,
        bytes: gens.reduce((acc, g) => acc + fs.statSync(g.path).size, 0),
      });
    }
  }
  return { root, sessions };
}

/** Header = first JSON line of the oldest generation (zstd or plain JSONL). */
export function readHeader(file) {
  try {
    const buf = fs.readFileSync(file);
    const isZstd = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
    const text = isZstd ? decodeAll(buf).toString('utf8') : buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && (obj.version !== undefined || obj.cwd || obj.id)) return obj;
      } catch {
        /* not the header line; keep scanning (first frame should hold it) */
      }
    }
    return { parseError: 'no header-like line in first frame' };
  } catch (e) {
    return { parseError: String(e.message) };
  }
}

/**
 * Classify sessions for rehearsal:
 *  - drillable: not yet migrated to v4 and cwd resolvable. Sessions with an
 *    agentPreset are only drillable when the caller passes includePreset
 *    (adoption-gate patch mode); they keep presetPatched: true so reports can
 *    label them honestly.
 *  - skipped: preset (unless included), cwd missing, already-v4
 *
 * Selection stratifies (audit round 4) so preset-carrying sessions can never
 * be zero-selected again: the tail-graded sampler let `--preset-mode patch`
 * claim a gate it never exercised (presets were 38/52 on a real machine).
 * But PROPORTIONAL fill was wrong too — it shrank the plain stratum from 9 to
 * 3 at --sample 9, and preset sessions cannot produce a conclusive write round
 * (the replay adapter does not intercept them: MISSING_CREDENTIAL), so the
 * write evidence went from 2 PASS to 2 inconclusive. Rule used instead: plain
 * sessions fill the sample first, presets take the remainder with a floor of
 * one. Drill ORDER still puts presets last.
 */
export function classify(sessions, { sample, full = false, includePreset = false } = {}) {
  const drillable = [];
  const skipped = { preset: [], cwdMissing: [], alreadyV4: [], headerError: [] };
  for (const s of sessions) {
    if (s.header?.parseError) {
      skipped.headerError.push(s);
      continue;
    }
    if (s.maxGen >= 4) {
      skipped.alreadyV4.push(s);
      continue;
    }
    const cwdOk = typeof s.header?.cwd === 'string' && s.header.cwd !== '';
    if (s.header?.agentPreset) {
      if (includePreset && cwdOk) {
        s.presetPatched = true;
        drillable.push(s);
      } else {
        skipped.preset.push(s);
      }
      continue;
    }
    if (!cwdOk) {
      skipped.cwdMissing.push(s);
      continue;
    }
    drillable.push(s);
  }
  // preset-patched sessions drill last (they carry the patched-gate caveat)
  drillable.sort((a, b) => Number(Boolean(a.presetPatched)) - Number(Boolean(b.presetPatched)) || b.mtimeMs - a.mtimeMs);
  const byNewest = (a, b) => b.mtimeMs - a.mtimeMs;
  const plain = drillable.filter((s) => !s.presetPatched);
  const preset = drillable.filter((s) => s.presetPatched);
  const target = full ? drillable.length : Math.min(Number(sample) || drillable.length, drillable.length);
  let selected;
  if (target >= drillable.length || !plain.length || !preset.length) {
    selected = drillable.slice(0, target);
  } else {
    // Plain first (it is the only stratum that can yield a conclusive write
    // round), presets get the remainder and never fewer than one slot.
    const presetQuota = Math.min(preset.length, Math.max(1, target - Math.min(plain.length, target - 1)));
    const plainQuota = target - presetQuota;
    selected = [...plain.slice(0, plainQuota), ...preset.slice(0, presetQuota)];
    // both strata are already newest-first (inherited from `drillable`)
    selected.sort((a, b) => Number(Boolean(a.presetPatched)) - Number(Boolean(b.presetPatched)) || byNewest(a, b));
  }
  return { drillable, selected, skipped, strata: { plain: plain.length, preset: preset.length } };
}

/**
 * Encode a cwd into the harness's sessions/<workspaceDir> directory name.
 * Rules: split on [:/\\], drop empty segments, printable ASCII (0x21-0x7E)
 * kept as-is (including `-` and `~`), every other code unit (NOTABLY the
 * space, U+0020) -> `~XXXX` — four uppercase hex digits, NO closing tilde —
 * joined with `-`, wrapped in `--`.
 * Ground truth for the rule (derived from real on-disk names, examples here
 * are synthetic so the repo carries no user directory structure):
 *   C:\Users\Jane              -> --C-Users-Jane--
 *   D:\Work\我的 项目            -> --D-Work-~6211~7684~0020~9879~76EE--
 * Only used for OUR controlled sandbox paths (ASCII), so surrogate/BMP edge
 * cases cannot appear.
 */
export function encodeCwdDir(cwd) {
  const segs = String(cwd).split(/[:\\/]+/).filter((s) => s !== '');
  const enc = segs
    .map((seg) => seg.replace(/[^\x21-\x7E]/g, (ch) => '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')))
    .join('-');
  return `--${enc}--`;
}

/**
 * Copy the rehearsal set into the shadow home.
 * Never touches ~/.dsh/.credentials.yaml.
 *
 * SAFETY (audit P0-1): every copied generation's header `cwd` is rewritten to
 * a private sandbox directory under the shadow home, AND the copy is moved
 * into a workspace dir named by encodeCwdDir(sandbox) — the harness derives
 * the session's physical path from header.cwd, so both must change together
 * or the log is rejected as corrupt ("header id and cwd identify ...").
 * Callers launch processes with `shadowCwd`. seq/type/turn integrity is
 * unaffected — the header is not seq-numbered.
 */
export function copySet(realHome, shadowHome, sessions) {
  const copied = [];
  const shadowCwd = new Map();
  sessions.forEach((s, i) => {
    const sandboxCwd = path.join(shadowHome, 'workspace', String(i));
    fs.mkdirSync(sandboxCwd, { recursive: true });
    const wsName = encodeCwdDir(sandboxCwd);
    const dst = path.join(shadowHome, 'sessions', wsName, s.sessionId);
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(s.dir, dst, { recursive: true });
    for (const g of s.generations) {
      rewriteHeaderCwd(path.join(dst, g.file), sandboxCwd);
    }
    s.shadowCwd = sandboxCwd;
    s.shadowWsName = wsName;
    shadowCwd.set(s.sessionId, sandboxCwd);
    copied.push(s.sessionId);
  });
  // Side data: both observed projcache shapes + workspace registry.
  const side = [];
  const projDir = path.join(realHome, 'storages', 'session_projcache');
  if (fs.existsSync(projDir)) {
    fs.cpSync(projDir, path.join(shadowHome, 'storages', 'session_projcache'), { recursive: true });
    side.push('storages/session_projcache/');
  }
  const projFlat = path.join(realHome, 'storages', 'session_projcache.json');
  if (fs.existsSync(projFlat)) {
    fs.mkdirSync(path.join(shadowHome, 'storages'), { recursive: true });
    fs.copyFileSync(projFlat, path.join(shadowHome, 'storages', 'session_projcache.json'));
    side.push('storages/session_projcache.json');
  }
  const ws = path.join(realHome, 'storages', 'workspace.json');
  if (fs.existsSync(ws)) {
    fs.mkdirSync(path.join(shadowHome, 'storages'), { recursive: true });
    fs.copyFileSync(ws, path.join(shadowHome, 'storages', 'workspace.json'));
    side.push('storages/workspace.json');
  }
  return { copied, side, shadowCwd };
}

/**
 * Replace the `cwd` field of the FIRST line (the header) of a copied session
 * generation with the sandbox path. Fully multi-frame decode + single-frame
 * recompress — valid zstd either way.
 */
export function rewriteHeaderCwd(file, newCwd) {
  if (!fs.existsSync(file)) return false;
  const text = decodeAll(fs.readFileSync(file)).toString('utf8');
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.trim() !== '');
  if (idx < 0) return false;
  let header;
  try {
    header = JSON.parse(lines[idx]);
  } catch {
    return false;
  }
  if (!header || typeof header !== 'object' || header.cwd === undefined) return false;
  header.cwd = newCwd;
  lines[idx] = JSON.stringify(header);
  // Re-emit ONE ZSTD FRAME PER LINE (the native writer's framing): the
  // official decoder rejects any file whose first frame is not exactly the
  // header line ("corrupt Zstandard session log: first frame is not exactly
  // one header line"), so a single recompressed frame would poison the copy.
  const frames = [];
  for (const l of lines) {
    if (l === '' && frames.length === lines.length - 1) continue; // trailing empty from final \n
    frames.push(zstdCompressSync(Buffer.from(l + '\n', 'utf8')));
  }
  fs.writeFileSync(file, Buffer.concat(frames));
  return true;
}
