// report: scrubbing and verdict aggregation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { newReport, addStage, finalize, toMarkdown, scrubText, homeShape, writeReport } from '../src/lib/report.js';
import { extractRoutes } from '../src/lib/drill.js';
import path_module from 'node:path';

test('scrubText removes user paths and credential shapes', () => {
  // field-delimited input: scrubText consumes paths to the field boundary
  // (documented trade-off: over-masking a prose span beats leaking a tail),
  // so a delimiter-free sentence legitimately collapses into one mask
  const s = scrubText('cwd was C:\\Users\\Jane\\AppData\\Local\\Temp; also /home/alice/x; key sk-abcdefghijklmnop1234; Bearer abc.def');
  assert.ok(!s.includes('Jane'));
  assert.ok(!s.includes('alice'));
  assert.ok(s.includes('sk-[redacted]'));
  assert.ok(s.includes('Bearer [redacted]'));
});

test('home paths leave no tail, spaced or not (review round 5 P1-1)', () => {
  // pre-fix, the home rules stopped at whitespace: `C:\Users\John Smith\.dsh`
  // became `~ Smith\.dsh` and even an unspaced home kept everything after it
  // (`~\AppData\Local\Temp\run-1`) because the orphaned tail no longer looked
  // absolute to the invariant
  const spaced = scrubText('p=D:\\Users\\Jane\\My Docs\\secret.txt; end');
  assert.ok(!spaced.includes('My Docs'), spaced);
  assert.ok(!spaced.includes('secret'), spaced);
  assert.ok(spaced.includes('<abs-path>'), 'a spaced home field escalates to <abs-path>');
  const posix = scrubText('p=/home/jane/My Docs/secret.txt; end');
  assert.ok(!posix.includes('My Docs'), posix);
  assert.ok(!posix.includes('secret'), posix);
  const surname = scrubText('u=C:\\Users\\John Smith\\.dsh; end');
  assert.ok(!surname.includes('Smith'), surname);
  const plain = scrubText('h=C:\\Users\\Jane\\AppData\\Local\\Temp\\run-1; end');
  assert.ok(!plain.includes('AppData'), plain);
  assert.ok(!plain.includes('run-1'), plain);
  assert.ok(plain.includes('~'), 'a clean home path still normalises to ~');
  const posixPlain = scrubText('h=/home/jane/AppData/run-1; end');
  assert.ok(!posixPlain.includes('AppData'), posixPlain);
  assert.ok(posixPlain.includes('~'));
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

test('scrubText masks every absolute-path shape and keeps repo-relative text', () => {
  const BS = String.fromCharCode(92);
  const mustMask = [
    `home=/root/.dsh; x`,
    `home=/var/lib/jenkins/.dsh; x`,
    `home=/srv/team/dsh-home; x`,
    `shadow=/tmp/dsh-rehearsal-home-abc123; x`,
    `cwd=${'D:' + BS + 'Work' + BS + 'a b' + BS + 'c.log'}; x`,
    `up=../../secret/x; y`,
    `unc=${BS}${BS}fs01${BS}team${BS}dsh; z`,
  ];
  for (const line of mustMask) {
    const out = scrubText(line);
    const leaked = ['/root', '/var/lib', '/srv', '/tmp', 'a b', 'fs01', '../'].filter((s) => out.includes(s));
    assert.deepEqual(leaked, [], `shape survived: ${out}`);
  }
  // the same call must not eat text that is legitimately path-shaped in a report
  const mustKeep = [
    'url=https://github.com/wuwaka/dsh-rehearsal',
    'site=//github.com/x',
    'file=src/lib/report.js:136',
    'doc=docs/FAILURE_MODES.md',
    'shape=sessions/<ws>/<id>/session.v4.jsonl.zstd',
    'ref=link:github:wuwaka/dsh-rehearsal',
  ];
  for (const line of mustKeep) assert.equal(scrubText(line), line, `over-masked: ${line}`);
});

test('a future stage cannot bypass redaction by composing a path', () => {
  const r = newReport({ candidateVersion: '0.2.0-rc.2', profile: 'web', command: 'run' });
  addStage(r, {
    id: 'x-future',
    title: 'simulated later stage',
    verdict: 'pass',
    // values AND keys AND a nested array - every route a path can take into evidence
    details: 'shadow=/root/.dsh kept=/srv/team/x',
    evidence: [{ '/var/lib/jenkins/.dsh': ['../private/thing', 'D:Worka b.log'] }],
  });
  finalize(r);
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes('/root/'), 'value path must not survive');
  assert.ok(!raw.includes('/var/lib/'), 'evidence KEY path must not survive');
  assert.ok(!raw.includes('../private'), 'array path must not survive');
  assert.ok(!raw.includes('redaction gap'), 'known shapes are masked, so no warning is needed');
});

test('privacy.scrubbed is earned at finalize, not promised at construction', () => {
  const r = newReport({ candidateVersion: '0.2.0-rc.2', profile: 'web', command: 'check' });
  assert.equal(r.privacy.scrubbed, false, 'a report that never reached finalize() must not claim it was scrubbed');
  finalize(r);
  assert.equal(r.privacy.scrubbed, true);
});

test('writeReport closes the bypass: an un-finalized report cannot reach disk claiming it was scrubbed', (t) => {
  const dir = fs.mkdtempSync(path_module.join(os.tmpdir(), 'dsh-write-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = newReport({ candidateVersion: '0.2.0-rc.2', profile: 'web', command: 'check' });
  addStage(r, { id: 'a', title: 't', verdict: 'pass', durationMs: 1, details: 'home=/root/.dsh', evidence: [] });
  // deliberately NO finalize() call - this is the future-stage mistake
  writeReport(dir, r);
  const onDisk = JSON.parse(fs.readFileSync(path_module.join(dir, 'report.json'), 'utf8'));
  assert.equal(onDisk.privacy.scrubbed, true, 'the writer must have finalized');
  assert.ok(!JSON.stringify(onDisk).includes('/root/'), 'and the path must be gone');
});

test('writeReport re-finalizes on every write: a report mutated AFTER finalize is scrubbed again (review P1-1)', (t) => {
  const dir = fs.mkdtempSync(path_module.join(os.tmpdir(), 'dsh-write-refinalize-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = newReport({ candidateVersion: '0.2.0-rc.2', profile: 'web', command: 'run' });
  finalize(r);
  assert.equal(r.privacy.scrubbed, true);
  // the realistic later-stage mutation: a stage appended after finalize ran.
  // Measured pre-fix: the injected path shipped verbatim because
  // privacy.scrubbed was trusted as a skip token.
  r.stages.push({ id: 'x-late', verdict: 'pass', details: 'home=/root/.dsh and C:\\Users\\Jane\\x' });
  writeReport(dir, r);
  const raw = fs.readFileSync(path_module.join(dir, 'report.json'), 'utf8');
  assert.ok(!raw.includes('/root/'), 'a post-finalize value must not reach disk unscrubbed');
  assert.ok(!raw.includes('Jane'));
});

test('homeShape and defaultHome agree on what the default location is', async () => {
  const { defaultHome } = await import('../src/lib/dshhome.js');
  const d = defaultHome();
  assert.equal(homeShape(d, d), 'default', 'homeShape drifted from defaultHome');
  assert.equal(homeShape('/somewhere/else', d), 'custom');
});

test('an unknown path shape marks the report unscrubbed and writeReport refuses it (round 5 P1-2)', (t) => {
  const dir = fs.mkdtempSync(path_module.join(os.tmpdir(), 'dsh-gap-refuse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = newReport({ candidateVersion: '0.2.0-rc.2', profile: 'web', command: 'run' });
  addStage(r, {
    id: 'x-unknown-field',
    title: 'stage carrying a field scrubStage never heard of',
    verdict: 'pass',
    details: 'ok',
    evidence: [],
  });
  // a later stage adding a free-form field is the realistic bypass: scrubStage
  // only knows details + evidence, so this must be caught by the invariant
  r.stages[0].scratch = 'mnt=/mnt/Data Disk/dsh-shadow-1';
  finalize(r);
  assert.ok(r.warnings.some((w) => /redaction gap/.test(w)), 'the invariant must flag what the filter missed');
  assert.equal(r.privacy.scrubbed, false, 'an unmet invariant must not claim scrubbed');
  // fail-closed: the earlier behaviour warned and wrote the leak anyway
  assert.throws(() => writeReport(dir, r), /refusing to write an unsanitised report/, 'writeReport must refuse');
  assert.equal(fs.existsSync(path_module.join(dir, 'report.json')), false, 'nothing may reach disk');
});

test('homeShape describes a DSH_HOME without ever returning its path', () => {
  const p = path_module;
  const def = process.env.DSH_HOME || p.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
  assert.equal(homeShape(def, def), 'default');
  assert.equal(homeShape(def + p.sep, def), 'default', 'a trailing separator is still the default');
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
    const out = homeShape(custom, def);
    assert.ok(['custom', 'unknown'].includes(out), `must classify ${custom}, got ${out}`);
    assert.ok(!out.includes('/') && !out.includes(BS), 'the returned shape must never contain a path separator');
  }
  assert.equal(homeShape('', def), 'unknown');
  assert.equal(homeShape(undefined, def), 'unknown');
  assert.equal(homeShape('/whatever', ''), 'custom', 'no reference default given: cannot claim default');
});
