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

*A standalone command-line tool, not a `dsh plugin add` bundle — and not another single-plugin smoke tester.*

</div>

---

## What this is

Two commands, one decision:

| Command | What it does |
| --- | --- |
| `check --candidate <version>` | **Static pre-flight**: read-only, no downloads, seconds. Live-profile detection, all four patch layers, exact installed versions, peer graph (graded *newly broken by this upgrade* vs *already broken today*), session-generation census |
| `run --to <version>` | **The rehearsal**: private-prefix candidate install → two cold boots → lazy migration `v0 → … → v4` on copies of your real sessions → read-side integrity → **keyless write round** via the official `dsh-llm-replay` |

Emits a `dsh-rehearsal/v1` report (`report.json` + `report.md`); exit codes are scriptable: `0` OK · `1` with conditions · `2` do not upgrade · `3` the rehearsal itself failed.

Install by tag — **no npm account needed** (this form was verified against 0.1.0; substitute the tag you want):

```sh
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0
dsh-rehearsal check --candidate 0.2.0-rc.2
```

For an install you can verify down to the byte, use the Release assets:

```sh
curl -sSLO https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz
curl -sSL -O https://github.com/wuwaka/dsh-rehearsal/releases/download/v0.2.0/dsh-rehearsal-0.2.0.tgz.sha256
sha256sum -c dsh-rehearsal-0.2.0.tgz.sha256
npm install -g ./dsh-rehearsal-0.2.0.tgz
```

## Why an external CLI, not a plugin

"A rehearsal tool that lives inside the profile it is rehearsing dies exactly when it matters most" is **not our line** — it is [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub)'s own, at `README.zh.md:282`: 「**起不来的控制台什么都门控不了** —— 所以这条救火链路永远生效」 ("a console that cannot boot cannot gate anything"). The same reasoning already produced two more out-of-process paths: `@xiaoyuyu6420/dsh-backup` ships a zero-dependency `dsh-rescue` bin (its own words: an out-of-process rescue console for when the host will not start), and `zzy6-a/dsh-upgrade-guard` rolls the host back from a supervisor outside it.

**So "external" is the entry ticket, not the selling point.** Several tools in this ecosystem already run outside the host (`dsh-plugin-reducer` builds a shadow `DSH_HOME` per probe; `@mars.liu/dsh-canary` drives your own `dsh`). The position `dsh-rehearsal` occupies is these four things holding **at the same time** — each checked against their source on 2026-10-02:

| Condition | What everyone else does |
|---|---|
| Installs a **candidate core version**, into its own private prefix | `dsh-canary` L1 can pin a `dsh` version but reuses your profile's existing `node_modules`; `@linxin666/dsh-doctor`'s rescue capsule gates a candidate in an isolated `DSH_HOME` and promotes atomically, but pins the **current** version — for recovery, not rehearsal |
| Opens **your historical sessions** | only `dsh-backup` reads your session logs, and `lib/index.js:512` states its own boundary: "read-only scan, writes nothing" |
| Migrates inside a host that **actually booted** | the tools that read sessions do not boot a host; the tools that boot a host do not read sessions |
| Runs a write round **with no API key** | `dsh-test-drive`'s `capability` stage really does drive a headless task and checks the durable session log recorded the call — but it needs `DEEPSEEK_API_KEY`, and without one its README says the stage is "skipped, never failed" |

The last row is checkable by anyone: `gh search code "@deepseek-ai/dsh-llm-replay"` on 2026-10-02 returns only the upstream repo `deepseek-ai/deepseek-harness`, its forks, and vendored docs — **no third-party tool consumes that package**. This tool's write round is built on it.

Mechanically, the candidate `dsh` is a **child process this tool npm-installs into a private prefix**, with `DSH_HOME` pointing at a private directory —

- it cannot reach your live profile;
- it still runs when the installed harness will not start;
- every conclusion is backed by an artifact on disk (`report.json`), not by a log you read by eye.

> **Relationship to official gating.** `dsh-plugin-manager` enforces declared peer ranges at *install and startup* and offers exact-version exemptions (`dsh plugin allow-version … --accept-risk`). That is a runtime guardrail. This tool answers the earlier question — *what will break if I move to version X*, including session data that only breaks when something writes to it — and it runs **before** you commit to the upgrade. Complementary, not duplicative.

## Compatibility

**A declared range is not a tested version** — this table separates them, because for a tool whose job is to inform an upgrade decision, the staleness of its own test environment is itself a risk.

