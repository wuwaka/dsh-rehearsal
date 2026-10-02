// Every document is a bilingual pair. Translation drift is silent by default: a
// citation added to one half disappears from the other, and a reader of the half
// that lost it has no way to know. These assertions make drift a test failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const PAIRS = [
  ['README.md', 'README.en.md'],
  ['CHANGELOG.zh.md', 'CHANGELOG.md'],
  ['SECURITY.md', 'SECURITY.en.md'],
  ['PUBLISHING.md', 'PUBLISHING.en.md'],
  ['AUDIT.md', 'AUDIT.en.md'],
  ['FIXES.md', 'FIXES.en.md'],
  [path.join('docs', 'FAILURE_MODES.md'), path.join('docs', 'FAILURE_MODES.en.md')],
];

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));
const headings = (t, level) => [...t.matchAll(new RegExp(`^${level} +\\S.*$`, 'gm'))];
// src/lib/x.js:12, entries.mjs:136, lib/index.js:2617-2622, run.js:169,178
const citations = (t) => [...t.matchAll(/[\w./-]+\.(?:js|mjs|ts|yml|yaml|json|md):\d+(?:[-,]\d+)*/g)].map((m) => m[0]).sort();
const issues = (t) => [...new Set([...t.matchAll(/#(\d{3,5})\b/g)].map((m) => '#' + m[1]))].sort();

test('both halves of every documentation pair exist', () => {
  for (const [zh, en] of PAIRS) {
    assert.ok(exists(zh), `${zh} missing`);
    assert.ok(exists(en), `${en} missing`);
  }
});

test('each pair carries a language switch line whose targets exist', () => {
  for (const [zh, en] of PAIRS) {
    for (const [file, other] of [[zh, en], [en, zh]]) {
      const text = read(file);
      const dir = path.dirname(file);
      const links = [...text.matchAll(/\[简体中文\]\(([^)]+)\)\s*\|\s*\[English\]\(([^)]+)\)/g)]
        .flatMap((m) => [m[1], m[2]]);
      assert.ok(links.length >= 2, `${file} has no language switch line`);
      for (const l of links) {
        assert.ok(fs.existsSync(path.join(root, dir, l)), `${file} links to missing ${l}`);
      }
    }
  }
});

test('pairs agree on section count', () => {
  for (const [zh, en] of PAIRS) {
    const a = headings(read(zh), '##').length;
    const b = headings(read(en), '##').length;
    assert.equal(a, b, `${zh} has ${a} "## " sections, ${en} has ${b}`);
  }
});

test('pairs cite the same file:line locations', () => {
  for (const [zh, en] of PAIRS) {
    const a = citations(read(zh));
    const b = citations(read(en));
    const only = [...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))];
    assert.deepEqual(only, [], `${zh} / ${en} disagree on citations`);
    if (zh === path.join('docs', 'FAILURE_MODES.md')) assert.ok(a.length >= 8, 'citation inventory shrank');
  }
});

test('pairs reference the same upstream issues', () => {
  for (const [zh, en] of PAIRS) {
    assert.deepEqual(issues(read(zh)), issues(read(en)), `${zh} / ${en} disagree on issue numbers`);
  }
});

test('pairs cite the same commit hashes', () => {
  // audit claims point at specific commits; a half-translated hash list silently
  // breaks the ability to re-verify them
  const hashes = (t) => [...new Set([...t.matchAll(/\b[0-9a-f]{7,9}\b/g)].map((m) => m[0]))].sort();
  for (const [zh, en] of PAIRS) {
    const a = hashes(read(zh));
    if (!a.length) continue;
    assert.deepEqual(a, hashes(read(en)), `${zh} / ${en} disagree on commit hashes`);
  }
});

test('no document regressed into first-person prose', () => {
  // zero tolerance on 我: quoting a third party who spoke in the first person would
  // need an explicit exception here rather than a silent relaxation of the rule
  const zh = ['README.md', 'SECURITY.md', 'PUBLISHING.md', 'CHANGELOG.zh.md', 'AUDIT.md', 'FIXES.md', path.join('docs', 'FAILURE_MODES.md')];
  for (const f of zh) {
    const hits = read(f).split(/\r?\n/).filter((l) => /我/.test(l));
    assert.deepEqual(hits, [], `${f} contains first-person narration`);
  }
  const en = ['README.en.md', 'SECURITY.en.md', 'PUBLISHING.en.md', 'CHANGELOG.md', 'AUDIT.en.md', 'FIXES.en.md', path.join('docs', 'FAILURE_MODES.en.md')];
  for (const f of en) {
    // case-sensitive: /\bi\b/i would fire on "i.e." and flag prose that has no actor
    assert.equal(/\bI\b|\b(we|our|us)\b/.test(read(f)), false, `${f} contains first-person narration`);
  }
});
