[简体中文](SECURITY.md) | [English](SECURITY.en.md)

# Security policy

This tool is not a security boundary.

## Guarantees

The properties below are enforced in code and covered by tests. A report that any of them is broken is a vulnerability report.

| Guarantee | Where |
|---|---|
| The rehearsal never installs into a live profile; the candidate goes into a private npm prefix with `DSH_HOME` pointed elsewhere | `src/lib/shadow.js` `installCandidate` |
| Session copies have their recorded `cwd` rewritten into the shadow home and are relocated to the matching encoded workspace directory | `src/lib/sessions.js` `copySet` |
| No credential-shaped environment variable reaches a child process; only the stripped variable names are recorded | `src/lib/util.js:56-75` |
| Telemetry is force-disabled (`DSH_TELEMETRY_MODE=DISABLED`) | `src/lib/util.js:75` |
| Reports contain no message bodies and no user paths: `stderr` keeps only diagnostic lines, evidence objects are redacted per string, and `finalize()` scrubs every stage, the coverage block, the target and the warnings | `src/lib/report.js:136`; a separate test greps the finished report for home paths and reasoning markers |
| Tool providers are suppressed by row id and by package-name prefix by default; a session is drilled only when every tool in its own history is on the read-only allowlist (fail-closed) | `src/lib/shadow.js`, `src/lib/drill.js` |
| The shadow home holds plaintext session copies and is deleted on every exit path, with the outcome recorded as `shadowCleanup` | `src/commands/run.js` |

## Explicitly dangerous options

**`--allow-tools` is not a sandbox capability. It is an explicit request to execute recorded tool calls.**

| Flag | Consequence |
|---|---|
| `--allow-tools` | Executes the tool calls recorded in session history. The sandboxed `cwd` still applies, but `pwsh`, `bash` or any absolute path can leave that directory. A banner is printed before execution |
| `--keep` | Leaves plaintext session copies in the shadow home and the install prefix. Do not use it on an unmanaged machine; remove the output afterwards with `dsh-rehearsal clean --yes` |
| `--run-scripts` | Lets the candidate install run third-party lifecycle scripts. The default is `--ignore-scripts`, matching the short build-script list the official pnpm setup whitelists |

## Reports are sensitive data

`report.json` and `report.md` derive from local session data. Redaction is a filter, not a proof: do not paste report files or `run` output into a public issue. Both files stay on disk; this tool uploads nothing.

The filter recognizes a bounded set of shapes: `C:\Users\<name>`, `/home/<name>` and `/Users/<name>` collapse to `~`, and any drive-rooted absolute path collapses to `<abs-path>`. It does **not** recognize a Unix home outside `/home` (for example `/srv/users/<name>` or `/var/lib/<service>`), a UNC share, or a relative path. Fields that must appear in a report and would otherwise carry such a value now record a shape instead (`home=default|custom|unknown`) so the path never enters the string: relying on a regex to mask a shape known to slip through is not a sound design. Other free-text fields remain covered by that bounded set only.

## Out of scope

- Not a sandbox against a hostile candidate `dsh`. A rehearsal runs a build of the harness under evaluation; file-level precautions do not apply to a malicious build.
- Not a defence against installed plugins. A rehearsal loads the pinned plugin set, so a plugin that exfiltrates data does so during the rehearsal as well.
- Attachment side data (`~/.dsh/attachments`, `cache/attachments`) is neither copied nor verified; attachment-reference integrity is declared out of scope.

## Verifying that the real home was not touched

Three independent checks:

```sh
# 1) every migration artifact in the real library must predate the rehearsal
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort | tail -3
# 2) no shadow directory is left behind (unless --keep or --shadow-dir was used)
ls -d "${TMPDIR:-/tmp}"/dsh-rehearsal-home-* 2>/dev/null | wc -l
# 3) the report contains neither a home path nor message bodies; replace <TOKENS> with the reader's own username and drive keywords
node -e "const fs=require('fs');const d=fs.readdirSync('.dsh-rehearsal').sort().pop();\
const t=fs.readFileSync('.dsh-rehearsal/'+d+'/report.json','utf8');\
console.log(['<TOKENS>','reasoning:'].filter(k=>t.includes(k)).length?'LEAK':'CLEAN')"
```

The tokens in check 3 are filled in by the reader on purpose: a documented grep that hard-codes the keywords would match the document itself.

## Reporting

Open a [private security advisory](https://github.com/wuwaka/dsh-rehearsal/security/advisories/new) with the candidate `dsh` version, OS, Node version, and tool version (`dsh-rehearsal --version`).
