# Code audit

[简体中文](AUDIT.md) | [English](AUDIT.en.md)

> **Historical document.** This describes the code at audit baseline `7c374bc` (2026-10-02). The
> P0/P1/P2 entries below are findings **against that baseline**, not a vulnerability list for the
> current `main`; each disposition and its verification is in [Remediation and verification](#remediation-and-verification).

- **Date**: 2026-10-02
- **Subject**: `<repo>/dsh_rehearsal` (git `7c374bc`, clean working tree)
- **Scale**: 1896 lines (src 1611 / test 285, see table below), sole runtime dependency `semver@^7.7.3`
- **Method**: full source read + independent probes (importing its modules directly to assert against them) + forensics on real `~/.dsh` data + post-hoc audit of already generated artifacts
- **Important**: the `run` command was not executed. Reason in P0-1. Everything else (`check`, unit tests, probes) was actually run.

## Status overview

| ID | Severity | Status | Summary |
|---|---|---|---|
| P0-1 | blocking | fixed | the write round replayed recorded tool calls against the real workspace |
| P1-1 | high | fixed | reports carried message bodies through `stderr` tails |
| P1-2 | high | fixed | absolute paths inside evidence objects were not redacted |
| P1-3 | high | analysis | why 22 green tests still missed P1-2 |
| P2-1 | medium | fixed | pre-existing peer mismatch reported as an upgrade regression |
| P2-2 | medium | fixed | turn nesting checked in one direction only |
| P2-3 | medium | reverted to the correct fix | the first fix accepted a false premise; redone against the real structure (countRows=16) |
| P2-4 | medium | fixed | `node_modules` enumerated as a profile |
| P2-5 | medium | fixed | shadow directory not removed in `finally` |
| P2-6 | medium | fixed | child environment construction had side effects |
| P2-7 | medium | fixed | YAML values were not escaped |
| P2-8 | medium | fixed and refined | candidate installs ran lifecycle scripts by default |
| P2-9 | medium | fixed | `GEN_RE` matched only the `.zstd` suffix |
| P2-10 | medium | fixed | numeric overflow in the multi-frame memo key |
| P2-11 | medium | retained (disclosed) | the adoption-gate patch modifies the code under test |
| P2-12 | medium | fixed | `--sample` accepted non-numeric input |
| §7 P3 (8 items) | low | 7 dispositioned | **P3-5 (`--to latest`/`next` versus Desktop app-release units) has no disposition record** |
| §8 unverified (6 items) | — | 3 closed | the rest remain unverified and are kept verbatim |


| File | Lines | Responsibility |
|---|---|---|
| `src/cli.js` | 132 | argument parsing, dispatch of 4 commands, exit codes |
| `src/commands/check.js` | 95 | read-only static health check (A inventory + B1 peer graph) |
| `src/commands/run.js` | 257 | seven-stage rehearsal pipeline |
| `src/lib/zfstd.js` | 92 | multi-frame zstd decoder (the core technical asset) |
| `src/lib/sessions.js` | 151 | session discovery / classification / copy set |
| `src/lib/shadow.js` | 197 | candidate install, llm-replay mounting, patch writing, adoption-gate patch |
| `src/lib/drill.js` | 174 | migration trigger, read-side integrity, keyless write round |
| `src/lib/peers.js` | 146 | static analysis of the peer graph |
| `src/lib/dshhome.js` | 129 | profile/layer/workspace policy resolution |
| `src/lib/report.js` | 107 | `dsh-rehearsal/v1` assembly, redaction, MD rendering |
| `src/lib/util.js` `yaml-lite.js` | 78/53 | child process and env, minimal YAML |
| `test/*.test.js` | 285 | 22 tests |

---

## 0. Overall assessment

Overall engineering quality is high, but the project is not publishable as it stands, and `run` should not be executed again before hardening.

- **Verified as true**: multi-frame zstd decoding (re-checked against real data in §4.1, the evidence is stronger than the code comment states), "artifact-driven verdicts do not consult the exit code", "never use the desktop shim on PATH", and the `link:/file:` non-reproducibility disclosure. All four come from real incidents, which is uncommon among comparable tools.
- **The two unacceptable items**: ① the write round replays historical tool executions in the real workspace (P0-1); ② the report and the shadow artifacts carry message plaintext and unredacted paths, and the related README claims are falsified by this project's own artifacts (P1-1/P1-2).
- README disclosures match the artifacts: its "measured 2 session write rounds PASS (+64/+20 rows, 9/2 assistant rows, turn closed)" agrees item by item with `.dsh-rehearsal/run-*/report.json`, with no exaggeration.

Minimal pre-release closure set: P0-1 + P1-1 + P1-2 + P2-1 (about 60-90 lines of changes plus 4 new tests in total).

---

## 1. Test execution results

| # | Command | Actual result | Judgement |
|---|---|---|---|
| 1 | `npm test` | `Error: Cannot find module '<repo>/dsh_rehearsal\test'` → 1 fail | **Failed** (the documented command itself is unusable) |
| 2 | `node --test test/*.test.js` | `# tests 22 / # pass 22 / # fail 0` | all green |
| 3 | `node src/cli.js check --candidate 0.2.0-rc.2` | normal output, `verdict: do-not-upgrade`, exit=2 | runnable; the conclusion is in P2-1 |
| 4 | `node src/cli.js check --candidate 0.2.0-rc.2 --current 0.2.0-rc.2` | `28 findings (9 high)` (19 findings when current is not given) | `--current` only adds duplicate info entries, it does not change the verdict |
| 5 | `node src/cli.js report ../nonexistent` | exit=3 | matches the docs |
| 6 | `node src/cli.js bogus` | exit=3 + usage | matches the docs |
| 7 | `node src/cli.js clean` | prints `would remove: …\.dsh-rehearsal (rerun with --yes)` | the safety ladder works |
| 8 | `node src/cli.js clean --yes` → not tested | the code is `renameSync` then `rmSync` (cli.js:102-103): renamed first, then deleted | the design is correct, not actually run (it would delete the forensic artifacts) |

**Conclusion**: the functional surface runs and the exit codes match the design; but a freshly cloned repository fails as soon as `npm test` is executed. The root cause is `node --test test/` at `package.json:11` (trailing slash on the directory + Node 22 parsing it as a module under a non-ASCII path). Changing it to `node --test test/*.test.js` is enough.

Missing items: no `.github/` (the three-platform CI in the plan is not implemented), no documentation beyond `LICENSE`, not published to npm, no git remote.

---

## 2. P0 blocker: the write round replays historical tool executions in the real workspace

### 2.1 Facts

Artifact evidence for `e2-write-round` (`.dsh-rehearsal/run-0.2.0-rc.2-1790929231260/report.json`):

```json
{ "id": "session-0ce6f2aa…", "verdict": "pass", "newRows": 64,
  "newTypes": { "assistant/message": 9, "tool/call": 9, "tool/result": 9,
                "step/start": 9, "step/end": 9, "turn/start": 1, "turn/end": 1 } }
{ "id": "session-a1742519…", "verdict": "pass", "newRows": 20,
  "newTypes": { "assistant/message": 2, "tool/call": 1, "tool/result": 1 } }
```

Read with the project's own decoder what these two sessions record in the real store:

| Session | Tool calls recorded | `header.cwd` | header `version` |
|---|---|---|---|
| `session-0ce6f2aa…` | `computer_script` × 7, `pwsh` × 2 (9 in total) | `~` | 0 |
| `session-a1742519…` | `browser_script` × 1 | `~` | 0 |

Code path:

- `run.js:137` and `drill.js:133` set the child process `cwd` to `session.header.cwd` (a real directory, not a sandbox). The reason is that opening a session requires the cwd to match the recorded one, and `drill.js:28-32` ships a built-in `cwd-mismatch` signature (`was recorded in .* not`).
- Fixture source `run.js:199-202`: the session's complete post-migration v4 log, decompressed into `<shadowHome>/fixture-<id>.jsonl`.
- llm-replay intercepts only `llm/stream` (per the official package description), not tool execution.
- headless has no human approval interaction, so tool calls tend to be allowed straight through.

The actual semantics of a "keyless rehearsal" are therefore: take the `computer_script` / `pwsh` / `browser_script` calls from the user's historical sessions and execute them once more, using the real directory recorded at the time as the workspace root. Default `--writeRounds 3` (`run.js:215`), candidate pool of 24 sessions, no supervision throughout.

### 2.2 Unproven boundary

Whether these 9 `tool/result` entries are real side effects or error-results of a "tool not registered" kind is unproven (the shadow directory was already cleaned, so there is nothing to read back). Text of the form `<回放正文引用已移除>` appearing in stderrTail is replayed assistant prose and cannot serve on its own as evidence of execution.

The verdict is unaffected: whichever result holds, the stage has by design no cwd sandbox, no tool suppression, and no `tool/result.isError` check, so it is unsafe for any session history. A single session that recorded `Remove-Item` / `str_replace` against a cloud-drive directory is enough to cause real damage.

### 2.3 Fix options (doing ①+② together is recommended)

1. **cwd sandbox**: after `copySet`, rewrite `header.cwd` in the copies (and every header line in the log in which that cwd appears) to point at `<shadowHome>/workspace/<n>`. The copies are meant to be mutable, and the seq/type/turn integrity checks are unaffected.
2. **Tool suppression**: in `writeReplayPatch`, also write `disabled: true` for the `bash/pwsh/fs/str-replace/computer/browser` rows; if the turn then no longer closes, record the verdict as `inconclusive(tools-disabled)` instead of `pass`.
3. **Explicit authorisation gate**: add `--allow-tools`, off by default; state in the report and on stdout that "this stage executes historical tool calls".
4. **Pre-filtering**: first count tool names and write-class tool occurrences from the fixture; sessions containing write-class tools are skipped by default and counted into coverage.
5. **Forensic reinforcement**: `writeRound` parses `isError` on `tool/result`, so that "executed / executed with error / not registered" are recorded separately in evidence - this also raises how informative the verdict is.

---

## 3. P1 high risk: two README safety claims falsified by this project's artifacts

### P1-1 report contains message prose (README "reports carry zero message bodies" is false)

Measured content of the `stderrTail` field in `report.json` / `report.md`:

> (replay body quotation removed: the audit original quoted replayed assistant prose, redacted to the same standard as P1-1)
> (replay body quotation removed: the audit original quoted replayed assistant prose, redacted to the same standard as P1-1)

- **Root cause**: headless writes reasoning and prose to stderr, `drill.js:168-170 tail()` slices the last 3 lines verbatim into evidence, and `report.js:24` declares `messageContentRead: false` unconditionally.
- **Fix**: change `tail()` to return only the lines that hit a signature plus the error name from the first line; or run stderr through a whitelist of "known non-prose prefixes" (`dsh:`/`Error:`/`patch:`), dropping the rest and recording `stderrDropped:n`.
- **Severity mitigation**: `.dsh-rehearsal/` is in `.gitignore`, and `git ls-files` confirms it is not committed → the exposure surface is the local machine, not the repository.

### P1-2 Windows path redaction fails completely on evidence

Probe results (`node probe.mjs` §2):

| Input | Location | Output |
|---|---|---|
| `~\.dsh` | `details` (bare string) | `~\.dsh` ✅ |
| `~\.dsh\profiles\desktop` | `evidence[0].dir` | kept verbatim ❌ |
| `~\AppData\Local\Temp\dsh-rehearsal-home-abc` | `evidence[0].tmp` | kept verbatim ❌ |
| `<abs-path> coding\proj` | `evidence[0].other` | kept verbatim ❌ |

- **Root cause**: `report.js:64` calls `scrubText` on the text after `JSON.stringify`, by which point the Windows path has become double-backslash `<abs-path>`; the regex `[A-Za-z]:\\Users\\` at `report.js:52` matches a single backslash and never hits.
- **Proof from real artifacts** (structured traversal of `check-1790923403064/report.json`, 3 unredacted absolute paths hit):

  | JSON path | Value |
  |---|---|
  | `.stages[0].evidence[0].marketFacts.path` | `~\.dsh\profiles\desktop\.dsh-market\discovery-compatibility-v1.json` ← contains the username |
  | `.stages[1].evidence[16].source` | `link:<abs-path>` |
  | `.stages[1].evidence[18].source` | `file:<abs-path>` |

  In the same report `stages[*].details` is correct (`home=~\.dsh`) - which proves the defect occurs only on the serialization path through the evidence objects, consistent with the root-cause judgement. The `run` report leaks no username because it contains no `marketFacts` (`grep -c user` = 0).
- **Insufficient regex coverage**: only `\Users\` (Windows) and `/home/` (Linux) are recognised. The local `<driveA>` and `<driveB>` are not covered by the rules - rows 2 and 3 of the table above leaked for exactly that reason.
- **Fix**: switch to structured recursive redaction (walk objects/arrays, call `scrubText` on every string value) instead of patching the whole JSON text; and add a test for `scrubStage`.

### P1-3 why 22 all-green tests still missed P1-2

`test/report.test.js:8-14` tests only `scrubText(bare string)`, never `scrubStage` or the evidence objects; the assertions use names such as `user`/`alice`, which necessarily appear on the details path, so the test shape and the defect shape are offset. Conclusion: redaction needs a case covering the real serialization path (grep the full report text after `finalize()`).

---

## 4. Parts independently re-verified as true

### 4.1 Multi-frame zstd silent truncation: holds, and is worse than the code comment states

Measured on the real file `~/.dsh/sessions/<workspace-dir>/<session-id>/session.v4.jsonl.zstd`:

| | Bytes | Lines | magic/frame count |
|---|---|---|---|
| Source file | 1,669,223 | - | 2 |
| `zstdDecompressSync(buf)` (Node built-in) | **195** | **1** | - |
| project `decodeAll` | **9,405,244** | **1,698** | - |

Node's zlib **raises no error and silently decodes only the first frame**, and that first frame accounts for only 195 B. Any tool reading a dsh session with bare zlib reaches the wrong conclusion that "the session has one line / is corrupt". The backtracking framing algorithm in `zfstd.js` works correctly on real data. Suggestion: put this conclusion at the top of the README and add a large-file regression test.

### 4.2 Isolation did not pollute the real home (forensics)

| Check | Result |
|---|---|
| Total `session.v4.jsonl.zstd` in the real store | 28, all mtimes fall in **9/25-9/28** (written by the host itself) |
| When the rehearsal ran | 10-02 16:20 local |
| Migration artifacts added to the real store after 10-02 | **none** |
| `alreadyV4=28` vs 28 on disk | consistent |
| Changes under `profiles/desktop` at 16:15 | `.plugin-manager/logs`, `pnpm-lock.yaml`, `node_modules/.modules.yaml`, earlier than the run, the host's own behaviour |
| `%TEMP%/dsh-rehearsal-home-*` residue | 0 (but see P2-5: the code has no deletion path) |
| Non-`.zstd` files in real sessions | 0 (see P2-9) |

README red line #1 ("use only the candidate binary installed by the tool's own npm") was enforced.

### 4.3 The gen mapping is correct (the previous round's suspicion was overturned by measurement)

`sessions.js:23` records a version-suffix-free `session.jsonl.zstd` as gen 0. This site was suspected of standing for "the current generation"; measured, the header first line `version` of the two suffix-free sessions is 0, so the mapping is correct and the `maxGen`/`alreadyV4` classification is trustworthy.

### 4.4 Remaining disclosure items checked

`link:`/`file:` marks are not reproducible, the npm shadow is not the Desktop installation, attachment side-paths are not validated, and `--preset-mode patch` modifies the code of the subject under test itself (the composition is not rebuilt) - all of the above are already written into the README/usage.

---

## 5. P2 medium risk: verdict quality and engineering robustness

| # | Location | Problem | Evidence / fix |
|---|---|---|---|
| **P2-1** | `run.js:80` | `run` never passes `current`, so "already unsatisfied today" and "only newly broken by the upgrade" collapse into one and the same blocking fail; a machine already on 0.2.0-rc.2 is reported `do-not-upgrade` (exit 2), which must produce false positives | Measured: passing `current` for the same input adds `peer-incompatible/info` entries. Fix: only `satisfies(current) && !satisfies(candidate)` is high; neither satisfied → `pre-existing`/warn. All 9 high findings come from the three official packages `@deepseek-ai/dsh-browser-use*` pinning their peer exactly at `0.1.7-rc.1` (a real incompatibility, see §6) |
| **P2-2** | `drill.js:76` | `openTurns = Math.max(0, openTurns-1)` swallows surplus turn/end rows | Probe: a stray `turn/end` → `ok: true`; an unclosed `turn/start` → `ok: false`. "turn boundaries closed" is checked in one direction only. Fix: count negative values separately and report an issue |
| **P2-3** | `yaml-lite.js:9,18` | `countRows`/`rowIds` recognise only column-0 `- id:` and never enter `insert:` blocks | Real desktop patch: `countRows=14`, plus one `- insert:` containing 12 nested ids that are not counted. Such plugin rows are easy to rename or to lose, and this is a signal S1 needs. Fix: collect recursively and label `scope: top\|insert` |
| **P2-4** | `dshhome.js:16-20` | `listProfiles` treats `node_modules` as a profile | Measured `profiles=[desktop, headless, node_modules, web, zcode-test]`. Currently not selected because `profiles/node_modules/package.json` does not exist (`exists:false`). Fix: exclude `node_modules` and the `.` prefix |
| **P2-5** | `run.js:95,248-250` | `shadowHome` has no deletion path at all, only `prefixDir` is deleted | The shadow holds full session copies plus `fixture-<id>.jsonl` (complete plaintext bodies). `clean` covers only `.dsh-rehearsal/`. Fix: when not `--keep`, delete in `finally`; before deleting, record the path in the report together with a "contains plaintext copies" warning |
| **P2-6** | `util.js:58` | `delete process.env.DEEPSEEK_API_KEY` mutates the parent process env (it takes effect through a side effect) and strips only this one name | Fix: filter when constructing the child env with `/API_KEY\|TOKEN\|SECRET\|CREDENTIAL/`; record the stripped variable names in the report (never the values) |
| **P2-7** | `shadow.js:136-141` | provider/model ids extracted from user sessions are concatenated into YAML without quoting | An id containing `:` `#` `{` produces broken YAML, so an activation failure gets misread as an incompatibility. Fix: `JSON.stringify(v)` |
| **P2-8** | `shadow.js:76` | The candidate install adds no `--ignore-scripts` | postinstall of ~500 packages runs directly on the user machine (`allowBuilds` is an explicit whitelist in the real profile, so that policy is effectively bypassed here). Fix: `--ignore-scripts` by default, turned on explicitly when a build is needed |
| **P2-9** | `sessions.js:23` | `GEN_RE` recognises only `.zstd` | 0 uncompressed session files on this machine (measured), but the official `generationLogFilename(version, compression)` shows that both forms coexist → a potential missed detection. Fix: `(?:\.zstd)?` |
| **P2-10** | `zfstd.js:61` | the memo key `start*4294967296+end` exceeds `MAX_SAFE_INTEGER` | Measured on 3.78 MB (3,776,880 B) → `1.59e16 > 9.007e15`; the threshold is about 2.1 MB. The 3,776,880 B file cited in the comment is already above the threshold → the `failed` set starts losing precision and neighbouring keys collide, so the backtracking verdict can be distorted. Fix: `` `${start}:${end}` `` or Map-of-Sets |
| **P2-11** | `shadow.js:171-188` | `patchAdoptionGate` modifies the code of the subject under test itself (injecting `return void 0` into `dsh-headless/lib/index.js`) | Already labelled as a format-level conclusion, acceptable. The `*.rehearsal-orig` backups stay inside the prefix; when not `--keep` the whole prefix directory is deleted, so nothing remains - checked. Suggestion: raise this fact from the README into a `check`/`run` stdout banner, so it is not treated as running an unmodified candidate |
| **P2-12** | `run.js:47` | In `sample: opts.sample ?? 20`, `opts.sample` is a string | The correct result currently depends on the implicit coercion of `slice(0,'20')`. Fix: `Number(...)` and validate that it is a positive integer |

---

## 6. A finding produced as a by-product (overturns the previous round's review conclusion)

The previous round's review conclusion on the plan was: "the peers of the 7 third-party plugins of the local desktop all already cover 0.2.0 → the acceptance criterion (find at least one class of real incompatibility) is trivial or empty". That judgement does not hold, and it is falsified by this project's code and by measurement.

All 9 high findings of `check --candidate 0.2.0-rc.2` come from official experimental packages that the previous round did not cover:

```
@deepseek-ai/dsh-browser-use                                 → dsh-brand                       0.1.7-rc.1
@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp → dsh-browser-use / -agent /
                                                                -tools / -system-prompt       0.1.7-rc.1
@deepseek-ai/dsh-experimental-browser-use-playwright-mcp      → dsh-browser-use / -agent /
                                                                -tools / -system-prompt       0.1.7-rc.1
```

In the profile these three packages sit at `0.1.7-rc.1` with their peer pinned to exactly that version, while the desktop runtime is already `0.2.0-rc.2` - a version mismatch that really exists and is in effect right now (unexposed only because of the official `allow-version` exemption or because the desktop side does not validate it). This is exactly the result a peer-graph check should produce.

A second omission from the previous round: the conclusion "reading v4 sessions with zero dependencies is feasible" is incomplete. What was checked then was only "the official code also uses `node:zlib`"; multi-frame silent truncation was not covered (§4.1) - bare zlib reads 1698 lines as 1 line.

---

## 7. P3 documentation / release

1. `README.md:69` says "20 tests", measured 22; and the `npm test` command itself fails (§1).
2. `README.md:39` red line #1 currently only says "will pollute the real home", without the reason (the desktop shim ignores `DSH_HOME`). Suggestion: write the forensic method of §4.2 into the documentation, as the step that verifies non-pollution.
3. `README.md:49` conflicts with §2: the body only says "attachment side-path data is neither copied nor validated", without stating that the write round executes tools. This item must be added.
4. `HOMEISH` at `report.js:47` is dead code (exported, never referenced), and its regex likewise recognises only single backslashes → delete it.
5. `--to latest` and `--to next` are currently semantically equivalent (npm `dist-tags`: `latest = next = 0.2.0-rc.2`); the real upgrade unit for Desktop users is the app release (v2.0.17 / NEXT / Beta), so the documentation needs to separate the two coordinate systems.
6. No CI: the plan requires Windows/macOS/Linux, and the `platform`-related code carries both a `where.exe` and a `which` path (`shadow.js:23-46`), but no test covers the non-Windows branch.
7. Unpublished: the name `dsh-rehearsal` is still free on npm/GitHub (checked, 404 / no repository), and the community has a name-squatting precedent (`dsh-testnet`).
8. The `html` report format promised in the plan is not implemented (json/md only).

---

## 8. Items not verified

| Claim | Why not verified |
|---|---|
| `--dump-config-schema` returns exit 1 even on success | requires running the candidate binary, i.e. the risk surface of P0-1 |
| 0.2.0 renames the row from `dsh-llm-deepseek` to the `-api-key`/`-account` variants | `npm pack` already retrieved `dsh-llm-deepseek@0.1.7-rc.2 / 0.2.0-rc.2`, but the patch row names were not extracted; needs redoing |
| "Since rc.1 the migration package carries a `producerKind` rewrite map, and rc.1 is byte-identical to 0.2.0" → #1229 not reproducible on this machine | requires running `run` or diffing the two migration packages directly |
| Whether the 9 `tool/result` entries are real executions or error-results | the shadow was already removed, nothing to read back (→ fix ⑤ under P2-5/P0-1 makes this judgeable in future) |
| Two cold boots are enough to distinguish flapping | upstream #1294 carries only single-instance evidence |
| How trustworthy the `--preset-mode patch` verdict is after the adoption-gate has been neutralised | 0 preset hits among the 52 local sessions, so the branch is not covered by real data - a fixture carrying a preset is needed to test it specifically |

---

## 9. Suggested fix order (directly executable)

**First batch (close the unacceptable items, about 60-90 lines)**
1. `run.js` / `drill.js`: cwd sandbox (rewrite `header.cwd` in the copies) + `--allow-tools` gate + `tool/result.isError` forensics
2. `shadow.js:writeReplayPatch`: a `disabled` option for tool rows + `JSON.stringify` for values
3. `drill.js:tail` → keep only the signature-hit lines; change `messageContentRead` at `report.js:24` to a declaration matching actual capability
4. `report.js:scrubStage` → structured recursive redaction; widen the regex to cover drive paths other than `Users`
5. `test/report.test.js` → add a case that greps the full text after `finalize()` for the absence of `Users\\`, path middles, and prose
6. `package.json:11` → `node --test test/*.test.js`

**Second batch (verdict credibility)**
7. `run.js:80` pass `current` + peer severity tiering (pre-existing vs newly-broken)
8. `drill.js:76` two-way turn balance; make `yaml-lite.js` enter `insert:` blocks
9. `dshhome.js:16` exclude `node_modules` and dot-prefixed directories
10. `run.js` delete shadowHome in `finally`; `util.js` strip the env in full; `shadow.js` `--ignore-scripts`; `zfstd.js` change the memo key to a string

**Third batch (release)**
11. `.github/workflows/ci.yml` three-platform CI (a prerequisite is `npm test` being fixed)
12. README: add "the write round executes tools" and "how to verify the real home was not polluted"
13. Build a session fixture carrying an `agentPreset`, to cover the `--preset-mode patch` branch
14. A `dsh-test-drive/v1` compatibility layer (the downstream interop promised in the plan; the README only mentions "style compatibility" and the code does not implement it)

---

## Appendix A - reproduction commands

> Published-version note: wherever a local store path is involved it has been replaced with the `<workspace-dir>` / `<session-id>` placeholders (the originals were real directory names and would leak the user's directory structure). Every other command was actually run and verified on 2026-10-02; the placeholders must be replaced with the real names under the local `~/.dsh/sessions`.

```bash
cd "<repo-root>"

# 1 测试：文档命令失败 vs 逐文件全绿
npm test
node --test test/*.test.js            # # tests 22 / pass 22

# 2 check 与退出码
node src/cli.js check --candidate 0.2.0-rc.2; echo "exit=$?"        # 2
node src/cli.js check --candidate 0.2.0-rc.2 --current 0.2.0-rc.2   # 28 findings (9 high)
node src/cli.js bogus >/dev/null 2>&1; echo "exit=$?"               # 3

# 3 消息正文与脱敏失效（对已有产物，命令均已实跑）
grep -c "reasoning\|Calculator\|screenshot" .dsh-rehearsal/run-0.2.0-rc.2-*/report.json   # 2
grep -n "user" .dsh-rehearsal/check-*/report.json      # 第 76 行 marketFacts.path

# 结构化定位未脱敏字段（比 grep 更可靠，实测命中 3 处）
node -e 'const j=require(process.cwd()+"/.dsh-rehearsal/check-1790923403064/report.json");
const hits=[];const walk=(o,p)=>{if(typeof o==="string"){if(/Users|[A-Za-z]:[\\\\/]/.test(o))hits.push(p+" = "+o.slice(0,70))}
else if(o&&typeof o==="object"){for(const k of Object.keys(o))walk(o[k],p+"."+k)}};walk(j,"");
console.log(hits.length+" 处未脱敏:");hits.forEach(h=>console.log(" "+h))'

# 4 多帧 zstd 静默截断（真实数据）
node --input-type=module -e '
import {zstdDecompressSync} from "node:zlib"; import fs from "node:fs";
const p="~/.dsh/sessions/<workspace-dir>/<session-id>/session.v4.jsonl.zstd";
const b=fs.readFileSync(p); const n=zstdDecompressSync(b);
console.log("src",b.length,"naive bytes",n.length,"naive lines",String(n).split("\n").filter(Boolean).length);'
#   src 1669223  naive bytes 195  naive lines 1     ← 对比 decodeAll: 9405244 B / 1698 行

# 5 隔离取证：真实库有没有被彩排写过
find ~/.dsh/sessions -name "session.v4.jsonl.zstd" -printf "%TY-%Tm-%Td %TH:%TM %p\n" | sort | tail -3
#   全部 9/25–9/28 → 10-02 的 run 未触碰真实会话
ls -d /c/Users/user/AppData/Local/Temp/dsh-rehearsal-home-* 2>/dev/null | wc -l   # 0
```

## Appendix B - local forensic snapshot

| Item | Value |
|---|---|
| Real DSH_HOME | `~\.dsh` (`DSH_HOME` is not set in the environment, so the default applies) |
| Actual content of the profiles directory | `desktop`(11 bundles / 198-line patch / `countRows`=14 / 12 nested ids / 1 `- insert:`), `headless`(created 01:29, not from this run), `web`(4/4), `zcode-test`(leftover from 9-23), `node_modules`(249 entries) |
| Session store | 52 session directories; file composition 28×`session.v4.jsonl.zstd` + 23×`session.jsonl.zstd` + 22×`session.v3.jsonl.zstd`; 0 non-`.zstd` session files |
| Out-of-tree dependencies | 7, of which 3 are not reproducible: `link:<abs-path>`, `file:<abs-path>`, `github:csyangwen/dsh-memory-evolve#e6f6b84` |
| pnpm-workspace policy | `nodeLinker: hoisted`, `autoInstallPeers: false`, `allowBuilds: {node-pty: true}`, `minimumReleaseAgeExclude: dsh-better-sidebar@0.16.1 / 0.21.1 / dshmarket@1.61.0` (`simpleListAfter` parses correctly ✅) |
| Version anchors | real runtime = the Desktop-bundled **0.2.0-rc.2**; the npm CLI on PATH = **0.1.1-rc.2** |
| DSH Desktop | running (8 processes), never touched by a `dsh` subcommand throughout |

---

## Remediation and verification

Disposition and evidence per finding. The baseline is the commit named in the metadata above; the verification column records commands and tests actually executed, not intentions.

### First batch (closing the "unacceptable items")

| Audit item | Disposition | Verification |
|---|---|---|
| **P0-1 the write round replays historical tools in the real workspace** | Three stacked layers of fixes: ① `copySet` rewrites the copies' header.cwd into the shadow `workspace/<n>`, and the copies must simultaneously be relocated into the workspace directory named by `encodeCwdDir(sandbox)` (the harness derives the physical path from header.cwd, so the two must agree); ② the replay patch disables all `tool-*` rows by default (the `tools` registry is kept), measured as 17 rows disabled; ③ pre-filtering: the replay script can only emit tools that already appear in that session's history (deterministic), and sessions containing write-class tools are skipped and counted into coverage. `--allow-tools` explicitly lifts ②③ (① is always in effect) and prints a banner before running. Bucketed forensics for `tool/result` (errorFlagged/unknownToolish/other) | Safe mode on a real machine: migration 9/9 (inside the sandbox), pre-filter skipped 7, 2 write rounds over tool-free histories PASS (one of them with toolResults.errorFlagged=1, which proves the suppression took effect); tests: sandbox rewrite, encodeCwdDir against real directory names, pre-filtering, bucketing |
| Incidental finding (during the fix) | The official validation requires "the first frame to be exactly one header row" → re-compression must be **one row per frame**; the session directory name is derived by encoding header.cwd (`~XXXX` with no closing tilde, space = `~0020`) → implemented as `encodeCwdDir`, with the local real directory names as the test baseline | Reverse-inference from error messages + comparison against on-disk ground truth |
| **P1-1 report contains message prose** | `sanitizeStderr`: the whitelist keeps only `dsh:`/error-class/stack lines, dropping `dsh: reasoning:` marker lines and all prose, with a counter (`stderr.dropped`); `errorName` now uses `firstDiagnostic` (which skips reasoning markers); `messageContentRead: false` was replaced by the honest declaration `messageContentInReports: false` plus a `stderrEvidence` note | Unit tests: prose must disappear, diagnostics must survive, the dropped count must be right; a leak scan of the real-machine report for the keywords `reasoning/Calculator/Stop-Process` = CLEAN; measured on one write round dropped=6 with an empty summary |
| **P1-2 evidence paths not redacted** | `scrubStage` changed to **structured recursion** (running `scrubText` on each string leaf, no longer patching the double-backslash text produced after JSON.stringify); the regex extended to any drive letter (`D:\Any\path`, `link:D:/...` → `<abs-path>`) plus `/Users/` (mac); coverage/target redacted as well; the HOMEISH dead code deleted (P3-4) | Unit test: after `finalize()`, `JSON.stringify(report)` asserted to contain no username, path middle, synthetic plugin name, `/home/`, or credential; structured scans of the real-machine check/run reports = CLEAN (the same scan hit 3 places before the fix) |
| The `npm test` command fails (§1) | `node --test test/` → `node --test` (automatic discovery) | `npm test` 42/42 pass |
| P2-1 (listed by the audit in the minimal closure set) | `detectCurrentDshVersion` (four-way probing: profile/mirror/Desktop bundle/npm prefix) + peer severity tiering: only "satisfied by the current version, unsatisfied by the candidate" = high/blocking; neither satisfied = `peer-incompatible-pre-existing`/warn | Real-machine check: current=0.2.0-rc.2 auto-detected, all 9 judged pre-existing, the verdict moved from `do-not-upgrade`(2) to `upgrade-with-conditions`(1); unit tests cover the three branches |

### Second batch (verdict quality and robustness)

| Audit item | Disposition | Verification |
|---|---|---|
| P2-2 turn balance checked in one direction | Surplus `turn/end` counted as a stray issue (no more clamping) | Unit test: stray → ok=false |
| P2-3 rows inside insert blocks undercounted | ⚠️ Third-round correction: the first version of the fix was wrong (it accepted the "12 nested ids" premise that the audit had already retracted, and any-indent counted config model entries into the row total, 14→26). Now rolled back to the real file structure: column-0 `- id:` = a row; an `- insert:` block counts only the indent of its first child (on the real machine the child sits at indent 4 in `- name:` form); deeper `- id:` rows are sub-config and are not counted | Real-machine desktop countRows = 16 (14 rows + 2 insert); the unit test includes a deep-nested config regression; `rowIds` was dead code and has been deleted |
| P2-4 node_modules treated as a profile | `node_modules` and dot-prefixed directories excluded | Unit test + the real-machine profiles list is clean |
| P2-5 the shadow is never deleted | Unless `--keep`/`--shadow-dir` is set, stage F deletes the shadow (including the plaintext fixture); the README states how sensitive --keep is | Real machine: tmp residue after run = 0 (a --keep diagnostic run was cleaned up by hand) |
| P2-6 env side effect | `shadowEnv` returns the **complete** child env (`API_KEY/TOKEN/SECRET/CREDENTIAL/PASSWORD/PRIVATE_KEY/AUTH` all stripped), and run() no longer writes back into process.env; the stripped list goes into the report | Unit test: the parent env is not modified, the child env holds no key, PATH survives |
| P2-7 YAML injection | All provider/model ids go through `JSON.stringify` | Code review |
| P2-8 install scripts | Candidate install uses `--ignore-scripts` by default, lifted explicitly with `--run-scripts` | Real machine: `install scripts denied`, and under a script-free install the double cold boot + migration + write round all pass |
| P2-9 GEN_RE recognises only .zstd | `(?:\.zstd)?` + `readHeader` accepting bare JSONL | Unit test |
| P2-10 memo key overflow | `start*2^32+end` → `` `${start}:${end}` `` (key collisions from precision loss on files >2.1MB eliminated) | Code review + multi-frame regression |
| P2-11 adoption-gate patch | Kept; the banner is already disclosed in the c-shadow details | Run evidence |
| P2-12 sample is a string | `Number()` + positive-integer validation, throwing on anything invalid | Code review |

### Third batch backlog (items not done as of the 2026-10-02 acceptance; some have since landed separately, see the CHANGELOG)

- `.github/workflows/ci.yml` three-platform CI
- A `dsh-test-drive/v1` compatibility layer (the current schema is `dsh-rehearsal/v1`, and the stage records are only "stylistically similar")
- The HTML report format (json/md only)
- Fixture-based unit tests for sessions carrying an `agentPreset` (the real machine is already fully covered by `--preset-mode patch`: 15 preset sessions, migration 24/24, but no standalone fixture unit test)
- The `--allow-tools` path has no real-machine regression (it is equivalent to the old behaviour verified in the previous session plus a pre-filter bypass; real histories contain `Stop-Process`-class commands, which should not be executed just to verify)

### Two corrections to the audit itself (found during acceptance)

1. §8 "the `--preset-mode patch` branch was never exercised by real data, preset hits 0" - **misreading**: `skipped: preset=0` means "0 sessions skipped", and that run was in patch mode (drillable 9→24, all 15 preset sessions migrated successfully). The part that holds: the write-round counts did land on non-preset sessions.
2. P2-8 fix refined: a blanket `--ignore-scripts` is not possible (node-pty/koffi are allowed entries on the official allowBuilds whitelist); implemented as deny-by-default plus a `--run-scripts` escape hatch, with the default path verified on a real machine.

Three of the six "not verified" items in audit §8 were closed by evidence the accepting side already had (schema exit 1, the 0.2.0 row rename to `-api-key`, producerKind identical across the two versions).

---

## Third round of fixes (the report of evaluator 2, 2026-10-02)

| Claim | Disposition | Verification |
|---|---|---|
| **#2 AUDIT.md contains prose/paths/UUIDs and had been committed** | Holds; the cause is `git add -A` committing the unredacted document along with everything else. Disposition: **redact, keep the document** (the 2 replayed-prose quotation blocks replaced with placeholders, paths redacted to the same standard as reports → `~`/`<abs-path>`, UUIDs truncated, residual identity words brought to zero), `git commit --amend` to rewrite the original commit + `reflog expire` + `gc --prune=now`; the old commit object `7c14a70` is gone from the object database (`git cat-file -e` reports not valid) | `git log --all -S"<正文短语>"` returns no hits; the count of usernames/`C:\Users`/full UUIDs inside the tree = 0. **Residual disclosure**: `test/report.test.js` in the root commit `80c9630` contains one synthetic scrub fixture (a bare username, no path/prose/UUID) - the working tree now says Jane; a squash is available if zero residue in history is required (not done, pending a decision) |
| **#3 pre-filter denylist fail-open + layer b recognises only tool-* + the suppressToolRows default contradiction** | The mechanism is real (mcp__*, job_kill, present probed one by one, all pass through); but the live-fire scenario of "both MCP defences falling at once" does not hold - the shadow is a bare headless template (measured: a 96-row dump with no MCP client row, and the template's MCP config is an empty `[]`), and the executor rows of job_kill/present/skill/workflow are exactly tool-* rows, already blocked by layer b. **The stated fix was carried out anyway**: ① the pre-filter flipped to an **allowlist** (`READONLY_TOOLS`, 16 built-ins proven read-only; `memory` (add writes cross-session memory)/dtodo/compress/the `mcp__*` prefix/`__unnamed__` all fail-closed); ② layer b changed to a double match on id + **package-name prefix** (`dsh-tool-`/`dsh-mcp-`/`dsh-skill`/`dsh-browser`/`dsh-terminal`/`dsh-jobs` + `^terminal-`; the `tools` registry is never disabled, and the hyphen boundary of `dsh-tool-` keeps `dsh-tools` out of harm's way); ③ `suppressToolRows` defaults to true, aligning with its comment. **Incidental finding**: extraction must cover four row shapes - a whole-store census confirms that run_code calls appear largely only in `tool/ptc-dispatch`/`tool/code-dispatch` rows (1836 occurrences), so scanning only `tool/call` would miss them | Unit tests: 36 census samples passed through the allowlist one by one, four-shape extraction, a sentinel for unnamed rows; the two demos that PASSed in the previous round (`read_image`, tool-free) remain drillable under the allowlist |
| **#4 two leak paths in sanitizeStderr + inconsistent rules** | Real (a concatenated string gives dropped=0 and survives whole, prose starting with `at ` survives, and a bare `fail` prefix was found leaking the same kind of way). Fix: a shared `isDiagnostic` extracted (so the sanitizer and firstDiagnostic come from one source); for `dsh: reasoning:` the `$` anchor became a prefix exclusion; an `at ` row is kept only when it contains `file://`/`node:`/`:line:col`; the bare `fail` deleted; firstDiagnostic skips stack frames and takes the error title | One unit test per leak path (three) + a consistency assertion; the dominant shape of the current pipeline (header on its own row) was already safe (measured: dropped=2, no prose survives) |
| **#5 cleanup is not in finally** | Real (after mkdtemp, any early return or throw leaves a shadow containing plaintext undeleted). Restructured: `cleanupShadow()` is an idempotent closure, and an outer try/finally covers every exit path (the success path cleans up before writing the report and records `report.shadowCleanup = removed\|kept\|failed`) | Failure-path verification: `run --to 9.9.9-bogus` → install fails exit 3 → tmp residue = 0 |
| **#6 P2-3 over-correction (the other party retracted its own previous-round claim)** | Holds; the previous round of acceptance accepted that wrong premise without an independent re-check, which is a gap on the accepting side. The rollback is in the P2-3 row of the table above | Real machine countRows=16; `rowIds` dead code deleted |
| **#7 minor items** | The double check probe → promoted to a single `current`; the real-cwd gate in classify (redundant after sandboxing) → changed to "the header must carry a cwd field", and sessions whose directory no longer exists are **turned into drillable ones** (a positive gain in coverage), while a missing cwd field still goes into cwdMissing; patch comments containing paths/ports: the report still stores only counts, with redaction on the writing side as an established constraint | Unit tests updated (session-gone becomes drillable, session-nocwd goes to cwdMissing) |
| "the preset branch was never exercised, 0 hits" | The evidence was wrong (it repeats §8's misreading of `skipped: preset=0` as "0 hits"); but its core (the fixed code never exercised against preset data) had already stood before being pointed out - **closed with `--full --preset-mode patch`**: drillable=24, gate in effect, **migrated=24/24 including 15 presets**, 2 write rounds PASS (that run's results are recorded here; the artifact directory was cleaned per convention, and the newest retained artifact is the sample-9 final-verification run) | Run output: see the record in this row |
| "three items are still not verified" | Out of date - the previous round of acceptance already closed them by measurement (schema exit 1 / the `-api-key` row name / producerKind identical across the two versions) | See the acceptance record above |
