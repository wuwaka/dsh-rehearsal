# Publishing checklist

Read this **before the first `git push`.**

## The history contains a pre-scrub snapshot

The working tree and `HEAD` are clean — `git grep` over the whole tree returns **0** hits for user
paths, and the reports/tests enforce that (see the scrubbing tests).

But commits are immutable, and the local history includes a snapshot taken **before** the scrub:
that commit has **13 real path occurrences across 5 files** (`README.md`, `AUDIT.md`,
`src/lib/sessions.js`, `test/report.test.js`, `test/sessions.test.js`), and two earlier commits
carry 2 occurrences each (a synthetic fixture username in `test/report.test.js`).

`git push` publishes history, not just the tip. So publish a **single clean initial commit** instead
of rewriting the audit trail:

```sh
git checkout --orphan publish-clean
git add -A
git commit -m "dsh-rehearsal 0.1.0: static upgrade pre-flight + keyless session rehearsal"

# verify, then push the clean commit as the public default branch
git diff --stat main publish-clean          # must print nothing (identical tree)
git ls-tree -r --name-only publish-clean    # no .dsh-rehearsal/, no node_modules/, no fixtures
git grep -nE "<TOKENS>" publish-clean --    # your own username / drive layout; expect no output
npm test                                    # 57/57
git remote add origin https://github.com/<you>/dsh-rehearsal.git
git push origin publish-clean:main
```

`main` keeps its full history locally on purpose: it is the audit trail (four rounds of review,
recorded in `AUDIT.md` and `FIXES.md`). If you would rather not keep it, delete the branch after the
push — but the public repo will already be independent of it.

## Artifacts are never committed

`.gitignore` excludes `.dsh-rehearsal/`, which is where reports and rehearsal output land. Reports
are scrubbed, but they do contain **session ids and histogram shapes from your machine**; keep them
out of the repo.

## After the repo is public

1. **Publish to npm from CI.** `.github/workflows/publish.yml` runs on `release: published`, re-tests,
   installs the packed tarball into a throwaway prefix and smoke-runs it, then `npm publish --provenance`.
   It **skips itself** when `NPM_TOKEN` is absent, so a repo without the secret shows no red pipeline:

   ```sh
   gh secret set NPM_TOKEN --repo <you>/dsh-rehearsal --body "<granular access token, Publish scope>"
   ```

   Publishing from a laptop is possible but note the trap on this machine: the default
   `registry` in `~/.npmrc` is `registry.npmmirror.com`, a read-only mirror that answers 404 for
   `npm whoami` and cannot accept a publish. Either use CI, or pass both overrides explicitly:

   ```sh
   npm publish --registry https://registry.npmjs.org // needs an auth token for that registry
   ```

   The name `dsh-rehearsal` was still unclaimed on 2026-10-02; the community has a habit of
   reserving names without publishing, so claim it when you are actually ready.
2. **Set topics.** `gh api repos/<you>/dsh-rehearsal -X PUT -f "topics[]=deepseek-harness" -f "topics[]=dsh" -f "topics[]=cli" -f "topics[]=upgrade" -f "topics[]=rehearsal"`
   (topics need the `repo` scope). Add `dsh-plugin` only as a **search affordance** —
   this repository is deliberately not a `dsh plugin add` bundle, and the README's
   header line says so. Do not let a topic become an install claim.

