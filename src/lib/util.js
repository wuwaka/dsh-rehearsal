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
  // This machine's node.exe lives under a directory that intermittently
  // returns transient ENOENT on CreateProcess (AV scan / update window).
  // Retry the spawn itself; only real failures bubble up.
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
 * Environment for every candidate-dsh invocation inside a shadow home.
 *
 * Returns the COMPLETE child environment (caller must not merge with
 * process.env): the parent process is never mutated, and every
 * credential-shaped variable (API_KEY / TOKEN / SECRET / CREDENTIAL /
 * PASSWORD / PRIVATE_KEY / AUTH) is stripped rather than only
 * DEEPSEEK_API_KEY. Telemetry is explicitly disabled (candidate 0.2.0
 * defaults FEEDBACK_ONLY and OTLP bypasses proxies); reports record the
 * REDACTED NAMES via redactedEnvNames(), never values.
 */
const SECRET_KEY = /API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|AUTH/i;

export function redactedEnvNames(env = process.env) {
  return Object.keys(env).filter((k) => SECRET_KEY.test(k)).sort();
}

export function shadowEnv(shadowHome) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_KEY.test(k)) continue;
    env[k] = v;
  }
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
 * executed" and yields a clean-looking verdict (measured 2026-10-05: a
 * `check --candidate nonsense` run exited 0 with `upgrade-ok`).
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
 * existed — name `.dsh-rehearsal` with only its own generated children
 * (`check-<ts>`, `run-<version>-<ts>`).
 */
export function isOwnedArtifactsDir(dir) {
  if (readOwner(dir) === OWNER_KINDS.artifact) return true;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  if (!entries.length) return false;
  const marked = (p) => readOwner(p) === OWNER_KINDS.artifact;
  if (entries.every((e) => e.isDirectory() && marked(path.join(dir, e.name)))) return true;
  return path.basename(path.resolve(dir)) === '.dsh-rehearsal'
    && entries.every((e) => e.isDirectory() && /^(check|run)-[\w.-]+$/.test(e.name));
}

/** Refuse targets where a recursive delete could take down the machine's state. */
export function isDangerousTarget(dir) {
  const resolved = path.resolve(dir);
  return [path.parse(resolved).root, os.homedir(), process.cwd()].includes(resolved);
}
