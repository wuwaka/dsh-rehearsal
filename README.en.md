<div align="center">

# 🎬 dsh-rehearsal

**Should I upgrade DeepSeek Harness? Rehearse it first** — against a candidate `dsh` version, your own plugin set, and *copies of your real sessions*, keyless, in a throwaway `DSH_HOME`.

[English](README.en.md) | [简体中文](README.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe?style=flat-square)](https://github.com/topics/dsh-plugin)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#compatibility)

*A standalone command-line tool. Not a `dsh plugin add` bundle, and deliberately not a fourth single-plugin canary.*

</div>

---

## What this is

Two commands, one decision:

| Command | What it does |
| --- | --- |
| `check --candidate <version>` | **Static pre-flight**: read-only, no downloads, seconds. Live-profile detection, all four patch layers, exact installed versions, peer graph (graded *newly broken by this upgrade* vs *already broken today*), session-generation census |
| `run --to <version>` | **The rehearsal**: private-prefix candidate install → two cold boots → lazy migration `v0 → … → v4` on copies of your real sessions → read-side integrity → **keyless write round** via the official `dsh-llm-replay` |

Emits a `dsh-rehearsal/v1` report (`report.json` + `report.md`); exit codes are scriptable: `0` OK · `1` with conditions · `2` do not upgrade · `3` the rehearsal itself failed.

Install (verified working; no npm registry entry needed):

```sh
npm install -g github:wuwaka/dsh-rehearsal#v0.1.0
dsh-rehearsal check --candidate 0.2.0-rc.2
```

## Why an external CLI, not a plugin

A rehearsal tool that lives inside the profile it is rehearsing **dies exactly when it matters most**. The upstream reports this tool was built from are full of that failure mode: [`#1294`](https://github.com/anywhere-labs/dsh-desktop/issues/1294) is a `host-boot` 120 s RPC timeout that ends in recovery mode with **no plugin-level attribution at all**, and the reporter notes the *identical* configuration booted fine on the second try.

So `dsh-rehearsal` drives the candidate `dsh` as a **child process in its own home directory**, from outside the host:

- it never touches your live profile, and cannot — it installs the candidate itself and points `DSH_HOME` at a private directory;
- it still works when the installed harness will not start;
- every conclusion is backed by an artifact on disk (`report.json`), not by a log you read by eye.

> **Relationship to official gating.** `dsh-plugin-manager` enforces declared peer ranges at *install and startup* and offers exact-version exemptions (`dsh plugin allow-version … --accept-risk`). That is a runtime guardrail. This tool answers the earlier question — *what will break if I move to version X*, including session data that only breaks when something writes to it — and it runs **before** you commit to the upgrade. Complementary, not duplicative.

## Compatibility

Verified on a real machine, 2026-10-02:

| Component | Version |
|---|---|
| Candidate `dsh` (installed by this tool into a private prefix) | **`0.2.0-rc.2`** — `--sample 9 --preset-mode patch`: 9/9 real sessions migrated v0→v4, 1 keyless write round `pass` |
| Current runtime detection | probes the profile's `node_modules`, the shared `profiles/node_modules`, the **DSH Desktop** bundle (`…/resources/app/node_modules/@deepseek-ai/dsh`), then the npm prefix |
| Session format generations | `v0` (`session.jsonl.zstd`), `v3`, `v4`; migration chain `v0→…→v4` exercised against real logs |
| Node.js | `>=22.19` (needs `node:zlib` zstd, added in v22.15.0, still *Stability: 1 – Experimental*) |
| Package manager | `npm` (located without `PATH` assumptions; used to install the candidate, never your profile) |
| Platform | Windows / macOS / Linux — CI matrix `3 OS × Node 22.19, 24.x` |
| Runtime dependencies | **one**: `semver` |
| Credentials | **none required, ever** — see [Safety by construction](#safety-by-construction) |

**Not supported (by design):** rehearsing the Electron-owned `desktop` profile through the npm CLI. `dsh` hard-refuses it (`profile "desktop" is managed exclusively by the Electron application`), and an npm-installed candidate is a *different dependency closure* than the Desktop bundle. `check` still covers a `desktop` profile — it only parses files. `run` targets npm / self-hosted `web` and `headless` profiles.

## What you get

### `check` — static upgrade pre-flight (read-only, no downloads, seconds)

- picks the **live profile** instead of assuming `web` (measured: one machine had `desktop` = 11 bundles / 198 patch lines vs `web` = 4 / 4);
- resolves the patch layering (`dsh.profile.bundles` order → profile `cordis.patch.yml` → home-level `cordis.patch.yml` → `--patch`), exact installed versions from `pnpm-lock.yaml`, and the `pnpm-workspace.yaml` policies that change install semantics (`autoInstallPeers`, `allowBuilds`, `minimumReleaseAgeExclude`);
- analyses the **peer graph**: plugin↔dsh, plugin↔plugin, conflicting `@deepseek-ai/cordis` pins, version-*enumerated* ranges (the prerelease-caret footgun: `^0.1.7-rc.2` does not match `0.2.0-rc.2`, so authors list every rc by hand), and non-reproducible `link:` / `file:` / `github:` deps;
- grades each finding **newly broken by this upgrade** vs **pre-existing** — a mismatch that already exists today is not this upgrade's fault and does not block.

### `run --to <version>` — the rehearsal

```
private prefix install (candidate dsh, scripts denied)
  → two cold boots (first-boot flakiness is real upstream: #1294)
  → lazy migration drill on copies of your real sessions (v0 → … → v4)
  → read-side integrity (full multi-frame decode, seq contiguity, bidirectional turn balance)
  → keyless write round via the official @deepseek-ai/dsh-llm-replay
```

The last stage is the point of this tool. Migration is **lazy and only happens on open**, and read-side checks pass on data that cannot be written to again — upstream [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) is exactly a session that opens fine and then fails every turn. So the rehearsal opens a migrated copy and **attempts a write round**, with no API key: `dsh-llm-replay` reconstructs the model stream from the session's own recorded history.

### `dsh-rehearsal/v1` report

`report.json` + `report.md` per stage (`verdict` / `durationMs` / `details` / `evidence`), stage records shaped after `dsh-test-drive/v1`, plus a fixed `coverage` block, a top-level `warnings[]`, and a `privacy` block stating exactly what was stripped. Exit codes are machine-checkable: **`0` upgrade OK · `1` upgrade with conditions · `2` do not upgrade · `3` the rehearsal itself failed**.

## Safety by construction

Three independent layers, because "we suppressed tools" turned out not to be one assumption deep enough:

1. **Sandboxed cwd.** `copySet` rewrites each copied session header's `cwd` into `<shadow>/workspace/<n>` *and* moves the copy to the matching encoded workspace directory — the harness derives the session path from `header.cwd`, so both must change together. No process ever runs with your real workspace as its root.
2. **Tool rows disabled by default.** The replay patch disables tool-providing rows matched by **row id *and* package name** (`dsh-tool-`, `dsh-mcp-`, `dsh-skill`, `dsh-browser`, `dsh-terminal`, `dsh-jobs`, `terminal-`); the `tools` registry row stays, because the agent loop needs it. Replayed calls come back `isError` instead of executing.
3. **Fail-closed read-only allowlist.** A replay can only emit tools that appear in that session's own history — deterministic, so pre-screening is complete, not a guess. A session is drilled only when **every** recorded tool is a known read-only builtin; `mcp__*`, exec/write classes, unknown third-party tools and unnamed rows all block, and each block is listed with its reason. Extraction covers **four row shapes** (`tool/call`, `tool-call-chunks`, `tool/ptc-dispatch`, `tool/code-dispatch[·start]`) — scanning only `tool/call` silently misses entire tools.

Plus, non-negotiable:

- **Keyless.** Every credential-shaped environment variable (`API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY|AUTH`) is stripped from child processes; the *names* stripped are recorded, never the values. Nothing spends tokens, nothing ships your prompts to a provider.
- **Telemetry off**: `DSH_TELEMETRY_MODE=DISABLED` (candidate `0.2.0` defaults to `FEEDBACK_ONLY`, and its OTLP path bypasses proxies).
- **Verdicts from artifacts, never exit codes.** A *successful* keyless migration exits `1` with `MISSING_CREDENTIAL`; `--dump-config-schema` also exits `1` on success by design (`process.exitCode` when collection is incomplete) while writing valid JSON to stdout.
- **Only our own candidate binary.** The `dsh` on `PATH` may be a Desktop shim that ignores `DSH_HOME` and writes to your real home — this happened during development, which is why it is now structurally impossible.
- **Reports carry no message bodies.** `stderr` is filtered to diagnostic lines (replay echoes reasoning prose to `stderr`, and everything not matching a diagnostic shape is dropped *and counted*); evidence objects are scrubbed per string value (any drive-rooted path including ones with spaces → `<abs-path>`, home dirs → `~`, credential shapes → `[redacted]`). Session ids, type histograms, seq ranges and byte counts only.
- **Cleanup on every exit path.** The shadow home holds full session copies plus *plaintext* decompressed fixtures, so it is removed in a `finally`, and the report records `shadowCleanup: removed|kept|failed`.

## Read the coverage numbers, not just the PASSes

The write round is deliberately narrow: it needs a session whose entire recorded tool history is read-only. Measured on the machine this was built on (2026-10-02):

| Stage | Count | Share |
|---|---|---|
| sessions in library | 52 | — |
| drillable (not yet v4, cwd usable) | 24 | 46% |
| pass the read-only allowlist | **5** | 21% of drillable, **9.6% of the library** |

So **migration rehearsal is broad and write-path rehearsal is narrow**; do not quote one as the other. `coverage.writeRounds` reports `plainAttempts/plainPass/presetAttempts/presetPass/skippedWriteTools` and lists every blocked session with its tools, and `coverage.sessions.preset` exposes `inLibrary/drillable/selected/migrated` so "we drilled preset sessions" is checkable from the report rather than asserted in prose.

Preset-carrying sessions deserve their own note: the one-shot runner refuses them, `--preset-mode patch` neutralises that one check **inside our private copy of the candidate**, and their composition is *not* reconstructed — those verdicts are format-level and labelled as such. Selection guarantees they are represented (plain stratum fills first, presets take the remainder with a floor of one), but their write rounds are still run and reported while never deciding the stage verdict: replay does not intercept a preset session's provider route, so a preset-only sample honestly yields `inconclusive`.

## How this differs from what already exists

The ecosystem is not empty, and pretending otherwise would waste your time — so, explicitly:

| Tool | What it does | What this adds |
|---|---|---|
| [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) | in-profile upgrade gate: contract pre-check, rollback point, auto-rollback, quarantines the plugin that broke boot | runs from outside, before you install anything, and can attribute a candidate version you have not adopted yet |
| [`dsh-test-drive`](https://github.com/PerryLink/dsh-test-drive) · [`@mars.liu/dsh-canary`](https://github.com/MarchLiu/dsh-canary) | throwaway-profile install + boot smoke for **a plugin**, structured `v1` report, GitHub Action | rehearses the **core** version, with your whole pinned plugin set, against copies of **your** sessions |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | `/backup migrate-check`: static pre-upgrade scan predicting which sessions the new host will refuse, plus rescue console | opens and **writes** to migrated copies — the class of breakage that passes every read-side check |
| [`dsh-plugin-doctor`](https://github.com/PerryLink/dsh-plugin-doctor) | static package gates, cordis contract scan, keyless headless smoke | cross-version aggregation and a go/no-go verdict rather than a per-plugin health check |
| [`dsh-plugin-reducer`](https://github.com/ArmyWas/dsh-plugin-reducer) | external CLI; minimises a profile to the smallest plugin set that reproduces a failure | forward-looking (pre-upgrade) instead of backward-looking (post-failure); complementary |

## Quick start

```sh
# install (verified; served straight from the GitHub tag, no registry needed)
npm install -g github:wuwaka/dsh-rehearsal#v0.1.0

dsh-rehearsal check --candidate 0.2.0-rc.2            # read-only pre-flight, seconds
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20         # full rehearsal (first run installs the candidate: ~2-5 min)
dsh-rehearsal clean --yes                             # remove .dsh-rehearsal artifacts
```

From source (development):

```sh
git clone https://github.com/wuwaka/dsh-rehearsal.git && cd dsh-rehearsal
npm install && npm test
node src/cli.js check --candidate 0.2.0-rc.2
```

Useful flags: `--profile`, `--home`, `--current` (override auto-detection), `--full`, `--preset-mode patch`, `--writeRounds N`, `--skip-write`, `--allow-tools`, `--run-scripts`, `--keep`, `--shadow-dir` / `--prefix-dir`.

### Let an AI run it for you

Paste this to an agent that can drive a terminal:

> Read-only pre-flight for a DeepSeek Harness upgrade on this machine. Clone or update `https://github.com/wuwaka/dsh-rehearsal`, run `npm install` then `node src/cli.js check --candidate <target-version>`, and report the verdict, every `high` finding with its plugin and peer range, and the session-generation distribution. Do not run `run` (it installs a candidate and replays copies of my sessions) without my explicit approval, do not modify any profile or `~/.dsh` file, and do not print any credential.

## Known limits (v1)

- `--allow-tools` **really executes** recorded tool calls. The cwd stays sandboxed, but `pwsh`/`bash` can reach outside it with an absolute path. Opt in per session you trust.
- Attachments are not copied or verified (`~/.dsh/attachments`, `cache/attachments`), so attachment-reference integrity is out of scope and stated as such rather than faked.
- npm shadow ≠ Desktop installation: `run` cannot reproduce the Electron dependency closure (see [Compatibility](#compatibility)).
- `rehearsal` measures the *write path*, not open-ended behaviour: the replay script is derived from that session's own recording, so tools and paths absent from the recording cannot appear.
- `#1229`-class poison-row detection is built in but untriggerable on this machine's data (the `v3→v4` migration package has carried the `producerKind` rewrite since `0.2.0-rc.1`).
- `run` still shares one `--sample` knob between the migration drill and the write-round pool; widening write coverage means raising `--sample`.

## Verifying that your real home was not touched

Three independent checks, which is how the audit trail for this project was built:

```sh
# 1) every migrated session artifact in the REAL home must predate the rehearsal
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort | tail -3
# 2) no shadow home left behind (auto-cleaned unless --keep / --shadow-dir)
ls -d "${TMPDIR:-/tmp}"/dsh-rehearsal-home-* 2>/dev/null | wc -l
# 3) the report contains no home path and no replayed prose
#    substitute your own username / drive layout for <TOKENS>
node -e "const fs=require('fs');const d=fs.readdirSync('.dsh-rehearsal').sort().pop();\
const t=fs.readFileSync('.dsh-rehearsal/'+d+'/report.json','utf8');\
console.log(['<TOKENS>','reasoning:'].filter(k=>t.includes(k)).length?'LEAK':'CLEAN')"
```

## Development

```sh
npm test        # 52 tests: multi-frame zstd regression (naive zlib reads 1 line of 1,698) /
                # peer grading / sandbox cwd rewrite + dir encoding / stderr sanitizer /
                # structured scrubbing / read-only allowlist / env stripping /
                # countRows structure / stratified selection / writeRoundVerdict /
                # warnings rendering + scrubbing / end-to-end `check` CLI smoke
```

CI runs `npm ci` + `npm test` on **windows / macOS / linux × Node 22.19 and 24.x**, plus two guard assertions: the `node:zlib` zstd API this tool depends on must exist, and the test suite must not leave fixture homes in `$HOME`. **CI never runs `rehearsal run`** — it installs ~500 packages and replays real session copies, which is neither deterministic nor appropriate on a shared runner; the safety model is covered offline instead.

Before publishing, read [PUBLISHING.md](PUBLISHING.md): pushing this history as-is would publish a pre-scrub snapshot (13 real paths across 5 files). The repo ships a verified single-commit `publish-clean` branch for exactly that.

---

MIT License. Not affiliated with or endorsed by DeepSeek. `dsh` / DeepSeek Harness is upstream: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness); the Desktop host and the active issue tracker are [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop).
