// report: scrubbing and verdict aggregation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newReport, addStage, finalize, toMarkdown, scrubText, homeShape } from '../src/lib/report.js';
import { extractRoutes } from '../src/lib/drill.js';
import path_module from 'node:path';

test('scrubText removes user paths and credential shapes', () => {
  const s = scrubText('cwd was C:\\Users\\Jane\\AppData\\Local\\Temp and /home/alice/x and key sk-abcdefghijklmnop1234 Bearer abc.def');
  assert.ok(!s.includes('Jane'));
  assert.ok(!s.includes('alice'));
  assert.ok(s.includes('sk-[redacted]'));
  assert.ok(s.includes('Bearer [redacted]'));
});

test('verdict aggregation: blocking fail -> do-not-upgrade', () => {
  const r = newReport({ command: 'run' });
  addStage(r, { id: 'a', verdict: 'pass' });
  addStage(r, { id: 'b', verdict: 'fail', blocking: true });
  finalize(r);
  assert.equal(r.verdict, 'do-not-upgrade');
});

test('verdict aggregation: warn -> upgrade-with-conditions', () => {
  const r = newReport({ command: 'check' });
  addStage(r, { id: 'a', verdict: 'pass' });
  addStage(r, { id: 'b', verdict: 'warn' });
  finalize(r);
  assert.equal(r.verdict, 'upgrade-with-conditions');
});

test('verdict aggregation: all pass -> upgrade-ok', () => {
  const r = newReport({ command: 'check' });
  addStage(r, { id: 'a', verdict: 'pass' });
  addStage(r, { id: 'b', verdict: 'skip' });
  finalize(r);
  assert.equal(r.verdict, 'upgrade-ok');
});

test('markdown contains stage table and rollback one-way warning', () => {
  const r = newReport({ command: 'run', candidateVersion: '0.2.0-rc.2' });
  addStage(r, { id: 'e-sessions', verdict: 'pass', details: 'migrated 3/3' });
  finalize(r);
  const md = toMarkdown(r);
  assert.ok(md.includes('| e-sessions | pass |'));
  assert.ok(md.includes('REFUSED'));
  assert.ok(md.includes('0.2.0-rc.2'));
});

test('markdown renders coverage block when present', () => {
  const r = newReport({ command: 'run' });
  addStage(r, { id: 'e', verdict: 'pass' });
  r.coverage = { sessions: { total: 52, migrated: 9 }, writeRounds: { attempted: 2, pass: 2 } };
  finalize(r);
  assert.ok(toMarkdown(r).includes('## Coverage'));
});

test('P1-2: finalize deep-scrubs evidence objects; report JSON has no abs paths/usernames', () => {
  const r = newReport({ command: 'run', candidateVersion: '0.2.0-rc.2' });
  addStage(r, {
    id: 'a-inventory',
    verdict: 'pass',
    details: 'home=C:\\Users\\Jane\\.dsh',
    evidence: [
      {
        dir: 'C:\\Users\\Jane\\.dsh\\profiles\\desktop',
        tmp: 'C:\\Users\\Jane\\AppData\\Local\\Temp\\dsh-rehearsal-home-abc',
        other: 'D:\\ZephyrKeep\\zextra\\我的 项目\\proj',
        source: 'link:D:/sentinel-plugins/clip-menu',
        unix: '/home/alice/x',
        secret: 'Bearer abc.def',
        nested: [{ path: 'C:\\Users\\Jane\\deep\\nested' }],
      },
    ],
  });
  r.coverage = { sessions: { note: 'ran under C:\\Users\\Jane\\x' } };
  finalize(r);
  const json = JSON.stringify(r);
  // 'zextra' is deliberately a token from the MIDDLE of a spaced path: a
  // scrubber that stops at whitespace leaves ` zextra\proj` behind, so this
  // entry is what catches the partial-redaction regression specifically.
  for (const leak of ['Jane', 'ZephyrKeep', 'zextra', 'sentinel-plugins', 'Users\\\\', '/home/alice', 'abc.def']) {
    assert.ok(!json.includes(leak), `report leaks: ${leak}`);
  }
  assert.ok(json.includes('<abs-path>'), 'foreign drive paths are masked');
  assert.ok(json.includes('~'), 'home dirs are masked');
});