| Component | Tested | Declared / not verified |
|---|---|---|
| Candidate `dsh` | **`0.2.0-rc.2`**, `--sample 9 --preset-mode patch`: 9/9 real sessions completed `v0→v4`, 1 keyless write round `pass` (**2026-10-02**, one machine) | earlier rcs and stable were never rehearsed; `check` is pure file parsing and installs nothing |
| Current runtime detection | probes the profile's `node_modules` → shared `profiles/node_modules` → the **DSH Desktop** bundle (`…/resources/app/node_modules/@deepseek-ai/dsh`) → the npm prefix | `run` against a Desktop-internal candidate is unsupported (design decision below) |
| Session generations | `v0` (`session.jsonl.zstd`), `v3`, `v4`; the `v0→…→v4` chain exercised against **real logs** | `v1`/`v2` have generation detection only — no real-world sample |
| Node.js | local **22.22.2**; CI **22.19 and 24.x**, six combinations green (the `24.x` leg is **CI-only**) | `engines.node: >=22.19` — needs `node:zlib` zstd (added v22.15.0, still *Stability: 1 – Experimental*) |
| Platform | end-to-end on real Windows; macOS / Linux run `npm test` only — CI never executes `run` | `run` has never rehearsed real sessions on macOS or Linux |
| Package manager | `npm` — located without `PATH` assumptions, used only to install the candidate into a private prefix | never installs into your profile, and does not require pnpm |
| Runtime dependencies | **one**: `semver` | — |
| Credentials | **none required, ever** — see [Safety by construction](#safety-by-construction) | — |

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

The ecosystem is not empty, and pretending otherwise would waste your time. Every cell below was checked against the other project's source or its own README on 2026-10-02, with a citation you can verify — misdescribing someone else's tool is a worse failure than underselling your own.

| Tool | How far it goes (verified) | What this adds |
|---|---|---|
| [`@noob-stupid/dsh-plugin-console`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) | contract pre-check → config backup + full-tree rollback point → **executes the framework upgrade itself**, auto-rolling back on failure; "boot-failure isolation" names the culprit **from the boot log** and disables it (preset renamed `.broken-*`); its environment fingerprint also catches framework changes made through other channels | it lives inside the profile, and its pre-check is a **contract set diff** (`lib/server/domain/format-contract.js:4-7`). Its own `CHANGELOG.md:875` lists what it did not verify: it never ran a session carrying a preset — "(that needs a new session + **a real model call**)" — which is exactly the requirement this tool removes |
| [`@linxin666/dsh-doctor` rescue capsule](https://github.com/zhu1090093659/dsh-web) | provisions a pinned DSH runtime plus an isolated `DSH_HOME`, gates the candidate with isolated `dump-config` and web health checks, promotes on pass, rolls back byte-exactly — structurally the closest thing to shadow-host + candidate-gate + atomic-promote | it gates the loader/config surface. Grepping its published tarball finds **no** `session` / `sessions/` reference on the node side, and "pinned" means the **current** version (for recovery), not a candidate |
| [`dsh-test-drive`](https://github.com/PerryLink/dsh-test-drive) | install → patch-effective → cold boot → uninstall → cleanup, in a fresh `mkdtemp` throwaway `DSH_HOME` with a redirected pnpm store; `schema: "dsh-test-drive/v1"`; `action.yml` emits Markdown (PR comment) **and** JUnit XML. Its optional `capability` stage really drives one headless task and verifies **the durable session log recorded the invocation** | that stage needs `DEEPSEEK_API_KEY` and is "skipped, never failed" without one, and it opens a **newly created** session. This tool's write round is keyless and runs against **copies of your `v0→v4` history** |
| [`@mars.liu/dsh-canary`](https://github.com/MarchLiu/dsh-canary) | a standalone npm CLI that really boots a throwaway composition of *your profile's bundle set + the candidate plugin* (`profiles/canary-<rand>`, reusing `node_modules` through absolute symlinks); L1 can pin a `dsh` version | what it varies is the **plugin**; session data is out of range. It ships no GitHub Action and has no `v1` schema discriminator |
| [`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup) | `/backup migrate-check` scans every generation of your session logs **read-only** (`lib/index.js:512`: "writes no files"), predicting against frozen per-generation rules which sessions will not open and which rule they trip; plus the zero-dependency `dsh-rescue` out-of-process console | the interesting part is not that it is static — it is that **the read side structurally cannot decide**. See the quote below |
| [`dsh-plugin-doctor`](https://github.com/PerryLink/dsh-plugin-doctor) | package-structure R/K gates, cordis contract scan, keyless headless smoke (`MISSING_CREDENTIAL` counts as passing); exposes `coverage.<K>{filesInspected,mode}` + `degraded[]` + exit `6`, under the rule "a `skip` is never rendered as `PASS`" | a close relative, not a rival: this tool's `coverage` + `warnings[]` enforce the same discipline, aggregated into "may I upgrade" |
| [`dsh-plugin-reducer`](https://github.com/ArmyWas/dsh-plugin-reducer) | external CLI; creates a fresh shadow `DSH_HOME` per probe and links the profile to the existing `node_modules` (**installs nothing**), minimising a failing profile to the smallest reproducing plugin set; also a weekly `upstream-canary.yml` probing `dsh-app-boot@next` for layout drift | it reduces **after** an incident; this tool runs **before** an upgrade. Complementary — and its canary watches upstream layout drift, not your sessions |

**The "read side cannot decide" claim is testified by a competitor's own comment.** `dsh-backup` once treated an unknown `source.kind` as "will not open"; the production result was:

> `kind 只作提示，不作判据（#113）：宿主把它设计成可合并扩展的联合类型……旧实现把"不在白名单"直接判成"打不开"，在一台真实机器上把 **81/82 份完全健康的日志**报成不可打开`
> — `xiaoyuyu6420/dsh-backup` `lib/index.js:2617-2622` (*"kind is a hint, not a criterion (#113): the host designed it as a mergeable union type… the old implementation judged 'not in the whitelist' as 'cannot open', and on a real machine reported 81 of 82 perfectly healthy logs as unopenable"*)

Facing the same corruption class, `gating-hub` rewrites **the producer's source** (contract rule `session-message-source-kind`: convert plugins still emitting the V3 `{kind:'plugin'}` wrapper to a producer-owned kind). So a static scan cannot judge it without false positives at scale, and a contract diff fixes code rather than data — while upstream [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) is a session that **opens fine and explodes on every single turn**. Only an actual write round decides that, and writing a round used to require an API key. That gap is the entire reason this tool exists.

Failure signatures this tool keys on, and what each one does *not* prove, are listed in [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md).

## Quick start

```sh
# install (served straight from the GitHub tag, no registry entry needed)
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0

dsh-rehearsal --version                               # confirm the bin actually landed
dsh-rehearsal check --candidate 0.2.0-rc.2            # read-only pre-flight, seconds
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20         # full rehearsal: installs the candidate and copies your sessions, 2-5 min first time
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
- `#1229`-class poison-row detection is built in but untriggerable on this machine's data (the `v3→v4` migration package has carried the `producerKind` rewrite since `0.2.0-rc.1`); every signature and whether it can be reproduced here is tabulated in [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md).
- `run` still shares one `--sample` knob between the migration drill and the write-round pool; widening write coverage means raising `--sample`.
- **This tool is not in the `awesome-dsh-plugin` catalog, and should not be.** That catalog's `scripts/check-submission.mjs:258-264` hard-requires some `package.json` declaring `dsh.bundle` — declaring only `dsh.client` is refused — and `dsh-plugin-reducer` / `dsh-canary` are absent from it too (0 hits across its 4,412 entries, checked 2026-10-02). It indexes things you can `dsh plugin add`; this deliberately is not one. The right listings are tool catalogues: `walkinglabs/awesome-deepseek-harness-plugins` → `docs/INCLUSION_POLICY.md` rule 4 ("a client, launcher, or development resource … placed outside the plugin categories and labelled accordingly") and `awesome-deepseekharness/awesome-deepseek-harness` → `CONTRIBUTING.md`, category 🧩 Tools.

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
npm test        # 57 tests: multi-frame zstd regression (naive zlib reads 1 line of 1,698) /
                # peer grading / sandbox cwd rewrite + dir encoding / stderr sanitizer /
                # structured scrubbing / read-only allowlist / env stripping /
                # countRows structure / stratified selection / writeRoundVerdict /
                # warnings rendering + scrubbing / signature regression locks /
                # end-to-end `check` CLI smoke
```

The signature locks come in **pairs**: each log pattern must hit the real line copied from an upstream issue or from a captured artifact, and must *not* hit a healthy one. One more assertion requires that every id detected in code also appears in [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md) — otherwise the doc rots into an unreviewed compatibility claim.

CI runs `npm ci` + `npm test` on **windows / macOS / linux × Node 22.19 and 24.x**, plus two guard assertions: the `node:zlib` zstd API this tool depends on must exist, and the test suite must not leave fixture homes in `$HOME`. **CI never runs `rehearsal run`** — it installs ~500 packages and replays real session copies, which is neither deterministic nor appropriate on a shared runner; the safety model is covered offline instead.

Releases are tag-triggered (`.github/workflows/release.yml`): **the job stops if the tag does not equal `package.json`'s version, and stops if `CHANGELOG.md` has no section for it**, then attaches the tarball plus its `.sha256` and uses that section as the release body. `publish.yml` handles npm and skips itself rather than failing when `NPM_TOKEN` is absent.

Before publishing, read [PUBLISHING.md](PUBLISHING.md): pushing this history as-is would publish a pre-scrub snapshot (13 real paths across 5 files). The repo ships a verified single-commit `publish-clean` branch for exactly that.

---

MIT License. Not affiliated with or endorsed by DeepSeek. `dsh` / DeepSeek Harness is upstream: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness); the Desktop host and the active issue tracker are [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop).
