# Changelog

[简体中文](CHANGELOG.zh.md) | [English](CHANGELOG.md)

> Version numbers below refer to `dsh-rehearsal`. The `dsh` version passed to `run --to` is the
> candidate runtime and is not recorded here as a release version.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Both files list the same sections in the same order (`test/changelog.test.js`), and `release.yml`
refuses to publish when either lacks the section for a tag.

## [Unreleased]

## [0.3.15] - 2026-10-06

### Changed

- In-package docs catch up with the repository: the README install pin moves to `v0.3.15` (the `0.3.14` package still pinned `v0.3.13`, pointing tag installs at an older release), the security summary gains the URL-userinfo credential line, and the architecture docs record the `--dump-config` fail-closed pre-check in suppression layer 2. The changelog's bottom link definitions gain the missing `0.3.13` / `0.3.14` / `0.3.15` entries and the `[Unreleased]` compare range resets. No code changes in this release — it exists to make that true.

## [0.3.14] - 2026-10-06

### Fixed

- SIGINT/SIGTERM/SIGBREAK/SIGHUP during `run` no longer leave the shadow home behind: cleanup used to live only in a `finally` block, which a signal arriving during a blocking `spawnSync` outflies — the process died with the plaintext session copies still on disk, the one exit path SECURITY.md's every-exit-path-deletes guarantee did not cover. The signal handler now removes the shadow home (and the prefix) before exiting; in addition, every `run` sweeps leftover `dsh-rehearsal-home-*` directories at startup, gated on this tool's ownership marker (a name that merely looks ours never authorises a delete).
- The write round is fail-closed about tool suppression (`src/lib/shadow.js`): `writeReplayPatch` used to parse `--dump-config` output without checking that the command succeeded, and zero suppressed rows was visible only as a log line. A failed dump, a dump that parses to no rows, or a suppression pass matching zero executor rows now aborts the write path — the stage details report `replay patch fail-closed (<reason>)` instead of continuing with unverified executors; `coverage.writeRounds.toolSuppression` records the outcome.
- Every id written into the replay patch is JSON.stringify'd — disable rows previously interpolated the id bare, inconsistent with the session-derived rows quoted since P2-7.
- Environment scrubbing covers URL-embedded credentials: a proxy or registry value like `http://user:token@host/` used to pass the name filter untouched and reach the child. Values that survive the name filter now have their userinfo stripped. The name filter's over-removal side (`AUTH` also matches `XAUTHORITY`) is kept deliberately — the error direction is giving a child less, never more — and SECURITY.md's guarantee now states exactly what is and is not covered.

### Changed

- `release.yml` passes the tag into the shell through the environment instead of `${{ }}` interpolation; all three workflows pin `actions/checkout` and `actions/setup-node` by commit SHA, and `persist-credentials: false` keeps git credentials from standing in jobs that never need them.
- `test/fixtures/` gains a README stating that the two `.asar` archives are hand-built containers around a factual package manifest (names and versions), holding no code, binary or artwork from the official application — settling the redistribution question. Regression locks: tests 129 → 140.

## [0.3.13] - 2026-10-05

### Fixed

- The npm install of the candidate now runs under a credential-stripped environment: with `--run-scripts`, dependency lifecycle scripts used to inherit the full parent environment, so the escape hatch that grants script execution also re-exposed host secrets. It now strips every credential-shaped variable, same rule as the candidate's own runs.
- CLI flags parse under one contract (`src/lib/args.js`): every `--dashed-flag` is stored under both its dashed and camelCase spelling — `--shadow-dir`, `--prefix-dir` and `--skip-write` from the command line used to be silently ignored because the parser stored one spelling while the command code read the other. Switches (`--run-scripts`, `--allow-tools`, `--keep`, `--skip-write`, `--yes`, `--full`) accept `=true`/`=false` explicitly, reject any other value, and never consume the next argument — `--yes=false` no longer reads as "confirmed".
- `clean`'s pre-marker fallback now checks structure, not only naming: a `.dsh-rehearsal` layout is cleanable only when each generated child carries its report (`report.json`/`report.md`) or is an interrupted run's empty directory.

