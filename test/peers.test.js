// peers: static graph analysis against the risk shapes found on a real
// machine (reviews, 2026-10-02). All ranges/versions synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePeerGraph } from '../src/lib/peers.js';

const kinds = (findings) => findings.map((f) => f.kind);

test('prerelease caret does not cross minors: ^0.1.7-rc.2 excludes 0.2.0-rc.2', () => {
  const f = analyzePeerGraph(
    [{ name: 'a-plugin', version: '1.0.0', peers: { '@deepseek-ai/dsh-agent': '^0.1.7-rc.2' }, reproducible: true }],
    { candidate: '0.2.0-rc.2' },
  );
  assert.ok(kinds(f).includes('peer-incompatible'));
  assert.equal(f.find((x) => x.kind === 'peer-incompatible').severity, 'high');
});

test('range with explicit prerelease upper bound matches within-tuple rcs', () => {
  const f = analyzePeerGraph(
    [{ name: 'cost-meter', version: '1.8.3', peers: { '@deepseek-ai/dsh-llm': '>=0.2.0-rc.1 <0.3.0-0' }, reproducible: true }],
    { candidate: '0.2.0-rc.2' },
  );
  assert.equal(kinds(f).filter((k) => k === 'peer-incompatible').length, 0);
});

test('same-tuple caret matches later rcs: ^0.2.0-rc.1 covers 0.2.0-rc.2', () => {
  const f = analyzePeerGraph(
    [{ name: 'better-sidebar', version: '0.24.1', peers: { '@deepseek-ai/dsh-agent': '^0.2.0-rc.1' }, reproducible: true }],
    { candidate: '0.2.0-rc.2' },
  );
  assert.equal(kinds(f).filter((k) => k === 'peer-incompatible').length, 0);
});

test('plugin-to-plugin peer conflict is high severity', () => {
  const f = analyzePeerGraph(
    [
      { name: 'sidebar', version: '0.24.1', peers: { '@huanlin/dsh-plugin-better-locale': '^0.1.0' }, reproducible: true },
      { name: '@huanlin/dsh-plugin-better-locale', version: '0.2.0', peers: {}, reproducible: true },
    ],
    {},
  );
  assert.ok(kinds(f).includes('plugin-plugin-peer-incompatible'));
  assert.equal(f.find((x) => x.kind === 'plugin-plugin-peer-incompatible').severity, 'high');
});

test('cordis multi-pin across plugins is flagged', () => {
  const f = analyzePeerGraph(
    [
      { name: 'p1', version: '1.0.0', peers: { '@deepseek-ai/cordis': '^4.0.1' }, reproducible: true },
      { name: 'p2', version: '2.0.0', deps: { '@deepseek-ai/cordis': '4.0.4' }, peers: {}, reproducible: true },
    ],
    {},
  );
  const fp = f.find((x) => x.kind === 'cordis-multi-pin');
  assert.ok(fp);
  assert.equal(Object.keys(fp.pins).length, 2);
});

test('enumerated peer ranges are flagged as fragile', () => {
  const f = analyzePeerGraph(
    [{ name: 'backup', version: '1.0.0', peers: { '@deepseek-ai/dsh-llm': '0.1.2-rc.1 || 0.1.5-rc.1 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1' }, reproducible: true }],
    { candidate: '0.2.0-rc.2' },
  );
  assert.ok(kinds(f).includes('enumerated-peer-range'));
});

test('link/file/github deps are non-reproducible warnings', () => {
  const f = analyzePeerGraph([{ name: 'local', version: null, peers: {}, reproducible: false, source: 'link:D:/dev/local' }], {});
  assert.ok(kinds(f).includes('non-reproducible-dependency'));
});

test('P2-1: severity splits newly-broken vs pre-existing when current is known', () => {
  const plugins = [{ name: 'stale', version: '1.0.0', peers: { '@deepseek-ai/dsh-agent': '0.1.7-rc.1' }, reproducible: true }];
  // works on current (exact pin), breaks on candidate -> newly-broken high
  const fresh = analyzePeerGraph(plugins, { candidate: '0.2.0-rc.2', current: '0.1.7-rc.1' });
  assert.equal(fresh.find((f) => f.kind === 'peer-incompatible').severity, 'high');
  assert.equal(fresh.filter((f) => f.kind === 'peer-incompatible-pre-existing').length, 0);
  // broken on BOTH -> pre-existing warn, not a blocking upgrade verdict
  const stale = analyzePeerGraph(plugins, { candidate: '0.2.0-rc.2', current: '0.2.0-rc.2' });
  assert.equal(stale.filter((f) => f.kind === 'peer-incompatible' && f.severity === 'high').length, 0);
  const pre = stale.find((f) => f.kind === 'peer-incompatible-pre-existing');
  assert.ok(pre);
  assert.equal(pre.severity, 'warn');
  // no high anywhere -> a machine already on the candidate is not told do-not-upgrade
  assert.equal(stale.filter((f) => f.severity === 'high').length, 0);
});

test('P2-1: unknown current keeps conservative high classification', () => {
  const plugins = [{ name: 'stale', version: '1.0.0', peers: { '@deepseek-ai/dsh-agent': '0.1.7-rc.1' }, reproducible: true }];
  const f = analyzePeerGraph(plugins, { candidate: '0.2.0-rc.2' });
  assert.equal(f.find((x) => x.kind === 'peer-incompatible').severity, 'high');
});
