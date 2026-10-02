// Shared helpers: process spawning with strict stdout/stderr separation,
// keyless/telemetry-safe environment, and small logging utilities.

import { spawnSync } from 'node:child_process';

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
 * process.env): the parent process is never mutated (audit P2-6), and every
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