test('scrubText redacts paths containing SPACES without leaking the tail', () => {
  // Regression: `[^\s"']*` stopped at the first space, so only the leading
  // segments were masked and the rest of the path survived in the report.
  const spaced = scrubText('tail: D:\\My Docs\\zextra\\c.log ended');
  assert.ok(!spaced.includes('zextra'), `tail leaked: ${spaced}`);
  assert.ok(!spaced.includes('Docs'), `tail leaked: ${spaced}`);
  assert.match(spaced, /<abs-path>/);
  // prose delimiters must survive: only the path is consumed
  const inSentence = scrubText('copied=9 at D:\\My Docs\\x, migrated=9/9 | ok');
  assert.match(inSentence, /copied=9/, 'text before the path must survive');
  assert.match(inSentence, /migrated=9\/9/, 'text after the field delimiter must survive');
  assert.ok(!inSentence.includes('Docs'));
  // URLs and version strings are NOT drive-rooted paths
  assert.equal(scrubText('see https://github.com/o/r/issues/1 for #1'), 'see https://github.com/o/r/issues/1 for #1');
  assert.equal(scrubText('candidate=0.2.0-rc.2 current=0.2.0-rc.2'), 'candidate=0.2.0-rc.2 current=0.2.0-rc.2');
});

test('P1-2: plain-string details still scrub through finalize', () => {
  const r = newReport({ command: 'check' });
  addStage(r, { id: 'a', verdict: 'pass', details: 'home=C:\\Users\\Bob\\.dsh; other=/home/carol/y' });
  finalize(r);
  assert.ok(!JSON.stringify(r).includes('Bob'));
  assert.ok(!JSON.stringify(r).includes('carol'));
});

test('privacy block makes an honest content claim (P1-1)', () => {
  const r = newReport({ command: 'run' });
  assert.equal(r.privacy.messageContentInReports, false);
  assert.match(r.privacy.stderrEvidence, /filtered/);
  assert.ok(Array.isArray(r.privacy.redactedEnv));
});

test('extractRoutes pulls distinct provider/model pairs from request/header rows', () => {
  const fixtureText = [
    JSON.stringify({ type: 'session', header: {} }),
    JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } }),
    JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } }),
    JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-pro' } } } }),
    JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'other', model: 'm1' } } } }),
    'not-json-line',
  ].join('\n');
  const routes = extractRoutes(fixtureText);
  const ds = routes.find((r) => r.id === 'deepseek-official');
  assert.ok(ds);
  assert.deepEqual(ds.models.map((m) => m.id).sort(), ['deepseek-flash', 'deepseek-pro']);
  assert.equal(routes.find((r) => r.id === 'other').models[0].id, 'm1');
  assert.equal(routes.length, 2);
});

test('run-level warnings surface in JSON, Markdown and are scrubbed (round 4)', () => {
  const r = newReport({ command: 'run', candidateVersion: '0.2.0-rc.2' });
  addStage(r, { id: 'a-inventory', verdict: 'pass' });
  r.warnings.push('--preset-mode patch selected no preset-carrying session at C:\\Users\\Bob\\.dsh');
  finalize(r);
  assert.equal(r.warnings.length, 1);
  assert.ok(!JSON.stringify(r).includes('Bob'), 'warnings must be scrubbed like every other field');
  const md = toMarkdown(r);
  assert.match(md, /WARNING/);
  assert.ok(md.includes('no preset-carrying session'), 'markdown must show the caveat next to the verdict');
});

test('homeShape describes a DSH_HOME without ever returning its path', () => {
  const p = path_module;
  const def = process.env.DSH_HOME || p.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  assert.equal(homeShape(def), 'default');
  assert.equal(homeShape(def + p.sep), 'default', 'a trailing separator is still the default');
  const BS = String.fromCharCode(92);
  const customHomes = [
    '/srv/users/alice/dsh-home',
    '/var/lib/jenkins/.dsh',
    'dsh-home',
    '../.dsh',
    BS + BS + 'fileserver' + BS + 'team' + BS + 'dsh',
    'E:' + BS + 'work' + BS + 'zhang' + BS + '.dsh',
  ];
  for (const custom of customHomes) {
    const out = homeShape(custom);
    assert.ok(['custom', 'unknown'].includes(out), `must classify ${custom}, got ${out}`);
    assert.ok(!out.includes('/') && !out.includes(BS), 'the returned shape must never contain a path separator');
  }
  assert.equal(homeShape(''), 'unknown');
  assert.equal(homeShape(undefined), 'unknown');
});
