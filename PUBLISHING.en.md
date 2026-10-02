[简体中文](PUBLISHING.md) | [English](PUBLISHING.en.md)

# Publishing checklist

Read this before the first `git push`, and again before each release.

## The history contains a pre-scrub snapshot

The working tree and `HEAD` are clean: `git grep` over the whole tree returns 0 hits for
user paths, and the scrubbing tests enforce that.

Commits are immutable, and the local history still contains a snapshot taken before the
scrub. That commit has 13 real path occurrences across 5 files (`README.md`, `AUDIT.md`,
`src/lib/sessions.js`, `test/report.test.js`, `test/sessions.test.js`); two earlier commits
carry 2 occurrences each (a synthetic fixture username in `test/report.test.js`).

`git push` publishes history, not just the tip. Publish from a separate clean branch instead
of rewriting the audit trail:

```sh
git checkout --orphan publish-clean
git add -A
git commit -m "dsh-rehearsal: static upgrade pre-flight + keyless session rehearsal"

# verify, then push the clean tree as the public default branch
git diff --stat main publish-clean          # must print nothing (identical tree)
git ls-tree -r --name-only publish-clean    # no .dsh-rehearsal/, no node_modules/, no fixtures
git grep -nE "<TOKENS>" publish-clean --    # the reader's own username / drive layout; expect no output
npm test                                    # must be green
git remote add origin https://github.com/<you>/dsh-rehearsal.git
git push origin publish-clean:main
```

`main` keeps its full history locally on purpose: it is the audit trail, recorded in
`AUDIT.md` and `FIXES.md`, and it has no upstream, so it cannot be pushed by accident.

### Keeping `publish-clean` in sync

`git checkout main -- .` does **not** delete files that `main` removed; a superseded script
survived into the public tree this way once. After copying, remove anything `main` no longer
has, and make tree equality a gate before pushing:

```sh
git checkout -q publish-clean && git checkout main -- . && git add -A
git diff --stat main publish-clean          # must print NOTHING
[ -z "$(git diff main publish-clean)" ] && echo "GATE OK" || echo "GATE FAIL: do not push"
```

## Artifacts are never committed

`.gitignore` excludes `.dsh-rehearsal/`, where reports and rehearsal output land. Reports are
scrubbed, but they contain session ids and histogram shapes from the local machine; keep them
out of the repository. `*.tgz` and `SHA256SUMS.txt` are ignored for the same reason: a
committed checksum can go stale against the tarball the tag actually points at.

## Cutting a release

`release.yml` runs on a `v*` tag push and stops in two cases, so the order matters:

```sh
npm test                                     # must be green
# 1. BOTH changelogs — PUBLISHING is zh-primary: CHANGELOG.md (English) and CHANGELOG.zh.md.
#    Move Unreleased content under a new "## [X.Y.Z] - YYYY-MM-DD" heading in each (same
#    versions, same order; test/changelog.test.js asserts the pair), add the [X.Y.Z] link at
#    the bottom, and update the [Unreleased] compare range.
# 2. package.json: "version" must equal X.Y.Z exactly, in the same commit.
node scripts/release-notes.mjs vX.Y.Z        # prints exactly what the Release body will be
git add -A && git commit -m "…"
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git push origin publish-clean:main           # CI green first
git push origin "vX.Y.Z"                     # triggers the Release job — a public action
```

The Release body is generated from the tagged commit in both languages, with the two install
lines prepended: 中文（新增/修复/变更）→ 安装 → `---` → English twin. A missing section in
either changelog fails the job, so notes cannot be written afterwards from memory.

To rebuild notes or assets for a tag already published, use **Run workflow → `release.yml` →
tag** rather than moving the public tag: the job checks the tag out, so `package.json` and the
changelogs still come from the tagged commit even when this file on `main` is newer.

Then verify the release carries what it claims:

```sh
gh release view "vX.Y.Z" --repo <you>/dsh-rehearsal \
  --json tagName,isDraft,isPrerelease,assets --jq '{tagName,isDraft,isPrerelease,assets:[.assets[].name]}'
# expect: draft=false, isPrerelease=false (unless the tag carries a `-`),
#         assets = dsh-rehearsal-X.Y.Z.tgz + dsh-rehearsal-X.Y.Z.tgz.sha256
```

A tag containing `-` (e.g. `v0.3.0-rc.1`) is marked `--prerelease` automatically, and
`publish.yml` will still attempt the npm publish; pass `--tag next` if a prerelease must not
take the `latest` dist-tag.

## After the repository is public

