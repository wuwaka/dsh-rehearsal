[简体中文](architecture.md) | [English](architecture.en.md)

# Architecture and boundaries

The README covers what the tool is, how to run it, and what the results mean. This document covers why it is built this way, what each module does, and where the boundaries lie relative to other tools in the ecosystem.

## Why an external CLI

The observation that a tool living inside the profile under test fails exactly when it is needed comes from [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) (`README.zh.md:282`: "a console that cannot boot cannot gate anything"). The same reasoning produced two more independent implementations: `@xiaoyuyu6420/dsh-backup`'s dependency-free `dsh-rescue` (a `bin` entry in its `package.json`) and `zzy6-a/dsh-upgrade-guard`'s out-of-host supervisor. Running outside the host is not the differentiator.

The position this tool occupies is these four conditions holding at once (each verified against the other project's source, 2026-10-02):

| Condition | State of comparable tools |
|---|---|
| Installs a candidate core version, into a private prefix | `@mars.liu/dsh-canary` L1 can pin a `dsh` version but reuses the profile's `node_modules`; `@linxin666/dsh-doctor`'s rescue capsule gates a candidate in an isolated `DSH_HOME` and promotes atomically, but pins the current version, for recovery rather than rehearsal |
| Reads the user's historical sessions | only `dsh-backup` reads session logs, and `lib/index.js:512` marks it "read-only scan, writes no files" |
| Completes migration inside a host that actually booted | the tools that read sessions do not boot a host; those that boot one do not read sessions |
| Runs the write round with no API key | `dsh-test-drive`'s `capability` stage does execute a headless task and re-reads the durable session log, but requires `DEEPSEEK_API_KEY` and is recorded as `skipped` without one |

The fourth row is independently checkable: `gh search code "@deepseek-ai/dsh-llm-replay"` (2026-10-02) returns only the upstream repository `deepseek-ai/deepseek-harness`, its forks, and vendored documentation — no third-party tool consumes that package.

Mechanically, the candidate `dsh` is a child process this tool npm-installs into a private prefix under its own `DSH_HOME`. It cannot reach the live profile; the rehearsal still runs when the installed harness cannot start; every conclusion maps to an artifact on disk.

## Module layout

| File | Responsibility |
|---|---|
| `src/cli.js` | argument parsing, command dispatch, exit codes |
| `src/commands/check.js` | read-only pre-flight (inventory + peer graph) |
| `src/commands/run.js` | rehearsal pipeline and per-stage verdicts |
| `src/lib/dshhome.js` | profile enumeration, current runtime detection |
| `src/lib/sessions.js` | session discovery, stratified sampling, copies and cwd rewrite |
| `src/lib/shadow.js` | candidate installation, replay patch generation, adoption-gate patch |
| `src/lib/drill.js` | migration trigger, read-side integrity, write round and verdict aggregation |
| `src/lib/report.js` | report structure, redaction, Markdown rendering |
| `src/lib/zfstd.js` | multi-frame zstd frame scanning and decoding |
| `src/lib/peers.js` | peer range solving and mismatch grading |

## The `check` resolution chain

Patch layers resolve in order: `dsh.profile.bundles` → the profile's `cordis.patch.yml` → the home-level `cordis.patch.yml` → `--patch`. Exact versions come from `pnpm-lock.yaml`, and the `pnpm-workspace.yaml` policies that change install semantics (`autoInstallPeers`, `allowBuilds`, `minimumReleaseAgeExclude`) are read as well.

The profile is auto-detected rather than defaulting to `web`. On one machine the `desktop` profile carried 11 bundles and 198 patch lines while `web` had 4 / 4; analysing the wrong target invalidates every conclusion.

Peer mismatches are graded by direction: only "satisfied today, unsatisfied in the candidate" is a blocking `high`. A mismatch unsatisfied on both sides is recorded as `pre-existing` — configuration that already disagrees today was not introduced by this upgrade. Enumerated peer ranges (`^0.1.7-rc.2` does not match `0.2.0-rc.2`) and `link:` / `file:` / `github:` dependencies are flagged separately, because the former forces authors to hand-list every prerelease and the latter are not reproducible.

## The `run` pipeline

```text
install the candidate into a private prefix (--ignore-scripts by default)
  → two cold boots
  → migrate session copies (v0 → … → v4)
  → read-side integrity
  → keyless write round
```

Two cold boots, because upstream [`#1294`](https://github.com/anywhere-labs/dsh-desktop/issues/1294) records a first cold boot after a batch plugin upgrade hitting a 30-second renderer health-report timeout while an identical configuration booted normally on the second attempt. One failure and one success is recorded as jitter, not as incompatibility.

Every stage verdict is derived from artifacts. A *successful* keyless migration also exits `1` with `MISSING_CREDENTIAL`, and `--dump-config-schema` sets `exitCode=1` by design while writing valid JSON to stdout.

## Three layers suppressing the write round

The layers are independent; no single one would support the claim that recorded tools do not execute:

1. **Sandboxed cwd.** `copySet` rewrites each copy's header `cwd` to `<shadow>/workspace/<n>` and relocates the copy into the matching encoded workspace directory. The host derives the physical session path from `header.cwd`, so both must change together.
2. **Suppressed tool providers.** The replay patch suppresses tool rows by both row id and package-name prefix (`dsh-tool-`, `dsh-mcp-`, `dsh-skill`, `dsh-browser`, `dsh-terminal`, `dsh-jobs`, `terminal-`). The `tools` registry row is retained because the agent loop depends on it. Replayed calls return `isError`.
3. **Read-only allowlist (fail-closed).** A replay can only emit tools present in that session's own history, so the pre-screen is complete information. A session is drilled only when every recorded tool belongs to the known read-only built-in set; `mcp__*` prefixes, execution and write classes, unknown third-party tools and unnamed rows are skipped with the reason recorded.

Tool names are extracted from four row shapes: `tool/call`, `tool-call-chunks`, `tool/ptc-dispatch`, `tool/code-dispatch[·start]`. Scanning only the first silently misses a large set.

## Multi-frame zstd

DSH session logs are Zstandard multi-frame streams. `node:zlib`'s zstd **silently decodes only the first frame**: a 3,776,880-byte file yielded 233 bytes / 1 line, which reads like a corrupt file or an empty session. This tool therefore ships its own frame scanner (`src/lib/zfstd.js`), and read-side integrity is computed over a complete decode.

## Sessions carrying a preset

The one-shot runner refuses sessions with an `agentPreset`. `--preset-mode patch` neutralises that single adoption check inside the private candidate copy and does not rebuild the preset composition, so conclusions about those sessions are format-level only. Sampling fills the non-preset stratum first, with the preset stratum taking the remainder and a floor of one.

Write rounds for preset sessions are structurally undecidable: replay does not intercept their provider route, the run ends at `MISSING_CREDENTIAL`, and new rows land as `assistant/attempt` rather than `assistant/message`. They still run and are reported, but `writeRoundVerdict()` takes pass/fail only over non-preset rounds, and a sample containing only presets yields `inconclusive` for the stage.

## Division of labour with comparable tools

| Tool | Scope achieved | Boundary against this project |
|---|---|---|
| [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) | contract pre-check → configuration backup and full-tree rollback point → executes the framework upgrade with automatic rollback on failure; boot-failure isolation names the culprit from the boot log and disables it (preset renamed `.broken-*`); an environment fingerprint also catches framework changes made through other channels | runs inside the profile, and its pre-check is a contract set diff (`lib/server/domain/format-contract.js:4-7`). Its own `dsh-plugin-gating-hub/CHANGELOG.md:875` lists among unverified items: no session carrying a preset was run, because "that needs a new session and a real model call" |
| [`@linxin666/dsh-doctor` rescue capsule](https://github.com/zhu1090093659/dsh-web) | provisions a pinned DSH runtime and an isolated `DSH_HOME`, gates a candidate with isolated `dump-config` and web health checks, promotes on pass, rolls back byte-exactly | gates the loader and configuration surface; its published tarball contains no `session` / `sessions/` reference on the node side |
| [`dsh-test-drive`](https://github.com/PerryLink/dsh-test-drive) | install → patch effective → cold boot → uninstall → cleanup in a fresh `mkdtemp` throwaway `DSH_HOME` with a redirected pnpm store; `schema: "dsh-test-drive/v1"`; `action.yml` emits Markdown and JUnit XML | its `capability` stage requires an API key and targets a newly created session |
| [`@mars.liu/dsh-canary`](https://github.com/MarchLiu/dsh-canary) | boots a throwaway composition of the profile's bundle set plus the candidate plugin (`profiles/canary-<rand>`, reusing `node_modules` through absolute symlinks); L1 can pin a `dsh` version | varies the plugin; does not read or write session data |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | `/backup migrate-check` scans every generation of session logs read-only, predicting against frozen per-generation rules which sessions will not open and which rule they trip; plus the dependency-free `dsh-rescue` | see the quotation below: the limit lies in the read side itself |
| [`dsh-plugin-doctor`](https://github.com/PerryLink/dsh-plugin-doctor) | package-structure R/K gates, cordis contract scan, keyless headless smoke (`MISSING_CREDENTIAL` counts as passing); exposes `coverage.<K>{filesInspected,mode}`, `degraded[]` and exit `6`, under the rule "a `skip` is never rendered as `PASS`" | the same discipline; this project aggregates the result into an upgrade decision |
| [`dsh-plugin-reducer`](https://github.com/ArmyWas/dsh-plugin-reducer) | creates a fresh shadow `DSH_HOME` per probe and links the profile to the existing `node_modules` (installing nothing), reducing a failing profile to the smallest reproducing plugin set; a weekly `upstream-canary.yml` probes `dsh-app-boot@next` for layout drift | post-incident reduction of an existing failure |

That the read side cannot decide this class of corruption is documented in `dsh-backup`'s own comment:

> `kind 只作提示，不作判据（#113）：宿主把它设计成可合并扩展的联合类型……旧实现把"不在白名单"直接判成"打不开"，在一台真实机器上把 81/82 份完全健康的日志报成不可打开`
> — `xiaoyuyu6420/dsh-backup` `lib/index.js:2617-2622`

Facing the same corruption class, `gating-hub` rewrites producer source (contract rule `session-message-source-kind`). A static scan cannot decide it without large-scale false positives, and a contract diff changes code rather than data, while [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) describes a session that opens normally and fails on every write round. Only an actual write decides.

## Division of labour with the official gate

`dsh-plugin-manager` enforces declared peer ranges at install and startup and offers exact-version exemptions (`dsh plugin allow-version … --accept-risk`), which is a runtime guardrail. This tool answers the earlier question — what happens when moving to a given version, including session data exposed only when written. The two are complementary.

## Terminology

| Concept | 中文 | English |
|---|---|---|
| Static pre-flight | 预检 | pre-flight |
| Full rehearsal | 预演 | rehearsal |
| Version under evaluation | 候选版本 | candidate |
| Environment in use | 活动 profile / 真实 home | live profile / real home |
| Isolated environment | 影子 home | shadow home |
| Duplicated session | 会话副本 | session copy |
| Format migration | 迁移 | migration |
| One appended turn | 写回合 | write round |
| Undecidable | 不可判定 | `inconclusive` |
| Already broken today | 既存失配 | `pre-existing` |
| Removing sensitive text | 脱敏 | redaction |

Status vocabulary is fixed: **Tested** (actually executed), **Inferred** (derived from code, never executed), **Not tested**, **Unsupported** (refused by design), **Not covered** (deliberately excluded).
