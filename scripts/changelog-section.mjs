// Extract one Keep a Changelog section for a release body.
//
// Exits non-zero when the version has no section, so a tag can never publish
// release notes that silently say "nothing recorded" — the notes and the tag
// have to agree, or the pipeline refuses.

import fs from 'node:fs';
import path from 'node:path';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('usage: changelog-section.mjs <version>   (e.g. 0.1.0 or v0.1.0)');
  process.exit(2);
}

const file = path.join(import.meta.dirname, '..', 'CHANGELOG.md');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const header = new RegExp(`^## \\[${version}\\]`);
const next = /^## \[/;
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (header.test(lines[i])) { start = i; break; }
}
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section — write the release notes before tagging`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (next.test(lines[i])) { end = i; break; }
}

// The section body follows the "## [x] - date" header. Keep a Changelog keeps
// its link definitions at the bottom of the file, and in a release body those
// would render as literal "[0.1.0]: https://…" lines, so they are trimmed.
const linkDef = /^\[[^\]]+\]:\s*\S/;
let stop = end;
while (stop > start + 1 && (linkDef.test(lines[stop - 1]) || lines[stop - 1].trim() === '')) stop--;

console.log(lines.slice(start + 1, stop).join('\n').trim());
