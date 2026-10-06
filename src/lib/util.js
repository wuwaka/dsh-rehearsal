// Shared helpers: process spawning with strict stdout/stderr separation,
// keyless/telemetry-safe environment, version-option validation, directory
// ownership markers, and small logging utilities.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { spawnSync } from 'node:child_process';

/**
 * Assumed model context window (tokens) when a session's recorded routes do
 * not carry one: `extractRoutes` writes it into every discovered model entry,
 * and the shadow settings serializer falls back to it for falsy values. The
 * replay adapter needs a number for the provider catalog; the value is an
 * assumption about the DeepSeek window, not a measured fact, so it lives in
 * exactly one place (a source-grep test pins that).
 */
export const ASSUMED_CONTEXT_WINDOW_TOKENS = 256000;

/**
 * Run a command. stdout and stderr are NEVER merged: the candidate dsh CLI
 * prints warnings on stderr while writing valid JSON to stdout, and
 * `--dump-config-schema` exits 1 even on success — so exit codes alone are
 * never a verdict. Callers decide verdicts from artifacts.
 */
export function run(cmd, args, { cwd, env, timeoutMs = 180000, shell = false, retries = 3 } = {}) {
  // Some hosts intermittently return transient ENOENT on CreateProcess
  // (AV scan or an update window holding the executable). Retry the spawn
  // itself; only real failures bubble up.
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = spawnSync(cmd, args, {
      cwd,
      // When env is provided it is the COMPLETE child environment (see
      // shadowEnv): never merge process.env back in, or stripped secrets
      // would be re-injected.
      env: env ?? process.env,
      encoding: 'buffer',
      timeout: timeoutMs,
      windowsHide: true,
      shell,
    });
    if (!(r.error && r.error.code === 'ENOENT' && r.status === null) || attempt === retries) {
      return {
        code: r.status,
        killed: Boolean(r.error && r.error.killed) || r.signal != null,
        stdout: (r.stdout || '').toString('utf8'),
        stderr: (r.stderr || '').toString('utf8'),
        error: r.error ? String(r.error.message || r.error) : null,
      };
    }
    last = r;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  const r = last;
  return {
    code: r.status,
    killed: Boolean(r.error && r.error.killed) || r.signal != null,
    stdout: (r.stdout || '').toString('utf8'),
    stderr: (r.stderr || '').toString('utf8'),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

/**
 * Keyed environments for child processes. Both return the COMPLETE child
 * environment (callers must not merge process.env back in): the parent
 * process is never mutated, and every credential-shaped variable (API_KEY /
 * TOKEN / SECRET / CREDENTIAL / PASSWORD / PRIVATE_KEY / AUTH) is stripped
 * rather than only DEEPSEEK_API_KEY. Reports record the REDACTED NAMES via
 * redactedEnvNames(), never values. Values that survive the name filter are
 * additionally scrubbed of URL-embedded userinfo credentials by
 * stripUrlCredentials() — proxies and registry endpoints commonly carry
 * inline credentials their NAME does not reveal.
 *
 * shadowEnv() additionally points DSH_HOME at a shadow home and disables
 * telemetry explicitly (candidate 0.2.0 defaults FEEDBACK_ONLY and OTLP
 * bypasses proxies).
 */
const SECRET_KEY = /API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|AUTH/i;

// The name filter errs on the side of REMOVING. Benign names can collide
// with the pattern (XAUTHORITY matches /AUTH/ and is dropped); a shadow
// child never needs X11 state, and over-removal keeps the guarantee
// one-sided. What the filter deliberately does NOT do is let a credential
// through because it hides inside a value — that half is stripUrlCredentials.
export function redactedEnvNames(env = process.env) {
  return Object.keys(env).filter((k) => SECRET_KEY.test(k)).sort();
}

/**
 * Strip embedded userinfo credentials from URL-shaped values:
 * https://user:token@registry.example.org/ → https://registry.example.org/.
 * Applied to every variable that survives the name filter — HTTP(S) proxy
 * and npm registry values are the common carriers. Unparseable or non-URL
 * values pass through unchanged. Query-string secrets are NOT covered and
 * no document claims otherwise: the guarantee is credential-shaped NAMES
 * plus URL userinfo, and it fails in the direction of removing.
 */
export function stripUrlCredentials(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let u;
  try { u = new URL(value); } catch { return value; }
  if (!u.username && !u.password) return value;
  u.username = '';
  u.password = '';
  return u.toString();
}

/**
 * A credential-stripped copy of the parent environment. Used wherever a
 * child runs host code that is not the candidate itself — notably the
 * `npm install` of the candidate: with `--run-scripts` the dependency
 * lifecycle scripts execute, and that escape hatch must not re-expose the
 * host's credential-shaped variables.
 */
export function sanitizedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_KEY.test(k)) continue;
    env[k] = stripUrlCredentials(v);
  }
  return env;
}

export function shadowEnv(shadowHome) {
  const env = sanitizedEnv();
  env.DSH_HOME = shadowHome;
  env.DSH_TELEMETRY_MODE = 'DISABLED';
  return env;
}

export function nowIso() {
  return new Date().toISOString();
}

export function stageTimer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

