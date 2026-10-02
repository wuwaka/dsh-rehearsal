<div align="center">

# dsh-rehearsal

Upgrade rehearsal tool for DeepSeek Harness (`dsh`): loads your plugin set and copies of your real sessions against a candidate version in a fresh `DSH_HOME`, requires no API key, and produces a verifiable upgrade decision report.

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe?style=flat-square)](https://github.com/topics/dsh-plugin)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#compatibility)

*A standalone command-line tool, not distributed as a `dsh plugin add` bundle.*

</div>

---

<details>
<summary>Contents</summary>

- [What this is](#what-this-is)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Why an external CLI](#why-an-external-cli)
- [Compatibility](#compatibility)
- [Safety by construction](#safety-by-construction)
- [Coverage](#coverage)
- [How this differs from existing tools](#how-this-differs-from-existing-tools)
- [Known limits](#known-limits)
- [Verifying that the real home was not touched](#verifying-that-the-real-home-was-not-touched)
- [Development and releases](#development-and-releases)

</details>

## What this is

| Command | Purpose |
| --- | --- |
| `check --candidate <version>` | Static pre-flight: read-only, no downloads, seconds. Detects the profile actually in use, resolves patch layers and exact versions, analyses the peer graph (separating breakage introduced by this upgrade from pre-existing mismatch), and reports session-generation distribution |
| `run --to <version>` | Live rehearsal: installs the candidate into a private prefix → two cold boots → triggers the lazy `v0→…→v4` migration on copies of real sessions → read-side integrity → a keyless write round through the official `@deepseek-ai/dsh-llm-replay` |

Emits a `dsh-rehearsal/v1` report (`report.json` and `report.md`). Exit codes are script-readable: `0` upgrade · `1` upgrade with conditions · `2` do not upgrade · `3` the rehearsal itself failed.

## Install

By tag, no npm account required (verified since 0.1.0):

```sh
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0
dsh-rehearsal check --candidate 0.2.0-rc.2
```

To pin an install to exact bytes, use the Release tarball and its checksum:

```sh
curl -sSLO https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz
curl -sSL -O https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz.sha256
sha256sum -c dsh-rehearsal-0.2.0.tgz.sha256
npm install -g ./dsh-rehearsal-0.2.0.tgz
```

## Quick start

```sh
dsh-rehearsal --version                               # confirm the executable is in place
dsh-rehearsal check --candidate 0.2.0-rc.2            # read-only pre-flight, seconds
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20         # full rehearsal: installs the candidate and copies sessions; 2-5 min first time
dsh-rehearsal clean --yes                             # remove .dsh-rehearsal output
```

From source:

```sh
git clone https://github.com/wuwaka/dsh-rehearsal.git && cd dsh-rehearsal
npm install && npm test
node src/cli.js check --candidate 0.2.0-rc.2
```

Common flags: `--profile`, `--home`, `--current` (override auto-detection), `--full`, `--preset-mode patch`, `--writeRounds N`, `--skip-write`, `--allow-tools`, `--run-scripts`, `--keep`, `--shadow-dir`, `--prefix-dir`.

To have a terminal-capable agent run the read-only pre-flight, paste:

> Perform a read-only DeepSeek Harness upgrade pre-flight on this machine. Clone or update `https://github.com/wuwaka/dsh-rehearsal`, run `npm install`, then run `node src/cli.js check --candidate <target version>`. Report the verdict, the plugin and peer range behind every `high` finding, and the session generation distribution. Do not run `run` without explicit approval (it installs the candidate and replays copies of sessions). Do not modify any profile or `~/.dsh` file. Do not print credentials.

## How it works

### `check`, static pre-flight

- Identifies the profile in use rather than defaulting to `web`. On one machine the `desktop` profile carried 11 bundles and 198 patch lines while `web` had 4 / 4.
- Resolves the patch layers in order (`dsh.profile.bundles` → the profile's `cordis.patch.yml` → the home-level `cordis.patch.yml` → `--patch`), takes exact versions from `pnpm-lock.yaml`, and reads the `pnpm-workspace.yaml` policies that change install semantics (`autoInstallPeers`, `allowBuilds`, `minimumReleaseAgeExclude`).
- Analyses the peer graph: plugin↔dsh, plugin↔plugin, `@deepseek-ai/cordis` multi-pin conflicts, enumerated peer ranges (`^0.1.7-rc.2` does not match `0.2.0-rc.2`; a prerelease caret does not cross versions), and non-reproducible `link:`, `file:` and `github:` specs.
- Each finding is classified as introduced by this upgrade or already present. A mismatch unsatisfied on both sides is recorded as `pre-existing` and is not blocking.

### `run`, the rehearsal

```
install the candidate into a private prefix (--ignore-scripts by default)
  → two cold boots (upstream #1294 documents a first cold boot failing while an
    identical configuration boots successfully on the second attempt)
  → trigger the lazy migration on copies of real sessions (v0 → … → v4)
  → read-side integrity (full multi-frame decode, contiguous seq, balanced turn nesting)
  → one keyless write round via the official @deepseek-ai/dsh-llm-replay
```

The write round is what separates this from the other pre-checks. Format migration is lazy and happens only when a session opens, and read-side checks pass data that opens but cannot be written: upstream [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) documents a session that opens normally and fails on every turn. `dsh-llm-replay` reconstructs model responses from the session's own recording, so writing once needs no API key.

### Report structure

One record per stage (`verdict`, `durationMs`, `details`, `evidence`), with stage fields aligned to `dsh-test-drive/v1`, plus a fixed `coverage` section, top-level `warnings[]`, and a `privacy` block describing what was stripped.

## Why an external CLI

The observation that a tool living inside the profile under test fails exactly when it is needed comes from [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) (`README.zh.md:282`: "a console that cannot boot cannot gate anything"); the same reasoning produced `@xiaoyuyu6420/dsh-backup`'s dependency-free `dsh-rescue` and `zzy6-a/dsh-upgrade-guard`'s out-of-host supervisor. Running outside the host is not the differentiator. The differentiator is these four conditions holding at once (each verified against the other project's source, 2026-10-02):

| Condition | State of comparable tools |
|---|---|
| Installs a candidate core version, into a private prefix | `@mars.liu/dsh-canary` L1 can pin a `dsh` version but reuses the profile's `node_modules`; `@linxin666/dsh-doctor`'s rescue capsule gates a candidate in an isolated `DSH_HOME` and promotes atomically, but pins the current version, for recovery rather than rehearsal |
| Reads the user's historical sessions | only `dsh-backup` reads session logs, and `lib/index.js:512` marks it "read-only scan, writes no files" |
| Completes migration inside a host that actually booted | the tools that read sessions do not boot a host; those that boot one do not read sessions |
| Runs the write round with no API key | `dsh-test-drive`'s `capability` stage does drive a headless task and re-reads the durable session log, but requires `DEEPSEEK_API_KEY` and is recorded as `skipped` without one |

The fourth row is independently checkable: `gh search code "@deepseek-ai/dsh-llm-replay"` (2026-10-02) returns only the upstream repository `deepseek-ai/deepseek-harness`, its forks, and vendored documentation — no third-party tool consumes that package.

Mechanically, the candidate `dsh` is a child process this project npm-installs into a private prefix under its own `DSH_HOME`. It cannot reach the live profile; the rehearsal still runs when the installed harness cannot start; every conclusion maps to an artifact on disk rather than to logs read by eye.

Division of labour with the official gate: `dsh-plugin-manager` enforces declared peer ranges at install and startup and offers exact-version exemptions (`dsh plugin allow-version … --accept-risk`), which is a runtime guardrail. This tool answers the earlier question — what happens when moving to a given version, including session data exposed only when written. The two are complementary.

## Compatibility

The table separates what was tested from what is merely declared. For a tool informing an upgrade decision, the currency of its own test environment is itself information that has to be disclosed.

| Component | Tested | Declared / not verified |
|---|---|---|
| Candidate `dsh` | `0.2.0-rc.2`, `--sample 9 --preset-mode patch`: 9/9 real sessions completed `v0→v4`, one keyless write round `pass` (2026-10-02, one machine) | earlier rcs and stable were never rehearsed; `check` only parses files and installs nothing |
| Current runtime detection | probes the profile's `node_modules` → shared `profiles/node_modules` → the DSH Desktop bundle (`…/resources/app/node_modules/@deepseek-ai/dsh`) → the npm prefix | `run` against a Desktop-internal candidate is unsupported, see the design decision below |
| Session generations | `v0` (`session.jsonl.zstd`), `v3`, `v4`; the `v0→…→v4` chain ran against real logs | `v1`, `v2` have generation detection only, with no real-world sample |
| Node.js | local 22.22.2; CI covers 22.19 and 24.x across six combinations (the 24.x leg is CI-verified only) | `engines.node: >=22.19`, requires `node:zlib` zstd (added in v22.15.0, still *Stability: 1 – Experimental*) |
| Platform | end-to-end on real Windows; macOS / Linux run CI only, and CI executes `npm test` alone | `run` has never rehearsed real sessions on macOS or Linux |
| Package manager | `npm`, located without `PATH` assumptions, used only to install the candidate into a private prefix | installs nothing into a profile and does not require pnpm |
| Runtime dependencies | one: `semver` | — |
| Credentials | none required at any stage, see [Safety by construction](#safety-by-construction) | — |

Unsupported by design: rehearsing the Electron-owned `desktop` profile through the npm CLI. `dsh` refuses it (`profile "desktop" is managed exclusively by the Electron application`), and an npm-installed candidate is a different dependency closure from the Desktop bundle. `check` still covers a `desktop` profile; `run` targets npm or self-hosted `web` and `headless` profiles.

## Safety by construction

Suppression of the write round is implemented in three independent layers; no single layer would support the conclusion:

1. Sandboxed cwd. `copySet` rewrites each copy's header `cwd` to `<shadow>/workspace/<n>` and relocates the copy into the matching encoded workspace directory. The host derives the physical session path from `header.cwd`, so both must change together. No process runs with the real workspace as its root.
2. Tool providers disabled by default. The replay patch suppresses tool rows by both row id and package-name prefix (`dsh-tool-`, `dsh-mcp-`, `dsh-skill`, `dsh-browser`, `dsh-terminal`, `dsh-jobs`, `terminal-`). The `tools` registry row is retained because the agent loop depends on it. Replayed calls return `isError` instead of executing.
3. Read-only allowlist (fail-closed). A replay can only emit tools that appear in that session's own history, so the pre-screen is complete information rather than an estimate. A session is drilled only when every historical tool belongs to the known read-only built-in set; `mcp__*` prefixes, execution and write classes, unknown third-party tools and unnamed rows are skipped with the reason recorded. Tool names are extracted from four row shapes (`tool/call`, `tool-call-chunks`, `tool/ptc-dispatch`, `tool/code-dispatch[·start]`); scanning only `tool/call` silently misses a large set.

Fixed constraints:

- Keyless. Environment variables shaped like credentials (`API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY|AUTH`) are stripped from every child process; reports record only the stripped names, never values. No tokens are spent and nothing is sent to a provider.
- Telemetry disabled. `DSH_TELEMETRY_MODE=DISABLED` (candidate `0.2.0` defaults to `FEEDBACK_ONLY`, whose OTLP endpoint bypasses the proxy).
- Verdicts derive from artifacts, never from exit codes. A successful keyless migration exits `1` with `MISSING_CREDENTIAL`; `--dump-config-schema` sets `exitCode=1` by design while writing valid JSON to stdout.
- Only the self-installed candidate binary is used. A `dsh` on `PATH` may be a desktop shim that ignores `DSH_HOME` and writes into the real home. This happened during development; it is now structurally excluded.
- Reports contain no message bodies. `stderr` keeps only diagnostic lines (replay writes reasoning prose to stderr; lines not matching the diagnostic shape are dropped and counted). Evidence objects are redacted per string (absolute paths including those with spaces → `<abs-path>`, home directories → `~`, credential shapes → `[redacted]`). Reports contain session ids, type histograms, seq ranges and byte counts only.
- Cleanup runs on every exit path. The shadow home holds full session copies and plaintext decoded fixtures, so it is deleted in `finally` and recorded as `shadowCleanup: removed|kept|failed`.

## Coverage

The write round is deliberately narrow: every tool appearing in a session's recording must be read-only. Measured on one machine (2026-10-02):

| Stage | Count | Share |
|---|---|---|
| Sessions in library | 52 | — |
| Drillable (not yet v4, cwd resolvable) | 24 | 46% |
| Passed the read-only allowlist | 5 | 21% of drillable, 9.6% of the library |

Migration rehearsal is broad, write-path rehearsal is narrow; the two carry different evidential weight and must not be quoted interchangeably. `coverage.writeRounds` exposes `plainAttempts`, `plainPass`, `presetAttempts`, `presetPass` and `skippedWriteTools`, listing each blocked session with its tools; `coverage.sessions.preset` exposes `inLibrary`, `drillable`, `selected` and `migrated`. Whether preset-bearing sessions were drilled is self-evidenced by the report rather than asserted in documentation.

Sessions carrying an `agentPreset` are refused by the one-shot runner. `--preset-mode patch` neutralises that single adoption check inside the private candidate copy and does not rebuild the preset composition, so conclusions about such sessions are format-level only and are labelled as such. Sampling guarantees representation: the non-preset stratum fills first, the preset stratum takes the remainder with a floor of one. Preset write rounds run and are reported but do not decide the stage verdict on their own — replay does not intercept their provider route, so a sample containing only presets yields `inconclusive`.

## How this differs from existing tools

Every cell below was verified against the other project's source or its own text on 2026-10-02.

| Tool | Scope achieved | What this adds |
|---|---|---|
| [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) | contract pre-check before upgrade → configuration backup and full-tree rollback point → executes the framework upgrade itself with automatic rollback on failure; boot-failure isolation names the culprit from the boot log and disables it (preset renamed `.broken-*`), falling back to safe mode only when no specific culprit is identifiable; an environment fingerprint also catches framework changes made through other channels | runs inside the profile, and its pre-check takes the form of a contract set diff (`lib/server/domain/format-contract.js:4-7`). Its own `CHANGELOG.md:875` lists among unverified items: no session carrying a preset was ever run, because "that needs a new session and a real model call". This tool removes the real-model-call precondition |
| [`@linxin666/dsh-doctor` rescue capsule](https://github.com/zhu1090093659/dsh-web) | provisions a pinned DSH runtime and an isolated `DSH_HOME`, gates a candidate with isolated `dump-config` and web health checks, promotes on pass, rolls back byte-exactly | gates the loader and configuration surface. Its published tarball contains no `session` or `sessions/` reference on the node side, and the pinned version is the current one, for recovery |
| [`dsh-test-drive`](https://github.com/PerryLink/dsh-test-drive) | install → patch effective → cold boot → uninstall → cleanup, in a fresh `mkdtemp` throwaway `DSH_HOME` with a redirected pnpm store; `schema: "dsh-test-drive/v1"`; `action.yml` emits Markdown and JUnit XML; the optional `capability` stage drives a headless task and verifies the durable session log recorded the call | that stage requires `DEEPSEEK_API_KEY`, is recorded `skipped` without one, and targets a newly created session. This tool's write round is keyless and targets copies of the user's `v0→v4` history |
| [`@mars.liu/dsh-canary`](https://github.com/MarchLiu/dsh-canary) | standalone npm CLI that boots a throwaway composition of the profile's bundle set plus the candidate plugin (`profiles/canary-<rand>`, reusing `node_modules` through absolute symlinks); L1 can pin a `dsh` version | varies the plugin; session data is out of range. Ships no GitHub Action and has no `v1` schema discriminator |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | `/backup migrate-check` scans every generation of session logs read-only (`lib/index.js:512`: "writes no files"), predicting against frozen per-generation rules which sessions will not open and which rule they trip; plus the dependency-free out-of-process `dsh-rescue` | the limit lies in the read side itself, see the quotation below |
| [`dsh-plugin-doctor`](https://github.com/PerryLink/dsh-plugin-doctor) | package-structure R/K gates, cordis contract scan, keyless headless smoke (`MISSING_CREDENTIAL` counts as passing); exposes `coverage.<K>{filesInspected,mode}`, `degraded[]` and exit `6`, under the rule "a `skip` is never rendered as `PASS`" | a relative rather than a competitor: this tool's `coverage` and `warnings[]` follow the same discipline, aggregated into an upgrade decision |
| [`dsh-plugin-reducer`](https://github.com/ArmyWas/dsh-plugin-reducer) | external CLI; creates a fresh shadow `DSH_HOME` per probe and links the profile to the existing `node_modules` (installing nothing), reducing a failing profile to the smallest reproducing plugin set; a weekly `upstream-canary.yml` probes `dsh-app-boot@next` for layout drift | post-incident reduction of an existing failure; this tool runs before the upgrade. Its canary watches upstream layout, not session data |

That the read side cannot decide this class of corruption is documented in `dsh-backup`'s own comment:

> `kind 只作提示，不作判据（#113）：宿主把它设计成可合并扩展的联合类型……旧实现把"不在白名单"直接判成"打不开"，在一台真实机器上把 81/82 份完全健康的日志报成不可打开`
> — `xiaoyuyu6420/dsh-backup` `lib/index.js:2617-2622` (*kind is a hint, not a criterion (#113): the host designed it as a mergeable union type… the old implementation judged "not in the whitelist" as "cannot open", and on a real machine reported 81 of 82 perfectly healthy logs as unopenable*)

Facing the same corruption class, `gating-hub` rewrites producer source (contract rule `session-message-source-kind`, converting plugins that still emit the V3 `{kind:'plugin'}` wrapper to a producer-owned kind). A static scan cannot decide it without large-scale false positives, and a contract diff changes code rather than data; upstream [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) describes a session that opens normally and fails on every write round. Only an actual write decides, and writing used to require an API key.

Each log pattern, where it is detected, what a hit and a non-hit respectively prove, and which cannot be reproduced here: [`docs/FAILURE_MODES.en.md`](docs/FAILURE_MODES.en.md) (Chinese: [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md)).

## Known limits

- `--allow-tools` executes the tool calls recorded in the session. The cwd remains sandboxed, but `pwsh` and `bash` can reach outside it through absolute paths. Enable per session whose historical side effects are acceptable.
- Attachment side data is neither copied nor verified (`~/.dsh/attachments`, `cache/attachments`); attachment-reference integrity is out of scope.
- An npm shadow environment is not equivalent to a Desktop installation; `run` cannot reproduce the Electron dependency closure, see [Compatibility](#compatibility).
- The rehearsal proves the write path is traversable, not open-ended behaviour: the replay script derives from that session's own recording, so tools and paths absent from the recording cannot appear.
- Detection of `#1229`-class rows is built in but untriggerable on this machine's data: the `v3→v4` migration package has carried the `producerKind` rewrite since `0.2.0-rc.1`.
- `run` uses a single `--sample` value for both the migration sample and the write-round pool; widening write coverage means raising it.
- Not listed in the `awesome-dsh-plugin` catalogue, and it should not be: `scripts/check-submission.mjs:258-264` requires a `package.json` declaring `dsh.bundle`, and declaring only `dsh.client` is refused (`dsh-plugin-reducer` and `dsh-canary` are likewise absent — 0 hits across 4,412 entries). The appropriate listings are tool catalogues: `walkinglabs/awesome-deepseek-harness-plugins` `docs/INCLUSION_POLICY.md` rule 4, and `awesome-deepseekharness/awesome-deepseek-harness` `CONTRIBUTING.md` (🧩 Tools).

## Verifying that the real home was not touched

Three independent checks:

```sh
# 1) every migration artifact in the real library must predate the rehearsal
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort | tail -3
# 2) no shadow directory is left behind (unless --keep or --shadow-dir was used; otherwise it is removed)
ls -d "${TMPDIR:-/tmp}"/dsh-rehearsal-home-* 2>/dev/null | wc -l
# 3) the report contains neither a home path nor message bodies; replace <TOKENS> with the reader's own username and drive keywords
node -e "const fs=require('fs');const d=fs.readdirSync('.dsh-rehearsal').sort().pop();\
const t=fs.readFileSync('.dsh-rehearsal/'+d+'/report.json','utf8');\
console.log(['<TOKENS>','reasoning:'].filter(k=>t.includes(k)).length?'LEAK':'CLEAN')"
```

## Development and releases

```sh
npm test        # 61 tests: multi-frame zstd regression / peer grading / sandbox cwd
                # rewrite plus directory encoding / stderr sanitizer / structured
                # scrubbing / read-only allowlist / env stripping / countRows shape /
                # stratified selection / writeRoundVerdict / warnings rendering and
                # scrubbing / signature regression locks / bilingual changelog parity /
                # end-to-end `check` CLI smoke
```

Signature locks come in pairs: each pattern must match a line taken from an upstream issue or a captured artifact, and must not match a healthy line. A further assertion requires every id detected in code to appear in `docs/FAILURE_MODES.md`, so the documentation cannot drift into an unreviewed compatibility claim.

CI runs `npm ci` and `npm test` across windows / macOS / linux × Node 22.19 and 24.x, with two guards: the `node:zlib` zstd API must exist, and the test suite must not leave fixture homes in `$HOME`. CI does not run `run`: that command installs roughly 500 packages and replays copies of real sessions, which is neither deterministic nor appropriate on a shared runner; the safety model is covered by offline unit tests instead.

Releases are tag-triggered (`.github/workflows/release.yml`) and stop in two cases: the tag does not match `package.json`'s version, or either changelog lacks the corresponding section. The tarball and its `.sha256` are then attached to the Release, and the body is generated in a fixed order (Chinese section → install → `---` → English section). npm publishing runs through `publish.yml`, which skips rather than failing when `NPM_TOKEN` is absent.

Release procedure and history handling: [PUBLISHING.en.md](PUBLISHING.en.md) (Chinese: [PUBLISHING.md](PUBLISHING.md)). Versioning policy and retracted claims: [CHANGELOG.md](CHANGELOG.md) (Chinese: [CHANGELOG.zh.md](CHANGELOG.zh.md)); the version in `run --to <version>` belongs to the `dsh` under test, not to this tool. Promises enforced by code and tests, and the two flags whose risk lies with the operator: [SECURITY.en.md](SECURITY.en.md) (Chinese: [SECURITY.md](SECURITY.md)). Every document in this repository ships as such a pair, and `test/docs.test.js` fails when a pair drifts apart.

MIT License. Not affiliated with or endorsed by DeepSeek. `dsh` / DeepSeek Harness is upstream at [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness); the Desktop host and active issue tracker are at [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop).
