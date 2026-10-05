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
  [path.join('docs', 'architecture.md'), path.join('docs', 'architecture.en.md')],
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
  const zh = ['README.md', 'SECURITY.md', 'PUBLISHING.md', 'CHANGELOG.zh.md', 'AUDIT.md', path.join('docs', 'FAILURE_MODES.md'), path.join('docs', 'architecture.md')];
  for (const f of zh) {
    const hits = read(f).split(/\r?\n/).filter((l) => /我/.test(l));
    assert.deepEqual(hits, [], `${f} contains first-person narration`);
  }
  const en = ['README.en.md', 'SECURITY.en.md', 'PUBLISHING.en.md', 'CHANGELOG.md', 'AUDIT.en.md', path.join('docs', 'FAILURE_MODES.en.md'), path.join('docs', 'architecture.en.md')];
  for (const f of en) {
    // case-sensitive: /\bi\b/i would fire on "i.e." and flag prose that has no actor
    assert.equal(/\bI\b|\b(we|our|us)\b/.test(read(f)), false, `${f} contains first-person narration`);
  }
});

const DOC_FILES = PAIRS.flat();
// AUDIT.md describes its stated baseline commit, not HEAD: its line numbers were
// correct against 7c374bc and the code has since moved. Asserting them against
// today's tree would be wrong in both directions - it would fail on accurate
// history and tempt someone to "fix" a record that is not broken. So the
// citation checks below run over the living docs only.
const LIVING_DOCS = DOC_FILES.filter((f) => !f.startsWith('AUDIT'));
const CITE_RE = /([\w./-]+\.(?:js|mjs|ts|yml|yaml|json|md)):(\d+)(?:-(\d+))?/g;

// Every in-repo line citation the docs use, with something that must appear on
// the cited line. A citation is an assertion, not a decoration: when code moves,
// the doc quoting the old number starts failing here instead of quietly sending
// readers to the wrong place. (report.js:136 drifted to 199 unnoticed for a
// whole review round.)
const CITED_LINES = [
  ['src/lib/report.js', 225, /export function finalize\(report\)/],
  ['src/lib/util.js', 71, /credential-shaped variable/],
  ['src/lib/util.js', 90, /DSH_TELEMETRY_MODE = 'DISABLED'/],
  ['src/lib/shadow.js', 138, /TOOL_ROW_NAME_PREFIXES = \[/],
  ['src/lib/drill.js', 14, /WRITE_FAIL_SIGNATURES = \[/],
  ['src/lib/drill.js', 22, /preset-not-composed/],
  ['src/lib/drill.js', 28, /cwd-mismatch/],
  ['src/lib/drill.js', 101, /export function writeRoundVerdict/],
  ['src/lib/drill.js', 217, /export function classifyToolResults/],
  ['src/lib/drill.js', 312, /v4z/],
  ['src/lib/drill.js', 323, /hasAssistantMessage/],
  ['src/lib/drill.js', 324, /formatFail/],
  ['src/lib/drill.js', 325, /replayMissed/],
  ['src/commands/run.js', 21, /patch-entry-not-found/],
  ['src/commands/run.js', 22, /port-in-use/],
  ['src/commands/run.js', 23, /module-missing/],
  ['src/commands/run.js', 291, /two cold boots/],
  ['src/commands/run.js', 296, /MISSING_CREDENTIAL/],
];

// Paths that live in somebody else's repository, each with a marker that must
// appear on the citing line so the reader knows whose file it is.
const EXTERNAL_CITES = {
  'README.zh.md': 'gating-hub',
  'CHANGELOG.md': 'gating-hub',
  'lib/server/domain/format-contract.js': 'gating-hub',
  'lib/index.js': 'dsh-backup',
  'scripts/check-submission.mjs': 'awesome-dsh-plugin',
  'scripts/lib/entries.mjs': 'awesome-dsh-plugin',
};

function docCitations() {
  const found = [];
  for (const doc of LIVING_DOCS) {
    for (const line of read(doc).split(/\r?\n/)) {
      for (const m of line.matchAll(CITE_RE)) {
        found.push({ doc, path: m[1], start: Number(m[2]), end: Number(m[3] ?? m[2]), line });
      }
    }
  }
  return found;
}

test('docs cite only files that exist here, or are declared as external', () => {
  const cites = docCitations();
  assert.ok(cites.length >= 20, `citation inventory shrank to ${cites.length}`);
  for (const c of cites) {
    if (fs.existsSync(path.join(root, c.path))) continue;
    const owner = Object.entries(EXTERNAL_CITES).find(([p]) => c.path.endsWith(p));
    assert.ok(owner, `${c.doc} cites "${c.path}:${c.start}" which exists neither in this repository nor among the declared external files`);
    assert.ok(c.line.includes(owner[1]), `${c.doc}: external cite "${c.path}" must name its owner ("${owner[1]}") on the same line`);
  }
});

test('every in-repo line citation is backed by an assertion about that line', () => {
  for (const [file, line, pattern] of CITED_LINES) {
    const text = read(file).split(/\r?\n/)[line - 1];
    assert.notEqual(text, undefined, `${file}:${line} does not exist`);
    assert.match(text, pattern, `${file}:${line} no longer holds what the docs cite it for`);
  }
  for (const c of docCitations()) {
    if (!fs.existsSync(path.join(root, c.path))) continue;
    const covered = CITED_LINES.some(([f, l]) => f === c.path && (l === c.start || l === c.end));
    assert.ok(covered, `${c.doc} cites ${c.path}:${c.start}${c.end !== c.start ? '-' + c.end : ''} with nothing asserting it - add the line to CITED_LINES or correct the number`);
  }
});