### Changed

- README relative links that pointed at maintainer documents outside the npm tarball (PUBLISHING, AUDIT) are absolute GitHub URLs, so the shipped README has no dead relative links.
- The last review/date residue in production comments is gone; comments state why a rule holds, the audit trail stays in AUDIT.md and this changelog. Regression locks: test count 125 → 129.

## [0.3.12] - 2026-10-05

### Fixed

- Version-valued options are validated at the command boundary (`--candidate`, `--current`, `--to`): measured, `check --candidate nonsense` used to exit 0 with `upgrade-ok` — the comparison never ran and the verdict was assembled from nothing. An invalid version now fails with a readable error (exit 3) before any install or artifact write.
- `clean` gained ownership and dangerous-path guards: it removes only artifact directories bearing this tool's marker (or the pre-marker default layout); arbitrary directories, the home, the working directory and filesystem roots are refused even with `--yes`.
- Profile-local runtime markers follow the same three-state rule as desktop descriptors: a marker that exists but is unusable (corrupt, non-semver) resolves to `untrusted` and current stays unknown — it no longer falls through to a machine-level bundle answering with another install's version.
- `--writeRounds` and `--preset-mode` are validated (positive integer / `skip|patch`): a non-numeric budget used to become NaN, which disabled the cap and let the write round run unbounded; an unknown mode used to fall through to the default silently.
- The redaction invariant is structured: `privacy.redactionGapCount` records the surviving-token count, the scan now covers every field (warnings included), and the gap warning no longer echoes the leaked tokens themselves.
- Single-segment POSIX absolutes (`/tmp`, `/etc`) are scrubbed and invariant-checked; "any POSIX absolute path" now holds literally.
- `--shadow-dir` / `--prefix-dir` require ownership before anything is written: empty directories are adopted and marked, non-empty unmarked directories are refused.

### Added

- An npm-tarball boundary test (`test/pack.test.js`): user documentation ships with the package (SECURITY included, both languages), maintainer documents (AUDIT, PUBLISHING, internal plans) are pinned out.
- `dsh-rehearsal --help` now lists the `clean` command and its ownership behaviour.

### Changed

- Production comments state why a rule must hold instead of which review round introduced it; the audit trail lives in AUDIT.md and this changelog. Regression locks: test count 117 → 125.

## [0.3.11] - 2026-10-05

### Fixed

- Report redaction closes its last two gaps (review round 5, P1-1/P1-2): the home-path rules stopped at whitespace, so `C:\Users\John Smith\.dsh` leaked the surname and even an unspaced home kept everything after it (`~\AppData\Local\Temp\run-1` — both measured); home fields now consume to the field boundary with no tail (a clean home still normalises to `~`, a spaced field escalates to `<abs-path>`). And `writeReport()` is now fail-closed: when the invariant still finds path-shaped text it REFUSES to write (the earlier behaviour warned and wrote the leak anyway, contradicting the sanitised-before-disk promise).
- Untrusted runtime markers reach the report (P2-1): a descriptor that exists but fails validation is listed under `currentRuntime.untrusted` in the `b1` evidence and `coverage.host.runtimeUntrusted`, so a null `current` explains itself.
- Peer ranges that are not strings (`null`, numbers, objects) produce the `peer-range-unparseable` finding instead of reading as "no constraint" (P2-2); truly absent ranges (`undefined`, blank strings) stay unconstrained.
- Hardening: `looksLikeDshHome` requires the `dsh.profile.bundles` array (P2-5); the adoption-gate patch refuses to run when the candidate version is unreadable rather than guessing which backup is valid (P2-4); README, `--help` and SECURITY spell out that `--shadow-dir` / `--prefix-dir` are never auto-cleaned and are not covered by `clean` (P2-3).
- Regression locks for each item above (test count 114 → 117): spaced-home tails, the fail-closed refusal, untrusted propagation into the report, typed peer ranges, and the unknown-version gate.

