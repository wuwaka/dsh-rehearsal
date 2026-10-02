// End-to-end CLI smoke for `check` over a SYNTHETIC home — offline, no dsh
// spawn, no user data. This is what CI can actually run: `run` needs network
// installs, a candidate binary and real sessions, so it is deliberately not
// exercised here.
//
// The fixture home is created INSIDE os.homedir() on purpose: the scrubbing
// contract under test is "a user home path never reaches the report", and only
// a real home path exercises the /home/, /Users/ and C:\Users\ rules that
// differ per platform.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');

function buildFixture(t) {
  const home = fs.mkdtempSync(path.join(os.homedir(), 'dsh-rehearsal-fixture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prof = path.join(home, 'profiles', 'web');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(
    path.join(prof, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        dependencies: { '@deepseek-ai/dsh-base': '^0.2.0-rc.1', 'some-plugin': '1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(prof, 'cordis.patch.yml'), '- id: llm\n  name: x\n- insert:\n    - name: y\n');
  const s = path.join(home, 'sessions', '--fixture--', 'session-aaa');
  fs.mkdirSync(s, { recursive: true });
  fs.writeFileSync(
    path.join(s, 'session.jsonl'),
    [
      JSON.stringify({ type: 'header', version: 0, id: 'session-aaa', cwd: home, time: 't' }),
      JSON.stringify({ type: 'turn/start', seq: 1, time: 't', data: {} }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: 't', data: { reason: { kind: 'completed' } } }),
    ].join('\n') + '\n',
  );
  return home;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
}

test('check runs end-to-end on a synthetic home and emits a valid v1 report', (t) => {
  const home = buildFixture(t);
  const artifacts = path.join(home, 'artifacts');
  const r = runCli(['check', '--home', home, '--candidate', '0.2.0-rc.2', '--artifacts', artifacts]);
  assert.ok([0, 1, 2].includes(r.status), `exit code must be a decision (got ${r.status}): ${r.stderr}`);
  assert.match(r.stdout, /dsh-rehearsal check — verdict:/);

  const report = JSON.parse(fs.readFileSync(path.join(artifacts, 'report.json'), 'utf8'));
  assert.equal(report.schema, 'dsh-rehearsal/v1');
  assert.equal(report.command, 'check');
  assert.equal(report.target.profile, 'web');
  assert.deepEqual(report.stages.map((s) => s.id), ['a-inventory', 'b1-peer-graph']);
  assert.equal(Array.isArray(report.warnings), true);
  assert.equal(report.coverage, undefined, 'check does not run the session drill');
  // the rollback one-way rule is a headline claim of the tool; it must be there
  assert.equal(report.rollback.sessionsAreOneWay, true);
  assert.match(report.rollback.note, /REFUSED/);

  // scrubbing contract: the user home the fixture lives under never appears
  const raw = fs.readFileSync(path.join(artifacts, 'report.json'), 'utf8') + fs.readFileSync(path.join(artifacts, 'report.md'), 'utf8');
  assert.ok(!raw.includes(os.homedir()), 'report must not contain the real user home');
  assert.ok(!raw.includes(home), 'report must not contain the fixture home path');

  const md = fs.readFileSync(path.join(artifacts, 'report.md'), 'utf8');
  assert.match(md, /\| stage \| verdict \| ms \| notes \|/);
});

test('check distinguishes a candidate that newly breaks peers from one that is already broken', (t) => {
  const home = buildFixture(t);
  const prof = path.join(home, 'profiles', 'web');
  // old-plugin must be in the PROFILE's dependencies: inspectProfile only
  // scans what the manifest declares, otherwise nothing is analyzed at all.
  const pkg = JSON.parse(fs.readFileSync(path.join(prof, 'package.json'), 'utf8'));
  pkg.dependencies['old-plugin'] = '1.0.0';
  fs.writeFileSync(path.join(prof, 'package.json'), JSON.stringify(pkg, null, 2));
  const nm = path.join(prof, 'node_modules', 'old-plugin');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(
    path.join(nm, 'package.json'),
    JSON.stringify({ name: 'old-plugin', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-base': '^0.1.7-rc.2' } }),
  );
  // Both cases pin `--current` explicitly: detectCurrentDshVersion also probes
  // the machine-wide Desktop install, so on a dev box "no --current" is not a
  // deterministic input.
  const newlyBroken = runCli(['check', '--home', home, '--candidate', '0.2.0-rc.2', '--current', '0.1.7-rc.3', '--artifacts', path.join(home, 'art-cand')]);
  assert.equal(newlyBroken.status, 2, 'current satisfies the range but the candidate does not -> do-not-upgrade');
  const r1 = JSON.parse(fs.readFileSync(path.join(home, 'art-cand', 'report.json'), 'utf8'));
  const k1 = r1.stages[1].evidence.map((f) => f.kind);
  assert.ok(k1.includes('peer-incompatible'), 'classified as newly broken by this upgrade');
  assert.ok(!k1.includes('peer-incompatible-pre-existing'));

  // same candidate, but current ALSO fails => pre-existing, not a blocker.
  // (0.1.9-rc.1 does NOT satisfy ^0.1.7-rc.2 under npm prerelease semantics,
  // while the plain 0.1.9 does — exactly the footgun this stage surfaces.)
  const preExisting = runCli(['check', '--home', home, '--candidate', '0.2.0-rc.2', '--current', '0.1.9-rc.1', '--artifacts', path.join(home, 'art-cur')]);
  assert.equal(preExisting.status, 1, 'pre-existing mismatch must not be reported as caused by this upgrade');
  const r2 = JSON.parse(fs.readFileSync(path.join(home, 'art-cur', 'report.json'), 'utf8'));
  const k2 = r2.stages[1].evidence.map((f) => f.kind);
  assert.ok(k2.includes('peer-incompatible-pre-existing'), 'severity splits when current is known');
  assert.ok(!k2.includes('peer-incompatible'), 'no newly-broken finding remains for this plugin');

});

test('unknown command and bad report path exit 3', () => {
  assert.equal(runCli(['nope']).status, 3);
  assert.equal(runCli(['report', path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())]).status, 3);
  assert.match(runCli([]).stdout, /Commands:/);
});

test('--help and --version are real flags, not "unknown command" (installed-CLI contract)', () => {
  // The conventional first thing anyone types after `npm i -g` must not exit 3:
  // that code means "the rehearsal itself failed" in this tool's contract.
  for (const flag of ['--help', '-h']) {
    const r = runCli([flag]);
    assert.equal(r.status, 0, `${flag} exited ${r.status}`);
    assert.match(r.stdout, /Commands:/);
  }
  const v = runCli(['--version']);
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^dsh-rehearsal \d+\.\d+\.\d+ \(node v\d+\./);
  // a genuinely unknown command still exits 3, and says so
  const bad = runCli(['--hedl']);
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /unknown command/);
});
