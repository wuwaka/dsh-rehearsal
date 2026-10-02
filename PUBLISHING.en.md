[简体中文](PUBLISHING.md) | [English](PUBLISHING.en.md)

# Release checklist

## Before releasing

- [ ] `npm test` is green
- [ ] Working tree clean, nothing unexpected in `git status`
- [ ] `.dsh-rehearsal/`, `*.tgz` and `SHA256SUMS.txt` are untracked (already covered by `.gitignore`)
- [ ] No credentials or local paths in tracked files: `git grep -nE "<TOKENS>"` (the reader fills in the tokens; a command that hard-codes them matches the document itself)
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

- [ ] **npm publish**: set `NPM_TOKEN`, then `gh workflow run publish.yml --repo <you>/dsh-rehearsal --ref vX.Y.Z`. The job skips rather than failing when the secret is absent.
      The default registry in this machine's `~/.npmrc` is a read-only mirror that answers 404 for `npm whoami` and cannot accept a publish, so publishing runs in CI or passes `--registry https://registry.npmjs.org` explicitly.
- [ ] **Topics**: `gh api repos/<you>/dsh-rehearsal -X PUT -f "topics[]=deepseek-harness" -f "topics[]=dsh" -f "topics[]=cli" -f "topics[]=upgrade" -f "topics[]=rehearsal"`. `dsh-plugin` is a search affordance only; this repository is deliberately not a `dsh plugin add` bundle.
- [ ] **Do not submit to the `awesome-dsh-plugin` catalogue**: its `scripts/check-submission.mjs:258-264` requires some `package.json` to declare `dsh.bundle`, and declaring only `dsh.client` is refused. `dsh-plugin-reducer` and `dsh-canary`, both external CLIs, return 0 hits across its 4,412 entries. The right listings are tool catalogues: `walkinglabs/awesome-deepseek-harness-plugins` `docs/INCLUSION_POLICY.md` rule 4, and `awesome-deepseekharness/awesome-deepseek-harness` `CONTRIBUTING.md` (🧩 Tools). Neither has been submitted as of 2026-10-03.
- [ ] Add registry badges only once a listing exists. The `dsh-doctor` gate badge does not apply: its R/K/D gates score `dsh.bundle` packages.
- [ ] Confirm the CI badge resolves: `gh run list --repo <you>/dsh-rehearsal`.

## Repository images and social preview

- `assets/poster.jpg` (1774×887, 233 KB) is the poster at the top of both READMEs. The markup follows `wuwaka/dsh-clipboard-menu`: the first line inside `<div align="center">` is `<img src="assets/poster.jpg" width="620" alt="…">`, with the alt text written as a checkable description. `dsh-plugin-gating-hub` uses `width="1170"` (full content width); at 620 the poster's subtitle text reads small, and that single number is the knob.
- `assets/social-preview.jpg` (1280×640, 153 KB) is the repository social preview image, uploaded by hand under Settings → General → Social preview. There is no endpoint for this step: checked on 2026-10-03, the REST repository object exposes no social-preview field. It controls what shows when the repository URL is shared or unfurled, not the GitHub search results list.
- Both files regenerate from one source poster (the 1.88 MB original is not committed):

  ```sh
  python - <<'PY'
  from PIL import Image
  src = Image.open('poster-source.png').convert('RGB')          # 1774x887, 2:1
  src.save('assets/poster.jpg', quality=88, optimize=True, progressive=True)
  src.resize((1280, 640), Image.LANCZOS).save(
      'assets/social-preview.jpg', quality=90, optimize=True, progressive=True)
  PY
  ```

- Relative image paths generally do not resolve on the npm package page, so the poster is expected to render on GitHub only. Not verified: the package is unpublished, and this needs re-checking after the first npm publish.

## Clean branch and history

The public `main` is pushed from `publish-clean`. The local `main` is the audit trail (recorded in `AUDIT.md`) and has no upstream, so it cannot be pushed by accident. The reason is a pre-scrub snapshot inside local history: `git push` publishes history, not just the tip.

When syncing the public tree, note that `git checkout main -- .` **does not delete** files that `main` removed; a superseded script reached the public tree that way once. This gate is required before pushing:

```sh
git checkout -q publish-clean && git checkout main -- . && git add -A
git commit -m "Sync clean tree: …"
[ -z "$(git diff main publish-clean)" ] && echo "GATE OK" || echo "GATE FAIL: do not push"
```

## Documentation rules

- Every document is a bilingual pair: `README`, `CHANGELOG`, `SECURITY`, `PUBLISHING`, `AUDIT`, `docs/architecture`, `docs/FAILURE_MODES`. `test/docs.test.js` fails when a twin is missing, when `## ` section counts diverge, when the `file:line` citation sets differ, when issue numbers or commit hashes differ, when a language switch line points at a missing file, or when a document drifts back into first person.
- Prose is impersonal, with the citation next to the claim. Verify with `grep -c` on first-person markers and `——`, not by eye.
- Three claims depend on measurement and go stale on their own schedule: the compatibility table (separates Tested from declared, names the date, re-verify per release), the coverage table (one machine's numbers; re-measure rather than average across users), and the comparable-tools table in `docs/architecture.md` (it describes other people's repositories — re-read their source before repeating any cell).