## [0.3.1] - 2026-10-05

### Fixed

- Desktop bundle probes were not platform-filtered: the gate read a `platform` field off an object that does not carry one, so every platform probed every host's install paths (on macOS the Windows paths would be attempted first). The gate now filters catalog entries themselves, with a regression test that fails if win32 roots leak under a darwin platform.
- The official macOS probe joined an extra `resources` segment (`Contents/Resources/resources/app.asar`) and could never hit the real `Contents/Resources/app.asar` layout, leaving macOS users with `current = null` and conservative-high noise. Probe entries now declare their archive segments per platform, with darwin hit and doubled-path miss tests.
- The official fallback probe (`dsh/node_modules/@deepseek-ai/dsh/package.json` inside the archive) was dead code: every asar probe was parsed as a descriptor. Probes now declare a `kind`: a missing descriptor falls back to the in-archive package.json, while a descriptor that exists but fails validation stays unknown and is listed under `untrusted` — falling back there would bypass the descriptor's integrity cross-check.
- `writeReport()` no longer treats `privacy.scrubbed` as a skip token: it re-runs `finalize()` on every write. Measured gap: a field appended after a previous finalize reached disk unscrubbed while the flag still claimed clean.
- Unparseable peer ranges no longer read as a settled "excluded by both versions": a dedicated `peer-range-unparseable` warn finding says what is actually wrong, and the satisfies wrapper returns false on its belt-and-braces path instead of true.
- `--home=` (blank) now fails with a readable error instead of silently falling through to auto-discovery; the home gate requires the harness `dsh` field in a profile manifest (an unrelated project's `package.json` no longer qualifies); the adoption-gate backup re-seeds when a reused `--prefix-dir` gets a different candidate version; the npm-prefix probe's contract (only when `npm_config_prefix` is present) is stated in code and tests.
- Regression locks for each fix above (test count 106 → 114): cross-platform probe leakage, the darwin hit and the doubled-path miss, descriptor-absent fallback versus untrusted no-fallback, post-finalize mutation, unparseable peer ranges, and a blank `--home`.

## [0.3.0] - 2026-10-05

### Added

- Desktop-host compatibility: `check` and `run` discover the homes of the official DeepSeek Harness Desktop and community desktops (anywhere-labs `DSH Desktop`, dataelement `DSHDesktop`) without `--home` — when neither `--home` nor `DSH_HOME` is set and the default home is absent or not a real home, catalog candidates are probed and validated in registered order (a profile manifest or real session logs must exist); reports record the origin as a `target.homeOrigin` label, never a path.
- Version detection goes through the catalog: the official runtime lives inside `resources/app.asar`, read by a zero-dependency read-only asar reader from `dsh/desktop-runtime.json` (the `sharedPackages` array is searched for `@deepseek-ai/dsh` and cross-checked against `release.version`); a desktop-origin home trusts only its own host's bundle, conflicting bundled versions on a shared home resolve to null with the contenders listed as `currentAmbiguous`, and the npm global prefix only fills in when every other source misses.
- Desktop-sourced `run` rehearsals carry a scoping warning and a `coverage.host` block (`desktopRuntimeTested: false`): verdicts cover the npm dependency closure and the session data format, not the desktop app's own update channel; with pure-desktop ambiguity (no valid default home and ≥2 validating desktop homes) `run` demands an explicit `--home`, while `check` proceeds automatically.
- Discovery, probing and scoping come with 25 regression locks, from the catalog order drift-lock to a real-tool asar fixture and a dual-host version-conflict case (test count 81 → 106).

## [0.2.2] - 2026-10-04

Documentation, badges and install metadata, plus one internal constant consolidation. The behaviour of `check` and `run` is **unchanged**.

### Changed

- The assumed model context window `256000` is consolidated from two magic literals (the default entry in `extractRoutes` and the fallback in the shadow settings serializer) into one named constant, `ASSUMED_CONTEXT_WINDOW_TOKENS` in `util.js`, with a regression lock: the literal is allowed only at the constant's definition (test count 80 → 81).
- `SECURITY.md` now states the failure direction of the tool-suppression list (`TOOL_ROW_NAME_PREFIXES`): a list missing a new tool family leaves suppression incomplete but opens no execution path — the write round only replays tool calls that appear in the session's own recording and all passed the read-only allowlist, and `--allow-tools` (off by default) remains the outermost gate. A citation assertion backs it in the docs test.
- The README states its differentiators up front: a successful migration does not prove write-back (with the reason read-side static checks cannot decide this class, and a link to the seven-tool comparison); a new "why a standalone CLI" section; use-case questions rewritten as statements; the hard-coded test count removed; `report` and `clean` named.
- `SECURITY.md` states each boundary once: duplicate paragraphs and anthropomorphic phrasing removed. `PUBLISHING.md` is narrowed to the release runbook, with maintainer knowledge (the catalogue investigation, repository images, documentation governance, the add-a-signature procedure) moved into the new `docs/MAINTAINING.md`; the procedure moved out of `docs/FAILURE_MODES.md`, which is now pure reference.
- The install section gains the npm registry path (`dsh-rehearsal@0.2.1` was published on 2026-10-03); the badge row gains the npm version badge and a `listed in awesome-deepseek-harness` badge (`Dominic789654/awesome-deepseek-harness#579` merged).
- The npm `keywords` drop `dsh-plugin`, aligning with the GitHub topics convention (anti-spam crawlers strip non-plugins carrying that tag).

## [0.2.1] - 2026-10-03

Documentation and release verifiability. The behaviour of `check` and `run` is **unchanged**.

### Changed

- The README was cut from 247 lines to roughly 130, keeping only positioning, install, quick start, a real output sample, reports, coverage, a safety summary, compatibility and limitations. Everything moved out went into the new `docs/architecture.md`.
- The front page no longer argues for its own existence: the external-CLI rationale, the comparable-tools table, the three-layer write-round internals and the multi-frame zstd measurements now live in the architecture and security documents.
- Added the boundary the whole tool turns on: **a successful migration does not prove the migrated session can still be written to**.
- "No API key required" was made precise: the write round replays through `@deepseek-ai/dsh-llm-replay` and issues no live model request.
- Terminology unified (pre-flight / rehearsal / migration / write round); status vocabulary fixed to Tested / Inferred / Not tested / Unsupported / Not covered.
- Removed audit-voice phrasing such as "self-evidenced by the report" and "verified line by line against their source".
- `SECURITY.md` restructured into: guarantees, explicitly dangerous options, reports are sensitive data, out of scope, self-check procedure, reporting.
- `AUDIT.md` is now marked as a historical baseline document (baseline `7c374bc`) with a per-finding status overview; `FIXES.md` was folded into it as a remediation section and deleted, removing the overlap with AUDIT, this changelog and git history.
- `PUBLISHING.md` became a checklist first, with the incident narrative moved out.
- Every document is a bilingual pair. `test/docs.test.js` asserts the pair exists, section counts match, `file:line` citations, issue numbers and commit hashes agree, language switch lines resolve, and no document drifts back into first person (test count 61 → 68).
- Added repository images `assets/poster.jpg` and `assets/social-preview.jpg`.

### Fixed

- The `a-inventory` `details` string interpolated the raw `DSH_HOME` and relied on the `finalize()`
  regexes to mask it. Those regexes cover `C:\Users\<n>`, `/home/<n>`, `/Users/<n>` and any
  drive-rooted path, but **a relative `--home`, a UNC share, or a Unix home outside `/home` such as
  `/srv/users/<n>` reached the report verbatim** (measured A/B: `home=dsh-home` leaked before the
  change, `home=custom` after). The field now records a shape, so no path enters the string.
- `report.tool.version` was hard-coded to `0.1.0` and had drifted from `package.json`; it is now read
  from `package.json`.
- Regression locks: `homeShape` must never return a value containing a path separator, and an
  end-to-end `check` with a **relative** `--home` asserts that the path appears nowhere in the report
  (test count 68 → 70).
- The change above only kept one call site away from the filter; the gap in `scrubText` itself
  remained. `/root/.dsh` (the default home for root, and the normal case in containers),
  `/var/lib/<service>`, `/srv/<team>`, `/tmp/<shadow>`, UNC shares and `../` relative paths all passed
  through untouched. Fixed as a **class** this time: the filter now covers those shapes, with tests
  pinning that URLs and repository-relative text are not over-masked; `scrubValue` redacted values but
  not object keys, so a path used as a key bypassed redaction entirely and now does not; and
  `finalize()` gained an invariant that re-scans the whole report with the same detector and records
  any surviving path-shaped text in `warnings[]` (`redaction gap: …`), so a future stage that composes
  an unknown style admits it instead of publishing the path silently (test count 70 → 73).

- `privacy.scrubbed: true` was set in `newReport()`, i.e. the report claimed to be scrubbed at
  construction time. The redaction-gap invariant lives inside `finalize()`, so the scenario raised in
  review — a stage that bypasses `finalize()` — was **not** covered by it. The field is now written by
  `finalize()` from the invariant's own result, so a report that did not fully pass reports `false`,
  and `writeReport()` became the single writer that finalizes an un-finalized report on the way to disk.
- `check` without `--candidate` printed `0 newly-broken high` as if it were a result. That number is
  now labelled: the stage reports `warn`, its details say the comparison was not exercised, a
  `warnings[]` entry says the same, and the exit code is `1` rather than `0`.
- `defaultHome()` reached `path.join(undefined, '.dsh')` when both `USERPROFILE` and `HOME` are absent
  (a bare container), throwing a raw `TypeError`; it now falls back to `os.homedir()` and then the
  working directory. Fixing it exposed a drift in the same area: `homeShape()` recomputed the default
  location itself and disagreed with the hardened `defaultHome()`, labelling a genuine default as
  `custom`; the caller now passes one source of truth in (test count 73 → 78).

- Line citations in documentation go stale as code moves, and until now nothing could detect it.
  Four real failures fixed this round: `SECURITY` pointed at line 136 of `src/lib/report.js`, which was
  unrelated code after `finalize()` moved (it sits at line 199 now); the "must not be over-masked"
  example was written as line 12 of `src/lib/x.js`, a file that does not exist; the
  `docs/FAILURE_MODES` range on `src/lib/drill.js` was 311-313, off by one (312-314); and a citation of
  line 875 of the gating-hub changelog collided with the repository's own file of that name, so it now
  carries the `dsh-plugin-gating-hub/` owner prefix.
- Two assertions added (test count 78 → 80): every path cited by a living document must either exist
  in this repository or be qualified with its owner on the same line, and every in-repo `file:line`
  citation must be backed by an assertion that the cited line really contains what the docs claim it
  for — a new unasserted citation fails the suite rather than drifting silently. `AUDIT.md` is
  deliberately excluded: it describes the baseline commit it names, so checking its numbers against
  HEAD would be wrong in both directions.

## [0.2.0] - 2026-10-02

Documentation and release integrity. No behaviour change to `check` or `run`.

### Changed

- **Four positioning claims were retracted** after reading the source of seven
  comparable projects. The retractions are recorded rather than edited away:
  - "runs from outside the host" is not a differentiator — `dsh-plugin-reducer`,
    `dsh-canary`, `dsh-plugin-doctor`, `dsh-backup`'s `dsh-rescue` bin and
    `zzy6-a/dsh-upgrade-guard`'s out-of-host supervisor all do;
  - the "a tool inside the profile dies when it matters" argument, which the
    README originally presented as its own reasoning, is
    `dsh-plugin-gating-hub`'s, written there verbatim at `README.zh.md:282`;
    it is now quoted and attributed;
  - "attempts a write round" is not unique — `dsh-test-drive`'s `capability`
    stage really appends a turn and reads the durable session log. What is
    unique is doing it **without an API key**, against **migrated copies of the user's own sessions**;
  - `dsh-canary` was credited with a GitHub Action and a `v1` report schema. It
    has neither.
- Boot-failure isolation in `dsh-plugin-gating-hub` is described correctly: it
  names the culprit **from the boot log** and disables it, rather than measuring
  slow startup.
- The compatibility table now separates **tested** from **declared**, per row,
  with dates — including the honest admission that the Node 24.x leg and every
  non-Windows `run` are unverified locally, and that two `warn` signatures have
  never actually fired here.

### Added

- `docs/FAILURE_MODES.md`: every log pattern the tool keys on, each anchored to
  an upstream issue number where one exists (`#1229`, `#1294`), plus what a
  *non*-hit does not prove. Patterns that cannot be reproduced on this machine
  are marked as such instead of implied as tested.
- Signature regression locks: each pattern must hit its real log line and must
  **not** hit a healthy one, and a test now fails if a signature exists in code
  but is missing from the doc (`test/signatures.test.js`; suite 52 → 57).
- `CHANGELOG.md` in this format.
- `.github/workflows/release.yml`: tag pushes cut the GitHub Release, refusing
  when the tag does not equal `package.json`'s version or when this file has no
  section for the version. It attaches the packed tarball plus a `.sha256` so
  the pinned install line is verifiable to the byte, and generates the release
  body from the matching section below.
- `SECURITY.md` and issue templates with mandatory environment fields
  (`dsh` version, OS, Node, tool version) and a privacy gate: **no session
  content in reports or issues**.

### Fixed

- `--help`, `-h`, `-V` and `--version` used to fall through to the
  unknown-command branch and exit `3` — the code this README documents as "the
  rehearsal itself failed". Caught only by installing the packed tarball into a
  throwaway prefix and running the bin; running the sources does not hit it.
- `v0.1.0` was published as a GitHub Release with **no notes and no assets**.
  It stays as it is (immutable); this release establishes the pipeline so later
  releases always carry notes and assets.

## [0.1.0] - 2026-10-02

First published version. Two commands, one decision: `check` for static
pre-flight, `run` for a real rehearsal in a throwaway `DSH_HOME`.

### Added

- **`check --candidate <version>`** — read-only, no downloads, seconds. Live
  profile detection (never defaults to `web`), full patch-layer resolution
  (profile layer + home-level `cordis.patch.yml`), exact versions from
  `pnpm-lock.yaml`, pnpm workspace policy, and a peer graph covering
  plugin↔dsh, plugin↔plugin, `@deepseek-ai/cordis` multi-pin conflicts,
  enumerated prerelease ranges (`^0.1.7-rc.2` does not match `0.2.0-rc.2`) and
  non-reproducible `link:` / `file:` / `github:` specs.
- **Peer findings are graded by direction**: only "satisfied today, unsatisfied
  in the candidate" is blocking `high`; both-unsatisfied is recorded as
  `pre-existing`, because a mismatch that already exists today was not
  introduced by this upgrade.
- **`run --to <version>`** — installs the candidate into a private npm prefix,
  boots it twice, copies real sessions into a shadow home, triggers the lazy
  `v0→…→v4` migration on those copies, verifies read-side integrity, then
  attempts one **keyless write round** through the official
  `@deepseek-ai/dsh-llm-replay` adapter.
- **Three independent safety layers** for the write round: sandboxed `cwd`
  rewrite (header `cwd` *and* the encoded workspace directory, which the host
  derives from each other), tool-provider rows suppressed by id and package
  name prefix, and a fail-closed read-only allowlist over the four row shapes a
  tool call can appear in (`tool/call`, `tool-call-chunks`,
  `tool/ptc-dispatch`, `tool/code-dispatch[·start]`).
- **`dsh-rehearsal/v1` report** (`report.json` + `report.md`) with per-stage
  records, a fixed `coverage` section, top-level `warnings[]`, a `privacy`
  block describing what was stripped, and machine-readable exit codes
  `0` upgrade / `1` upgrade with conditions / `2` do not upgrade /
  `3` the rehearsal itself failed.
- **`--preset-mode patch`** to include sessions carrying an `agentPreset`
  (format-level conclusions only, labelled as such), with plain-first sampling
  and a preset floor of one.
- **`docs/FAILURE_MODES.md`** — every log pattern the tool keys on, anchored to
  an upstream issue number where one exists, each with a matched pair of
  regression assertions.
- CI on Windows / macOS / Linux × Node 22.19 and 24.x, plus an assertion that
  `node:zlib` still exposes the zstd API and that no test leaves a fixture home
  in the user directory. CI never executes `run`.
- `publish.yml`: re-tests, installs the packed tarball into a throwaway prefix,
  smoke-runs the installed bin, then `npm publish --provenance`. Skips itself
  when `NPM_TOKEN` is absent rather than showing a red pipeline.

### Fixed

Found in four review rounds before 0.1.0 shipped. Pre-release defects are recorded
because the tool's conclusions depend on its safety claims being auditable:

- a write round could **actually execute** recorded tool calls → default
  suppression plus the fail-closed allowlist (audit item P0-1);
- replayed message prose reached reports through `stderr` tails → diagnostic
  whitelist, with dropped-line counts (`P1-1`);
- evidence objects were not scrubbed recursively → per-string redaction
  (`P1-2`);
- Windows paths containing spaces leaked their tails: the masking rule stopped
  at the space, so `D:\Work\a b\c.log` published ` b\c.log` (`P1-3`);
- `--help` / `-h` / `--version` fell through to the unknown-command branch and
  exited **`3`**, which the README documents as "the rehearsal failed". Found
  only by installing the packed tarball and running the bin, not by running the
  sources;
- verdicts derived from process exit codes: a *successful* keyless migration
  exits `1` with `MISSING_CREDENTIAL` → all verdicts are now artifact-driven;
- multi-frame zstd silently decoded only the first frame via `node:zlib`
  (a 3.7 MB file yielded 233 bytes / 1 line) → own frame scanner;
- proportional session sampling starved the non-preset stratum (`--sample 9`
  shrank it to 3, all three blocked by the allowlist, leaving only preset
  sessions whose write rounds are structurally undecidable) → plain-first with a
  preset floor of one, plus `writeRoundVerdict()` aggregating over non-preset
  rounds only;
- the desktop shim on `PATH` ignores `DSH_HOME` and writes into the real home
  (this happened during development) → the tool only ever uses the binary it
  installed itself;
- candidate installs ran every package lifecycle script → default
  `--ignore-scripts`, with `--run-scripts` to opt in explicitly.

### Notes on measurement

- The compatibility table in the README names the candidate version verified
  and the date; it goes stale on its own schedule and must be re-verified.
- Coverage was measured on one machine on 2026-10-02: 52 sessions → 24 drillable
  (46%) → 5 passing the read-only allowlist (9.6% of the library). Migration
  rehearsal is broad, write-path rehearsal is narrow, and the two must not be
  quoted interchangeably.

[Unreleased]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.15...HEAD
[0.3.15]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.1...v0.3.11
[0.3.1]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.2.0
[0.1.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.1.0
