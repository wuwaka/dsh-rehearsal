// The two changelogs must not drift, and the Release body must be generated from
// the release's own commit rather than written afterwards from memory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
const headers = (f) => read(f).map((l) => (l.match(/^## \[([^\]]+)\]/) || [])[1]).filter(Boolean);

test('both changelogs list the same versions in the same order', () => {
  assert.deepEqual(headers('CHANGELOG.zh.md'), headers('CHANGELOG.md'));
});

test('Unreleased exists in both and every release section carries a date', () => {
  for (const f of ['CHANGELOG.zh.md', 'CHANGELOG.md']) {
    assert.ok(headers(f).includes('Unreleased'), `${f} has no [Unreleased]`);
    for (const line of read(f)) {
      if (/^## \[(?!Unreleased)/.test(line)) {
        assert.match(line, /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/, `${f}: ${line} lacks a release date`);
      }
    }
  }
});

test('the newest changelog version is the version in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const newest = headers('CHANGELOG.md').find((v) => v !== 'Unreleased');
  assert.equal(newest, pkg, 'bump package.json and add the CHANGELOG section in the same commit');
});

test('release-notes.mjs emits both languages and refuses an unknown version', () => {
  const ver = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const ok = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-notes.mjs'), `v${ver}`], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /安装 · Install/);
  assert.match(ok.stdout, /### Added/);
  assert.ok(ok.stdout.includes('撤回四条定位主张'), 'Chinese section absent');
  assert.ok(ok.stdout.includes('retracted'), 'English section absent');
  assert.match(ok.stdout, /compare\/v\d+\.\d+\.\d+\.\.\.v/);

  const bad = spawnSync(process.execPath, [path.join(root, 'scripts', 'release-notes.mjs'), 'v9.9.9'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refusing to publish release notes/);
});
