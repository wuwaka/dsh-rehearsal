# Changelog

[简体中文](CHANGELOG.zh.md) | [English](CHANGELOG.md)

> Version numbers below refer to `dsh-rehearsal`. The `dsh` version passed to `run --to` is the
> candidate runtime and is not recorded here as a release version.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Both files list the same sections in the same order (`test/changelog.test.js`), and `release.yml`
refuses to publish when either lacks the section for a tag.

## [Unreleased]

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
  ones cannot be that thin.

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
  `pre-existing`, because a mismatch that already exists today is not this
  upgrade's fault.
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

[Unreleased]: https://github.com/wuwaka/dsh-rehearsal/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.2.0
[0.1.0]: https://github.com/wuwaka/dsh-rehearsal/releases/tag/v0.1.0
