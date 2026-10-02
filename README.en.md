<div align="center">

<img src="assets/poster.jpg" width="620" alt="dsh-rehearsal poster: rehearsing a DeepSeek Harness upgrade against session copies in an isolated DSH_HOME">

# dsh-rehearsal

Upgrade rehearsal tool for DeepSeek Harness (`dsh`). It runs a candidate version against copies of your existing sessions without touching the live installation, and produces an upgrade decision report.

[简体中文](README.md) | [English](README.en.md)

[![license](https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square)](LICENSE)
[![release](https://img.shields.io/github/v/release/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/releases)
[![CI](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/wuwaka/dsh-rehearsal?style=flat-square)](https://github.com/wuwaka/dsh-rehearsal/stargazers)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe?style=flat-square)](https://github.com/topics/dsh-plugin)
[![tested](https://img.shields.io/badge/tested%20on-DSH%200.2.0--rc.2-4d6bfe?style=flat-square)](#compatibility)

</div>

---

## What it does

Two commands:

- **`check`** — read-only pre-flight. Resolves profiles, patch layers, lockfiles and the peer graph, and reports session format generations. Installs nothing, writes no sessions.
- **`run`** — rehearsal. Installs the candidate into a private npm prefix, cold boots it twice in a shadow `DSH_HOME`, triggers the `v0→…→v4` migration on session copies, verifies read-side integrity, and optionally performs one write round that needs no API key.

The reason these are separate:

> **A successful migration does not prove that the migrated session can still be written to.**

Format migration is lazy and happens only when a session opens, and read-side checks pass data that opens but cannot be written. Upstream [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229) is exactly such a session: it opens normally and fails on every write round. The write round uses the official `@deepseek-ai/dsh-llm-replay` adapter to reconstruct model responses from that session's own recording, so it needs no API key and makes no live model request.

## Install

```sh
npm install -g github:wuwaka/dsh-rehearsal#v0.2.0
```

Installed by tag; no npm account required. To pin an install to exact bytes, use the tarball and `.sha256` attached to the Release (see [PUBLISHING.en.md](PUBLISHING.en.md)).

A standalone CLI, deliberately not distributed as a `dsh plugin add` bundle: it has to stay usable when the profile under test cannot boot.

## Quick start

```sh
dsh-rehearsal check --candidate 0.2.0-rc.2     # read-only, seconds
dsh-rehearsal run --to 0.2.0-rc.2 --sample 20  # installs the candidate and copies sessions
dsh-rehearsal clean --yes                       # remove output
```

Common options:

| Option | Purpose |
|---|---|
| `--profile` / `--home` | Select the profile and `DSH_HOME` |
| `--sample N` / `--full` | Limit or lift the session count |
| `--skip-write` | Skip write rounds |
| `--keep` | Keep shadow data for debugging (contains plaintext session copies) |
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

`home=default`, not a path: the DSH_HOME field in a report records a shape (`default` / `custom`), so no absolute path enters the string.

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

Measured on one Windows run:

| | Sessions | Share |
|---|---:|---:|
| Total | 52 | — |
| Eligible for rehearsal (not yet v4, cwd resolvable) | 24 | 46% |
| Passed the read-only tool gate | 5 | 9.6% of all sessions |

The write-round share is not migration coverage. Per-session coverage is in the report's `coverage` section.

## Safety summary

- The candidate is installed into a private npm prefix, with `DSH_HOME` pointed at a shadow home.
- Session copies have their `cwd` rewritten into the shadow workspace.
- Credential-shaped environment variables are stripped, and telemetry is force-disabled.
- Recorded tool calls do not execute by default (fail-closed read-only allowlist).
- Reports are sanitized before being written, and shadow data is removed unless `--keep` is used.

Exact guarantees, explicitly dangerous options, and what is out of scope: [SECURITY.en.md](SECURITY.en.md).

## Compatibility

| Item | Status |
|---|---|
| Node.js | `>=22.19` (needs `node:zlib` zstd) |
| `run` | Tested: real sessions on Windows |
| `check` | Tested: Windows; CI: macOS / Linux / Windows |
| Desktop-managed profiles | `check` supported; `run` not supported (design decision) |
| Candidate source | npm / self-hosted `web` and `headless` profiles |
| Runtime dependency | `semver` |

Tested versions: candidate `dsh` `0.2.0-rc.2`, Node `22.22.2`, Windows, session generations `v0`/`v3`/`v4` (tested on 2026-10-02). Tested ≠ supported: anything not listed should be treated as untested.

## Limitations

- `run` cannot rehearse an Electron-managed `desktop` profile: the npm candidate and the Desktop bundle are different dependency closures, and `dsh` refuses the profile outright.
- Write-round coverage is narrower than migration coverage, see [Coverage](#coverage).
- Sessions carrying an `agentPreset` are format-tested only; the preset composition is not rebuilt.
- Attachment side data (`~/.dsh/attachments` and friends) is neither copied nor verified.
- A rehearsal proves the write path is traversable, not open-ended behaviour: a replay script contains only what that session's recording contains.

## Going deeper

- [docs/architecture.en.md](docs/architecture.en.md) — why an external CLI, module layout, and how this divides labour from comparable tools
- [docs/FAILURE_MODES.en.md](docs/FAILURE_MODES.en.md) — what each log pattern proves, and what it does not
- [SECURITY.en.md](SECURITY.en.md) · [AUDIT.en.md](AUDIT.en.md) · [CHANGELOG.md](CHANGELOG.md) · [PUBLISHING.en.md](PUBLISHING.en.md)

## Development

```sh
npm install && npm test     # 68 tests
node src/cli.js check --candidate 0.2.0-rc.2
```

CI runs `npm ci` + `npm test` across windows / macOS / linux × Node 22.19 / 24.x. CI does not run `run`: that command installs roughly 500 packages and replays session copies, which is neither deterministic nor appropriate on a shared runner. Release procedure: [PUBLISHING.en.md](PUBLISHING.en.md).

MIT License. Not affiliated with or endorsed by DeepSeek. Upstream: [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness); the Desktop host and active issue tracker: [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop).
