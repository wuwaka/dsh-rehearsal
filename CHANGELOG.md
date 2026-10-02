# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning:
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

One naming note, because it is easy to confuse: the version below is
**`dsh-rehearsal`'s own**. `run --to <version>` rehearses *someone else's*
version — the candidate `dsh` — and that number is never recorded here.

中文说明见 [README.md](README.md)；本文件保持英文，因为 `.github/workflows/release.yml`
直接把对应小节的正文取作 Release 说明。

## [Unreleased]

Nothing pending.

## [0.2.0] - 2026-10-02

Documentation and release integrity. No behaviour change to `check` or `run`.

### Changed

- **Four positioning claims were retracted** after reading the source of seven
  comparable projects, and the retractions stay in the history because they are
  the interesting part:
  - "runs from outside the host" is not a differentiator — `dsh-plugin-reducer`,
    `dsh-canary`, `dsh-plugin-doctor`, `dsh-backup`'s `dsh-rescue` bin and
    `zzy6-a/dsh-upgrade-guard`'s out-of-host supervisor all do;
  - the "a tool inside the profile dies when it matters" argument, which this
    README originally presented as its own, is `dsh-plugin-gating-hub`'s, written
    there verbatim; it is now quoted and attributed;
  - "attempts a write round" is not unique — `dsh-test-drive`'s `capability`
    stage really appends a turn and reads the durable session log. What is
    unique is doing it **without an API key**, against **migrated copies of your
    own sessions**;
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

These were found in four review rounds **before** 0.1.0 shipped, and are listed
because a tool whose product is a safety claim should not hide how it failed:

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