1. **Publish to npm from CI.** `.github/workflows/publish.yml` runs on `release: published`,
   re-tests, installs the packed tarball into a throwaway prefix and smoke-runs it, then
   `npm publish --provenance`. It skips rather than fails when `NPM_TOKEN` is absent, so a
   repository without the secret shows no red pipeline:

   ```sh
   gh secret set NPM_TOKEN --repo <you>/dsh-rehearsal --body "<granular access token, Publish scope>"
   gh workflow run publish.yml --repo <you>/dsh-rehearsal --ref vX.Y.Z
   ```

   Publishing from a laptop is possible, but note the trap on this machine: the default
   `registry` in `~/.npmrc` is `registry.npmmirror.com`, a read-only mirror that answers 404
   for `npm whoami` and cannot accept a publish. Either use CI, or pass both overrides
   explicitly:

   ```sh
   npm publish --registry https://registry.npmjs.org   # needs an auth token for that registry
   ```

   The name `dsh-rehearsal` was still unclaimed on 2026-10-02 (registry 404). The community has
   a habit of reserving names without publishing, so claim it when actually ready.
2. **Set topics.** `gh api repos/<you>/dsh-rehearsal -X PUT -f "topics[]=deepseek-harness" -f "topics[]=dsh" -f "topics[]=cli" -f "topics[]=upgrade" -f "topics[]=rehearsal"`
   (topics need the `repo` scope). Add `dsh-plugin` only as a search affordance: this repository
   is deliberately not a `dsh plugin add` bundle, and the README header says so. A topic must not
   become an install claim.

3. **Do not submit to `awesome-dsh-plugin/awesome-dsh-plugin`.** Verified 2026-10-02: its
   `scripts/check-submission.mjs:258-264` requires some `package.json` in the repository to
   declare `dsh.bundle`, and a repository declaring only `dsh.client` is refused with "that
   alone is not installable". `dsh-plugin-reducer` and `dsh-canary`, both external CLIs like
   this one, return 0 hits in its generated list (4,412 entries). Submitting would burn a
   CI-gated pull request and be rejected on a rule that is correct: listing there implies
   installability this tool intentionally does not have.

   Descriptor keys are whitelisted (`scripts/lib/entries.mjs:136`: `url, name, category,
   description, tarball, file`; unknown keys fail CI), and the optional `tarball` must be an
   https URL hosted on GitHub Releases and ending in `.tgz` — which is why `release.yml`
   attaches exactly that shape.

   Where listing is appropriate:
   - `walkinglabs/awesome-deepseek-harness-plugins` → `docs/INCLUSION_POLICY.md` rule 4:
     "It is a client, launcher, or development resource … placed outside the plugin categories
     and labelled accordingly."
   - `awesome-deepseekharness/awesome-deepseek-harness` → `CONTRIBUTING.md`, category
     `🧩 Tools, Workflows & Presets`; it wants `README.md` (English) and `README.zh.md` entries
     at the same position, and its example pull request title is `Add owner/repo to Category`.

   Neither has been submitted as of 2026-10-03.

4. **Add registry badges only after a listing exists** (npm version/downloads, dshfind,
   marketplace). Pre-added badges resolve to 404. The `dsh-doctor` gate badge does not apply:
   its R/K/D gates score `dsh.bundle` packages, which this repository does not declare.
5. Re-check that the CI badge in the README header resolves once the first workflow run is
   green: `gh run list --repo <you>/dsh-rehearsal`.

## Documentation rules that are easy to break

- Every document is bilingual: `README.md` / `README.en.md`, `CHANGELOG.zh.md` /
  `CHANGELOG.md`, `SECURITY.md` / `SECURITY.en.md`, `PUBLISHING.md` / `PUBLISHING.en.md`,
  `docs/FAILURE_MODES.md` / `docs/FAILURE_MODES.en.md`. `test/docs.test.js` fails if a twin is
  missing, if the `## ` heading counts diverge, if a language switch line points at a file that
  does not exist, or if a `file:line` citation appears in one half and not the other.
- Prose is impersonal: no first person, citations next to claims, no aphorisms in place of
  mechanisms, em-dashes used sparingly and bold limited to identifiers and severity labels.
  Count and verify rather than eyeball: `grep -c` for first-person markers and `——`, then the
  parity test below.
- Three claims depend on measurement and go stale on their own schedule:
  - the **compatibility table** separates tested from declared and names the verification date;
    re-verify per release;
  - the **coverage table** (drillable share, allowlist-pass share) is measured on one machine;
    re-measure rather than average across users or present as typical;
  - the **prior-art table** describes other people's repositories, which change without notice.
    Re-read their source before repeating any cell: a wrong claim about a comparable project is
    the failure mode that section exists to avoid.
