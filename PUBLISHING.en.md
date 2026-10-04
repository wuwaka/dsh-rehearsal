[简体中文](PUBLISHING.md) | [English](PUBLISHING.en.md)

# Release checklist

## Before releasing

- [ ] `npm test` is green
- [ ] Working tree clean, nothing unexpected in `git status`
- [ ] `.dsh-rehearsal/`, `*.tgz` and `SHA256SUMS.txt` are untracked (already covered by `.gitignore`)
- [ ] No credentials or local paths in tracked files: `git grep -nE "<TOKENS>"` (`<TOKENS>` are filled in by the reader; the reason is in [SECURITY.en.md](SECURITY.en.md))
- [ ] README and both changelogs updated

## Version

- [ ] `package.json` `version` equals `X.Y.Z`
- [ ] `CHANGELOG.md` and `CHANGELOG.zh.md` each gain a `## [X.Y.Z] - YYYY-MM-DD` section, same versions, same order
- [ ] The `[X.Y.Z]` link at the bottom of both files and the `[Unreleased]` compare range are updated

`test/changelog.test.js` asserts that the two files list the same sections in the same order, that every release section carries a date, and that the newest section equals `package.json`'s version.

## Tag and push

```sh
npm test
node scripts/release-notes.mjs vX.Y.Z     # prints exactly what the Release body will be
git add -A && git commit -m "…"
git tag -a "vX.Y.Z" -m "vX.Y.Z"
git push origin publish-clean:main        # wait for CI to go green first
git push origin "vX.Y.Z"                  # triggers the Release job; this is a public action
```

`release.yml` stops in two cases: the tag does not match `package.json`, or either changelog lacks the section. A tag containing `-` is marked `--prerelease` automatically, and `publish.yml` will still attempt the npm publish; pass `--tag next` when a prerelease must not take the `latest` dist-tag.

To rebuild the notes or assets of a tag already published, use **Run workflow → `release.yml` → tag** instead of moving a public tag: the job checks the tag out, so `package.json` and the changelogs still come from the tagged commit.

## Verify the release

```sh
gh release view "vX.Y.Z" --repo <you>/dsh-rehearsal \
  --json tagName,isDraft,isPrerelease,assets --jq '{tagName,isDraft,isPrerelease,assets:[.assets[].name]}'
```

- [ ] `draft=false`, and `isPrerelease` matches the tag shape
- [ ] Assets are `dsh-rehearsal-X.Y.Z.tgz` and `.tgz.sha256`
- [ ] `sha256sum -c` passes after downloading
- [ ] Both install paths produce a working executable: `npm install -g github:<you>/dsh-rehearsal#vX.Y.Z`, and the tarball

## After the repository is public

- [ ] **npm publish**: set `NPM_TOKEN`, then `gh workflow run publish.yml --repo <you>/dsh-rehearsal --ref vX.Y.Z`. The job skips rather than failing when the secret is absent. The default registry on this machine is a read-only mirror: publish through CI or with an explicit `--registry` (see [docs/MAINTAINING.md](docs/MAINTAINING.md)).
- [ ] **Topics**: `gh api repos/<you>/dsh-rehearsal -X PUT -f "topics[]=deepseek-harness" -f "topics[]=dsh" -f "topics[]=cli" -f "topics[]=upgrade" -f "topics[]=rehearsal"`. `dsh-plugin` is a search affordance only; this repository is deliberately not a `dsh plugin add` bundle.
- [ ] **Catalogue submissions**: the `awesome-dsh-plugin` catalogue refuses external CLIs. The investigation, submission status and badge timing live in [docs/MAINTAINING.md](docs/MAINTAINING.md).
- [ ] Confirm the CI badge resolves: `gh run list --repo <you>/dsh-rehearsal`.

## Clean branch and history

The public `main` is pushed from `publish-clean`. The local `main` is the audit trail (recorded in `AUDIT.md`) and has no upstream, so it cannot be pushed by accident. The reason is a pre-scrub snapshot inside local history: `git push` publishes history, not just the tip.

When syncing the public tree, note that `git checkout main -- .` **does not delete** files that `main` removed; a superseded script reached the public tree that way once. This gate is required before pushing:

```sh
git checkout -q publish-clean && git checkout main -- . && git add -A
git commit -m "Sync clean tree: …"
[ -z "$(git diff main publish-clean)" ] && echo "GATE OK" || echo "GATE FAIL: do not push"
```

Maintainer knowledge (the catalogue investigation, repository images, documentation governance, the local environment, and the add-a-signature procedure) lives in [docs/MAINTAINING.md](docs/MAINTAINING.md).
