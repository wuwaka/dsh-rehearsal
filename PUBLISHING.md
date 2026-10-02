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
npm test                                    # 52/52
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
2. Set the GitHub topic `dsh-plugin` so directory scrapers find it:
   `gh api repos/<you>/dsh-rehearsal -f "topics[]=dsh-plugin" -X PUT` (topics need the
   `repo` scope).
3. Submit to the community catalog: one file per plugin at
   `data/plugins/<owner>__<repo>.yml` (`.yml`, not `.yaml`), one pull request, CI-gated —
   <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>.
4. Only then add the registry badges (npm version/downloads, dshfind, marketplace) to the README.
   Do not pre-add them: they 404 until listed, and a badge that resolves to nothing is worse than
   no badge.
5. Re-check the CI badge in the README header resolves once the first workflow run is green:
   `gh run list --repo <you>/dsh-rehearsal`.

## Two claims in the README depend on measurement

Keep them honest as releases move:

- the **compatibility table** names the candidate version verified and the date. Re-verify per
  release, or the table silently becomes fiction;
- the **coverage table** (drillable share and allowlist-pass share) is measured on one machine. If
  you republish it, re-measure; do not average it across users or present it as typical.
