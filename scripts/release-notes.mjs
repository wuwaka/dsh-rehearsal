// Compose a GitHub Release body: install block, Chinese section, English section.
//
// House style in this ecosystem is 中文（新增/修复/变更）→ 安装 → --- → English twin.
// Both changelogs must carry a section for the version, or this exits non-zero and
// the Release job refuses: notes are generated from the release's own commit, never
// written afterwards from memory.

import fs from 'node:fs';
import path from 'node:path';

const REPO = 'https://github.com/wuwaka/dsh-rehearsal';
const tag = (process.argv[2] ?? '').trim();
const version = tag.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: release-notes.mjs <tag>   (e.g. v0.2.0)');
  process.exit(2);
}

const FILES = [
  ['CHANGELOG.zh.md', 'zh'],
  ['CHANGELOG.md', 'en'],
];

/** Version headers in file order (newest first by convention). */
function versions(lines) {
  return lines.map((l) => (l.match(/^## \[([^\]]+)\]/) || [])[1]).filter(Boolean);
}

function section(file, ver) {
  const lines = fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${ver}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end === -1) end = lines.length;
  const linkDef = /^\[[^\]]+\]:\s*\S/;
  while (end > start + 1 && (linkDef.test(lines[end - 1]) || lines[end - 1].trim() === '')) end--;
  return lines.slice(start + 1, end).join('\n').trim();
}

// The previous release is the header listed right after this one.
const firstLines = fs.readFileSync(path.join(import.meta.dirname, '..', FILES[0][0]), 'utf8').split(/\r?\n/);
const all = versions(firstLines);
const idx = all.indexOf(version);
const prev = idx >= 0 ? all.slice(idx + 1).find((v) => v !== 'Unreleased') : undefined;

const out = [];
const missing = [];
for (const [file] of FILES) {
  const body = section(file, version);
  if (body === null) missing.push(`${file} has no "## [${version}]" section`);
  else out.push(body);
}
if (missing.length) {
  console.error(`refusing to publish release notes: ${missing.join('; ')} — write them before tagging`);
  process.exit(1);
}

const [zh, en] = out;
const head = [
  '### 安装 · Install',
  '',
  '```sh',
  `npm install -g github:wuwaka/dsh-rehearsal#${tag}`,
  '```',
  '',
  `也可锁定到字节 / or pinned to bytes: \`npm install -g ${REPO}/releases/download/${tag}/dsh-rehearsal-${version}.tgz\``,
  `（用本 Release 附带的 \`dsh-rehearsal-${version}.tgz.sha256\` 校验 / verify with the attached \`.sha256\`。）`,
  '',
  '---',
  '',
];

const tail = prev
  ? ['', '---', '', `完整历史 / Full changelog: ${REPO}/compare/v${prev}...${tag}`]
  : [];

console.log([...head, zh, '', '---', '', en, ...tail].join('\n').trim() + '\n');
