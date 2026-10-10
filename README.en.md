<div align="center">

<img src="assets/poster.jpg" width="620" alt="dsh-rehearsal poster: rehearsing a DeepSeek Harness upgrade against session copies in an isolated DSH_HOME">

# dsh-rehearsal

Upgrade rehearsal tool for DeepSeek Harness (`dsh`). Before upgrading, it runs the candidate against copies of your existing sessions — including failures that only a real write exposes, such as a session that migrates successfully but can no longer be written back — and produces a verifiable upgrade decision report.

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![npm](https://img.shields.io/npm/v/dsh-rehearsal?style=flat-square)](https://www.npmjs.com/package/dsh-rehearsal)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh-4d6bfe?style=flat-square)](https://github.com/topics/dsh)
[![listed in 0xsline](https://img.shields.io/badge/listed%20in-awesome--deepseek--harness%20%280xsline%29-4d6bfe?style=flat-square)](https://github.com/0xsline/awesome-deepseek-harness#runtime--operations)
[![listed in Dominic789654](https://img.shields.io/badge/listed%20in-awesome--deepseek--harness-4d6bfe?style=flat-square)](https://github.com/Dominic789654/awesome-deepseek-harness#session--memory-management)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#compatibility)

</div>

---

## What it does

Two core commands (plus `report` and `clean`):

- **`check`** — read-only pre-flight. Resolves profiles, patch layers, lockfiles and the peer graph, and reports session format generations. Installs nothing, writes no sessions.
- **`run`** — rehearsal. Installs the candidate into a private npm prefix, cold boots it twice in a shadow `DSH_HOME`, triggers the `v0→…→v4` migration on session copies, verifies read-side integrity, and optionally performs one write round that needs no API key.

The reason these are separate:

> **A successful migration does not prove that the migrated session can still be written to.**

Format migration is lazy and happens only when a session opens, and read-side checks pass data that opens but cannot be written. Upstream [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) is exactly such a session: it opens normally and fails on every write round. Read-side static checks cannot decide this class of corruption in principle (the row-by-row comparison is in [docs/architecture.en.md](docs/architecture.en.md#division-of-labour-with-comparable-tools)). Keyless, aimed at migrated copies of the user's own sessions, actually performing one write round — as of the 2026-10-02 check across seven comparable tools, only this tool combines all three. The write round uses the official `@deepseek-ai/dsh-llm-replay` adapter to reconstruct model responses from that session's own recording, so it needs no API key and makes no live model request.

## When you need it

- About to upgrade and want to know whether plugins or peer dependencies break on the new version: `check` lists every conflict and splits it into newly-broken and pre-existing.
- Sessions are managed by the official desktop or a community desktop (such as AnywhereLab's DSH Desktop) and the upgrade should not involve hand-carrying a home around: omit `--home` and `check` / `run` discover and validate the registered desktop hosts' homes, with the origin stated in the report.
- Session history is irreplaceable and the upgrade needs an escape hatch: the rehearsal runs entirely in a shadow `DSH_HOME`; the live installation and real sessions stay untouched, and `clean` removes every trace.
- Whether older-generation sessions still open — and still write — after the upgrade: `run` triggers the migration on session copies and verifies the write back, so "cannot write" gets a verdict instead of a guess.
- When the decision needs a verifiable record: every rehearsal writes `report.json` and `report.md`; verdicts come from artifacts, and reports are sanitized before they reach disk.

## Why a standalone CLI, not a plugin

The rehearsal installs the candidate and cold-boots it under a private `DSH_HOME`. A tool living inside the profile can do neither: it is replaced along with the host, and it cannot get a private shadow environment. Timing matters more: when the profile under test cannot boot is exactly when the tool is needed most, so the tool has to stay alive. That observation comes from [`dsh-plugin-gating-hub`](https://github.com/Noob-stupid/dsh-plugin-gating-hub) (npm package name `@noob-stupid/dsh-plugin-console`, `README.zh.md:282`); this tool turns it into its install form — a standalone CLI, not a `dsh plugin add` bundle.

## Install

```sh
npm install -g dsh-rehearsal                        # npm registry
npm install -g github:wuwaka/dsh-rehearsal#v0.3.16   # or pin to a GitHub tag
```

Neither path requires an npm account. To pin an install to exact bytes, use the tarball and `.sha256` attached to the Release (verification steps in [PUBLISHING.en.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/PUBLISHING.en.md)).

## Quick start

```sh
dsh-rehearsal check --candidate 0.2.0-rc.2     # read-only, seconds
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20  # installs the candidate and copies sessions
dsh-rehearsal clean --yes                       # remove output
```

Common options:

| Option | Purpose |
|---|---|
| `--profile` / `--home` | Select the profile and `DSH_HOME`; without `--home`, resolution is `DSH_HOME` → the validated default home → registered desktop hosts (official DeepSeek Harness Desktop; community DSH Desktop / DSHDesktop) |
| `--sample N` / `--full` | Limit or lift the session count |
| `--skip-write` | Skip write rounds |
| `--keep` | Keep shadow data for debugging (contains plaintext session copies) |
| `--shadow-dir <dir>` / `--prefix-dir <dir>` | Choose the shadow home / candidate install directory; these are **never auto-cleaned** (the shadow home holds plaintext session copies), a non-empty directory without this tool's ownership marker is refused, and `clean --yes` only removes marked artifact directories |
| `--allow-tools` | Explicitly allow executing recorded tool calls |

Everything else is in `dsh-rehearsal --help`.

## What the output looks like

Actual `check` output (the `profiles` list and generation histogram are elided; local profile names are not among them):

```text
dsh-rehearsal check — verdict: upgrade-with-conditions
  [PASS        ] a-inventory — home=default; profiles=[…]; live=desktop (bundles=11,
                 patchRows=16, plugins=10, 3 non-reproducible); sessions=52 (…)
  [WARN        ] b1-peer-graph — 10 plugins analyzed against candidate=0.2.0-rc.2
                 current=0.2.0-rc.2; 19 findings (0 newly-broken high, 9 pre-existing)
rollback note: sessions migrated to v4 are REFUSED (not rewritten) by older hosts —
downgrade after migration is not possible; rollback relies on a pre-upgrade snapshot
```

`home=default`, not a path: the DSH_HOME field in a report records a shape or an origin (`default` / `custom` / `desktop:<host-id>`), so no absolute path enters the string.

Exit codes:

| Exit code | Meaning |
|---:|---|
| `0` | Checks passed, upgrade is clear |
| `1` | Conditional upgrade, or an incomplete result |
| `2` | Do not upgrade |
| `3` | The rehearsal itself failed |

Stage verdicts come from artifacts, not from the exit code of the candidate `dsh` process.

## Reports

Every rehearsal writes two files: `report.json` (machine-readable) and `report.md` (human summary). `report.json` is the source of truth for coverage, stage verdicts, `warnings[]` and evidence.

## Coverage

Migration coverage and write-round coverage are different, and must not be quoted interchangeably. A write round only covers sessions whose recorded tools are all read-only.

Measured on one Windows run (2026-10-02):

| | Sessions | Share |
|---|---:|---:|
| Total | 52 | — |
| Eligible for rehearsal (not yet v4, cwd resolvable) | 24 | 46% |
| Passed the read-only tool gate | 5 | 9.6% of all sessions |

The write-round share is not migration coverage. Per-session coverage is in the report's `coverage` section.

## Safety summary

- The candidate is installed into a private npm prefix, with `DSH_HOME` pointed at a shadow home.
- Session copies have their `cwd` rewritten into the shadow workspace.
- The real home and desktop install directories are read-only; discovery and probing only parse files.
- Credential-shaped environment variables are stripped, surviving values lose URL-embedded userinfo credentials, and telemetry is force-disabled.
- Recorded tool calls do not execute by default (fail-closed read-only allowlist).
- Reports are sanitized before being written and a failed scrub refuses to emit a report; shadow data is removed unless `--keep` or an explicit `--shadow-dir` is used, and `clean` only removes artifact directories carrying the ownership marker.

Exact guarantees, explicitly dangerous options, and what is out of scope: [SECURITY.en.md](SECURITY.en.md).

## Compatibility

| Item | Status |
|---|---|
| Node.js | `>=22.19` (needs `node:zlib` zstd) |
| `run` | Tested: real sessions on Windows |
| `check` | Tested: Windows; CI: macOS / Linux / Windows |
| Desktop-managed profile (session-migration rehearsal) | Tested: community desktop data, Windows (2026-10-02) |
| Desktop home auto-discovery | Windows: official default install and community bundle measured; macOS / Linux: Inferred from upstream layout, not verified on a real machine |
| Bundled desktop runtime detection | Official Windows default install measured (asar descriptor); custom install directories and the Linux AppImage: Not covered |
| The bundled desktop runtime as a rehearsal target | Not tested (the rehearsal drives the npm candidate; the report carries a scoping warning) |
| Candidate source | npm / self-hosted `web` and `headless` profiles |
| Runtime dependency | `semver` |

Tested versions: candidate `dsh` `0.2.0-rc.2`, Node `22.22.2`, Windows, session generations `v0`/`v3`/`v4` (tested on 2026-10-02); desktop probes: official 0.2.0-rc.2 silent install on Windows, 2026-10-05. Tested ≠ supported: anything not listed should be treated as untested.

## Limitations

- `run` rehearses the npm candidate it installs itself, not a desktop app's bundled runtime: for a desktop-managed home, verdicts cover the npm dependency closure and the session data format; the desktop app's own update channel is out of scope (a scoping warning and the `coverage.host` field in the report state this).
- Desktop probing covers default install locations only: both the official and the community installers allow a custom directory, and a host installed elsewhere has no detectable bundled-runtime version — pass `--current`.
- macOS official/community paths are inferred from upstream layout, not verified on a real machine; the Linux official desktop ships as an AppImage, unreadable externally and explicitly unsupported.
- Desktop homes relocated through anywhere-labs Recovery, `DSH_DATA_ROOT`, or a portable build's `DSH_HOME` override are outside auto-discovery — pass `--home`.
- With several desktop hosts on one machine whose bundled runtimes disagree, `current` resolves to unknown (the report lists `currentAmbiguous`): pass `--current`, or uninstall the idle host; the failure direction is deliberately conservative.
- Write-round coverage is narrower than migration coverage, see [Coverage](#coverage).
- Sessions carrying an `agentPreset` are format-tested only; the preset composition is not rebuilt.
- Attachment side data (`~/.dsh/attachments` and friends) is neither copied nor verified.
- A rehearsal proves the write path is traversable, not open-ended behaviour: a replay script contains only what that session's recording contains.

## Going deeper

- [docs/architecture.en.md](docs/architecture.en.md) — why an external CLI, module layout, and how this divides labour from comparable tools
- [docs/FAILURE_MODES.en.md](docs/FAILURE_MODES.en.md) — what each log pattern proves, and what it does not
- [SECURITY.en.md](SECURITY.en.md) · [AUDIT.en.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/AUDIT.en.md) · [CHANGELOG.md](CHANGELOG.md) · [PUBLISHING.en.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/PUBLISHING.en.md)

## Development

```sh
npm install && npm test
node src/cli.js check --candidate 0.2.0-rc.2
```

CI runs `npm ci` + `npm test` across windows / macOS / linux × Node 22.19 / 24.x. CI does not run `run`: that command installs roughly 500 packages and replays session copies, which is neither deterministic nor appropriate on a shared runner. Release procedure: [PUBLISHING.en.md](https://github.com/wuwaka/dsh-rehearsal/blob/main/PUBLISHING.en.md).

MIT License. Not affiliated with or endorsed by DeepSeek. Upstream: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) (the official desktop lives in its `apps/desktop`); community desktop host and active issue tracker: [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop).
