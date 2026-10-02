# Failure signatures

[简体中文](FAILURE_MODES.md) | [English](FAILURE_MODES.en.md)

`run` classifies a set of known log patterns and artifact conditions. Each signature records four things:

- where it is detected;
- what a hit means;
- what a non-hit does not prove;
- whether it has been reproduced on this machine.

A signature is evidence, not a diagnosis by itself. Origins are anchored to an upstream issue number where one exists, and to a `file:line` in this repository otherwise.

## Verdict semantics

- **`pass`** — the tested property was observed.
- **`fail`** — the tested property was violated.
- **`inconclusive`** — the rehearsal did not exercise the path far enough to decide. Neither a pass nor a failure.

One string, `MISSING_CREDENTIAL`, means opposite things in two stages (see section 3). That is why verdicts derive from artifacts and never from exit codes.


---

## 1. Signatures that decide a failure

| id | Log pattern | Detection site | What a hit means | Origin | Reproducible here |
|---|---|---|---|---|---|
| `v4-producer-source-kind` | `format v4 message requires a producer-owned source kind` | `src/lib/drill.js:14-20`; write round judged `fail` at `src/lib/drill.js:324` | The session contains v3 legacy `source.kind:"plugin"` rows: every read-side check passes and every write round fails | Upstream [`#1229`](https://github.com/anywhere-labs/dsh-desktop/issues/1229); the issue title is this sentence | No. Since `0.2.0-rc.1` the `@deepseek-ai/dsh-session-format-v3-to-v4` migration package carries a `producerKind` rewrite map (its `lib` directory is byte-identical between rc.1 and 0.2.0-rc.2), so local data was already rewritten during migration. The detection is retained to fire if a future host or historical data exhibits the shape |
| `SessionFormatError` | `SessionFormatError` (matched by regex, no id) | `src/lib/drill.js:324`; write round judged `fail` | The host rejects the post-migration artifact for a format reason | Same family as the row above, broader shape | No, same reason |
| `no v4 generation after write round` | No log match; the criterion is a missing artifact: `session.v4.jsonl.zstd` absent after the write round | `src/lib/drill.js:312-314`; judged `fail` | The host refused to publish that generation, or the migration chain breaks on the write path | Locally defined criterion (exit status is not consulted) | No |

## 2. Boot-stage signatures

| id | Log pattern | Detection site | What a hit means | Origin | Reproducible here |
|---|---|---|---|---|---|
| `patch-entry-not-found` | `patch: entry "<id>" not found` | `src/commands/run.js:21`, used for cold-boot attribution | A row in `cordis.patch.yml` targets an entry that does not exist in the load tree | Upstream [`#1294`](https://github.com/anywhere-labs/dsh-desktop/issues/1294): line 30 of the issue body carries the real log `patch: entry "llm-commandcode" not found` and `patch: entry "mnemon" not found`, followed by 120 seconds of no output; line 31 records the Main process RPC timeout and entry into recovery mode | No; every patch row in this machine's profiles resolves |
| `port-in-use` | `EADDRINUSE` | `src/commands/run.js:22` | Port conflict, an environment problem, not a compatibility conclusion | Locally defined | Yes |
| `module-missing` | `Cannot find module` | `src/commands/run.js:23` | Incomplete candidate install, or a missing native module (more likely with `--ignore-scripts`, the default) | Locally defined | Yes, constructible |

`#1294` also documents a second failure shape. It is not a signature but the basis for a flow
decision: after a batch plugin upgrade the first cold boot hit a 30-second renderer health-report
timeout, while an identical configuration booted normally on the second attempt. `run` therefore
always performs two cold boots (`src/commands/run.js:164`): one failing and one succeeding is
recorded as jitter, not as incompatibility.

## 3. Shapes that do not indicate failure

| Shape | Where | Correct reading |
|---|---|---|
| `MISSING_CREDENTIAL` | cold boot (`src/commands/run.js:169,178`); write round (`src/lib/drill.js:325`) | During boot it is the pass criterion: the process lived to the model-call boundary, which is where a keyless run should stop. During a write round it means not exercised: replay did not intercept the provider route, the write path was not fully traversed, so the verdict is `inconclusive`, never `pass` |
| `no adapter registered`, `llm-replay:` | `src/lib/drill.js:325` | The replay mount did not take effect; `inconclusive` |
| Tool result rows containing `not registered`, `unknown tool`, `not found` | `src/lib/drill.js:217-226`, counted as `unknownToolish` | Expected artifact: the write round suppresses all tool providers by default (`suppressToolRows` in `writeReplayPatch`, `src/lib/shadow.js`), so a replayed call should only return this error. Not a compatibility signal |
| Tool result rows containing `"isError":true` | same site, counted as `errorFlagged` | Rows that already errored in the recording; unrelated to this upgrade |
| `runs under agent preset … which the one-shot runner does not compose` | `src/lib/drill.js:22-25`, severity `warn` | The one-shot runner's adoption check was not neutralised. If it appears while `--preset-mode patch` is in use, it points at a sampling or patching problem, not host incompatibility |
| `was recorded in … not …` | `src/lib/drill.js:28-31`, severity `warn` | cwd does not match the recorded value, i.e. the sandbox rewrite did not take effect (`copySet` must rewrite the header and relocate the directory together). A defect signal about this tool |
| Migration "failed" with exit code 1 | all stages | A successful keyless migration also exits 1 with `MISSING_CREDENTIAL`; `--dump-config-schema` sets `exitCode=1` by design while writing valid JSON to stdout. Verdicts come from artifacts, never from exit codes |
| `turn/end` present but `reason.kind === "error"`, and no new `assistant/message` row | `src/lib/drill.js:323` | Skeleton false positive. `pass` requires both conditions: the turn closes and a message lands |

The two `warn` shapes in this table (`preset-not-composed`, `cwd-mismatch`) take their wording
from the host's own error text and have never appeared in a rehearsal on this machine; the only
related evidence present in the artifacts is `assistant/attempt` (see section 4). They are kept as
sentinels: the host rewording that text means a premise has changed. They are not evidence that
anything was tested. The fixtures in `test/signatures.test.js` mark them as template-derived and do
not present them as real lines.

## 4. Preset-bearing sessions are structurally undecidable

`--preset-mode patch` neutralises that single adoption check and does not rebuild the preset
composition. Measured (2026-10-02, 2/2): replay does not intercept the provider route of a
preset-bearing session, so the run ends at `MISSING_CREDENTIAL` and the new rows land as
`assistant/attempt` rather than `assistant/message`.

Write rounds for preset sessions therefore run and are reported (`evidence[].preset`,
`coverage.writeRounds.presetAttempts` / `presetPass`) but cannot decide a stage verdict alone:
`writeRoundVerdict()` (`src/lib/drill.js:101`) takes pass/fail only over non-preset rounds, and a
sample containing only presets yields `inconclusive` for the stage.

## 5. Adding a signature

The procedure follows `dsh-plugin-lab`, with the anchor changed to an issue number:

1. Add `{id, pattern, note, severity}` to `WRITE_FAIL_SIGNATURES` in `src/lib/drill.js` or
   `BOOT_SIGNATURES` in `src/commands/run.js`; `note` states the origin (issue number or
   `file:line`).
2. Add a matched pair of assertions in `test/signatures.test.js`: the real log line must hit, a
   healthy line must not. The log must be copied from an issue body or a real artifact, never
   invented to satisfy the regex.
3. Add a row to the relevant table above and state honestly whether it is reproducible here.
   Recording the reason matters: without it a reader assumes the case was tested.