3. **Do not submit to `awesome-dsh-plugin/awesome-dsh-plugin`.** Verified 2026-10-02:
   its `scripts/check-submission.mjs:258-264` requires some `package.json` in the repo to
   declare `dsh.bundle`, and a repo declaring only `dsh.client` is refused with
   "that alone is not installable". `dsh-plugin-reducer` and `dsh-canary` — both external
   CLIs, like this — return 0 hits in its generated list (4,412 entries). Submission would
   burn a CI-gated PR and be rejected on a rule that is correct: being listed there implies
   installability this tool intentionally does not have.

   Descriptor keys there are whitelisted (`scripts/lib/entries.mjs:136`:
   `url, name, category, description, tarball, file`; unknown keys fail CI), and an optional
   `tarball` must be an https GitHub-release-hosted URL ending in `.tgz` — which is why
   `release.yml` attaches exactly that.

   Where listing *is* appropriate:
   - `walkinglabs/awesome-deepseek-harness-plugins` → `docs/INCLUSION_POLICY.md` rule 4:
     "It is a client, launcher, or development resource … placed outside the plugin
     categories and labelled accordingly."
   - `awesome-deepseekharness/awesome-deepseek-harness` → `CONTRIBUTING.md`, category
     `🧩 Tools, Workflows & Presets`; it wants `README.md` (English) **and** `README.zh.md`
     entries at the same position, and its example PR title is
     `Add owner/repo to Category`.

   Neither has been submitted as of 2026-10-02.

4. **Add registry badges only after listing exists** (npm version/downloads, dshfind,
   marketplace). Pre-added badges resolve to 404. The `dsh-doctor` gate badge does not apply:
   its R/K/D gates score `dsh.bundle` packages, which this repository does not declare.

5. Re-check the CI badge in the README header resolves once the first workflow run is green:
   `gh run list --repo <you>/dsh-rehearsal`.

## Cutting a release

`release.yml` runs on a `v*` tag push and **refuses** in two cases, so the order matters:

```sh
npm test                                     # must be green, 61/61
# 1. BOTH changelogs — CHANGELOG.zh.md and CHANGELOG.md: move Unreleased content under a
#    new "## [X.Y.Z] - YYYY-MM-DD" heading in each (same versions, same order;
#    test/changelog.test.js asserts the pair), add the [X.Y.Z] link at the bottom, and
#    update the [Unreleased] compare range.
# 2. package.json: "version" must equal X.Y.Z exactly, in the same commit.
node scripts/release-notes.mjs vX.Y.Z        # prints exactly what the Release body will be
git add -A && git commit -m "…"
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git push origin publish-clean:main           # CI green first
git push origin "vX.Y.Z"                     # triggers the Release job
```

The Release body is generated from the tagged commit in **both languages**, with the two
install lines prepended — house style here is 中文（新增/修复/变更）→ 安装 → `---` → English
twin. A missing section in either changelog fails the job, so notes cannot be written
afterwards from memory.

To rebuild notes or assets for a tag that is already out there, use **Run workflow →
`release.yml` → tag** rather than moving the public tag: the job checks the tag out, so
`package.json` and the changelogs still come from the tagged commit even when this file
on `main` is newer.

Then verify the release actually carries what it claims:

```sh
gh release view "vX.Y.Z" --repo <you>/dsh-rehearsal \
  --json tagName,isDraft,isPrerelease,assets --jq '{tagName,isDraft,isPrerelease,assets:[.assets[].name]}'
# expect: draft=false, isPrerelease=false (unless the tag carries a `-`),
#         assets = dsh-rehearsal-X.Y.Z.tgz + dsh-rehearsal-X.Y.Z.tgz.sha256
```

A tag containing `-` (e.g. `v0.3.0-rc.1`) is marked `--prerelease` automatically, and
`publish.yml` will still attempt the npm publish — pass `--tag next` if a prerelease must not
take the `latest` dist-tag. Never commit `*.tgz` or `SHA256SUMS.txt`; both are in
`.gitignore`, because a committed checksum can go stale against the tarball the tag
actually points at.

## Three claims in the README depend on measurement

Keep them honest as releases move:

- the **compatibility table** separates tested from declared and names the verification
  date. Re-verify per release, or the table silently becomes fiction;
- the **coverage table** (drillable share and allowlist-pass share) is measured on one
  machine. If you republish it, re-measure; do not average it across users or present it as
  typical;
- the **prior-art table** describes other people's repositories, which change without
  telling you. Re-read their source before repeating any cell — a wrong claim about a
  competitor is the failure mode this section exists to avoid.