/** Attach a subverdict helper used by stages. */
export const VERDICT = {
  PASS: 'pass',
  FAIL: 'fail',
  WARN: 'warn',
  SKIP: 'skip',
  INCONCLUSIVE: 'inconclusive',
};

/**
 * Validate a version-valued CLI option (--candidate / --current / --to).
 * Absent (undefined/null) is allowed; the caller decides requiredness.
 * Everything else must be an exact semver string, because an unvalidated
 * version does not fail — it silently turns the peer comparison into "not
 * executed" and yields a clean-looking verdict (a `check --candidate
 * nonsense` run exits 0 with `upgrade-ok`).
 */
export function validateVersionOption(value, flag) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && semver.valid(value)) return value;
  throw new Error(`${flag} must be an exact semver version (e.g. 0.2.0-rc.2), got ${JSON.stringify(value)}`);
}

/**
 * Ownership markers for directories this tool creates and later prunes or
 * reuses. A directory is only written into (and only ever deleted) when it
 * is provably ours: the marker distinguishes "an empty dir the user pointed
 * --shadow-dir at" from "somebody's existing data that happens to sit at a
 * path we were handed".
 */
const OWNER_FILE = '.dsh-rehearsal-owner';
const OWNER_KINDS = Object.freeze({
  artifact: 'dsh-rehearsal-artifact-v1',
  shadow: 'dsh-rehearsal-shadow-v1',
  prefix: 'dsh-rehearsal-prefix-v1',
});

/** The marker string inside dir, or null when absent/unreadable/unknown. */
export function readOwner(dir) {
  try {
    const v = fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim();
    return Object.values(OWNER_KINDS).includes(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Claim a directory for one owned kind. Missing or empty directories are
 * adopted (marker written); a matching marker means reuse; anything else —
 * another kind's marker, a corrupt marker, or a non-empty unmarked
 * directory — returns false and the caller must refuse to use it.
 */
export function claimOwnedDir(dir, kind) {
  const want = OWNER_KINDS[kind];
  if (!want) throw new Error(`unknown owner kind ${JSON.stringify(kind)}`);
  let st = null;
  try { st = fs.statSync(dir); } catch { /* missing */ }
  if (st && !st.isDirectory()) return false;
  if (st) {
    const have = readOwner(dir);
    if (have === want) return true;
    if (have !== null) return false; // another kind's marker
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return false; }
    if (entries.length) return false; // non-empty and unmarked: not ours
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dir, OWNER_FILE), want + '\n');
  return true;
}

/**
 * True when `clean` may delete dir: it carries the artifact marker itself,
 * every immediate child directory carries it (the default .dsh-rehearsal
 * parent), or it is the tool's own default layout from before markers
 * existed — name `.dsh-rehearsal`, children matching the generated names
 * (`check-<ts>`, `run-<version>-<ts>`), and each child carrying an artifact
 * (report.json / report.md) or being an interrupted run's empty directory.
 * A name that merely looks ours must not authorise a recursive delete.
 */
export function isOwnedArtifactsDir(dir) {
  if (readOwner(dir) === OWNER_KINDS.artifact) return true;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  if (!entries.length) return false;
  const marked = (p) => readOwner(p) === OWNER_KINDS.artifact;
  if (entries.every((e) => e.isDirectory() && marked(path.join(dir, e.name)))) return true;
  if (path.basename(path.resolve(dir)) !== '.dsh-rehearsal') return false;
  return entries.every((e) => {
    if (!e.isDirectory() || !/^(check|run)-[\w.-]+$/.test(e.name)) return false;
    let kids = [];
    try { kids = fs.readdirSync(path.join(dir, e.name)); } catch { return false; }
    return kids.length === 0 || kids.includes('report.json') || kids.includes('report.md');
  });
}

/** Refuse targets where a recursive delete could take down the machine's state. */
export function isDangerousTarget(dir) {
  const resolved = path.resolve(dir);
  return [path.parse(resolved).root, os.homedir(), process.cwd()].includes(resolved);
}

/**
 * Remove stale shadow homes left by a previous run that died outside every
 * exit path it controls — SIGINT during a blocking spawnSync, kill -9, a
 * crash. Those directories hold plaintext session copies, so `run` sweeps
 * them BEFORE it creates any new ones. Only directories carrying THIS
 * tool's shadow ownership marker are removed; a name that merely looks
 * ours never authorises a delete (the same rule `clean` follows), and
 * sweep failures are left in place rather than retried destructively.
 * scanRoot is injectable for tests; production scans os.tmpdir(). Returns
 * the removed directory NAMES (never paths — reports are scrubbed data).
 */
export function sweepStaleShadowHomes(scanRoot = os.tmpdir(), log = () => {}) {
  const removed = [];
  let entries;
  try { entries = fs.readdirSync(scanRoot, { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('dsh-rehearsal-home-')) continue;
    const dir = path.join(scanRoot, e.name);
    if (readOwner(dir) !== OWNER_KINDS.shadow) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(e.name);
    } catch { /* in use or already gone: leave it, it is only swept again next run */ }
  }
  if (removed.length) log(`removed ${removed.length} stale shadow home(s) left by a previous interrupted run`);
  return removed;
}
