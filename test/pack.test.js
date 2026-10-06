// The npm tarball is a second publication boundary next to the GitHub repo:
// user-facing docs ship with the package, maintainer-only docs (audit trail,
// release runbook, internal plans) do not. This test pins both directions so
// a files-list edit cannot silently change what `npm install -g` carries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.join(import.meta.dirname, '..');

test('npm pack ships user docs and stays free of maintainer-only documents (review round 6)', () => {
  // npm is a .cmd shim on Windows and node >=20.12 refuses to spawn those
  // without a shell; --dry-run writes nothing and needs no registry.
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 180000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, `npm pack --dry-run failed: ${r.stderr}`);
  // npm 11 wraps the pack info in an array; npm 12 keys it by package name.
  const parsed = JSON.parse(r.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.ok(entry && Array.isArray(entry.files), `unexpected npm pack --json shape: ${r.stdout.slice(0, 200)}`);
  const files = new Set(entry.files.map((f) => f.path.replace(/\\/g, '/')));

  for (const must of [
    'package.json',
    'README.md', 'README.en.md',
    'SECURITY.md', 'SECURITY.en.md',
    'CHANGELOG.md', 'CHANGELOG.zh.md',
    'LICENSE',
    'docs/architecture.md', 'docs/architecture.en.md',
    'docs/FAILURE_MODES.md', 'docs/FAILURE_MODES.en.md',
    'src/cli.js', 'src/lib/asar.js', 'src/lib/desktops.js', 'src/lib/util.js',
  ]) {
    assert.ok(files.has(must), `${must} must ship in the npm tarball`);
  }
  for (const mustNot of [
    'AUDIT.md', 'AUDIT.en.md',
    'PUBLISHING.md', 'PUBLISHING.en.md',
    'DESKTOP-COMPAT-PLAN.md', 'AI-DOC-STYLE-GUIDE.md',
    'assets/poster.jpg',
  ]) {
    assert.ok(!files.has(mustNot), `${mustNot} is maintainer-only and must stay out of the npm tarball`);
  }
});
