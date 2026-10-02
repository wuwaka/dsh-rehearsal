[简体中文](SECURITY.md) | [English](SECURITY.en.md)

# Security policy

This tool is not a security boundary. Two flags perform real actions on the host when
explicitly enabled; they are listed under [Operator-owned risk](#operator-owned-risk).
A report describing one of those behaviours as a vulnerability belongs in a normal issue.

## Guarantees enforced in code

Each row below is implemented and covered by a test, so a report that one of them is
broken is a vulnerability report:

| Guarantee | Where |
|---|---|
| The rehearsal never installs into a live profile; the candidate goes into a private npm prefix with `DSH_HOME` pointed elsewhere | `src/lib/shadow.js` `installCandidate` |
| Copies of sessions get their recorded `cwd` rewritten into the shadow, and are relocated to the matching encoded workspace directory | `src/lib/sessions.js` `copySet` |
| No credential-shaped environment variable reaches a child process; only the stripped names are recorded (`redactedEnvNames`) | `src/lib/util.js:56-75` |
| Telemetry is force-disabled (`DSH_TELEMETRY_MODE=DISABLED`) | `src/lib/util.js:75` |
| Reports contain no message bodies and no user paths: `stderr` is filtered to diagnostic lines, evidence objects are redacted per string, and `finalize()` scrubs every stage, the coverage block, the target and the warnings | `src/lib/report.js:136`, plus a test that greps the finished report for home paths and reasoning markers |
| Tool providers are suppressed by row id and by package-name prefix by default; a session is drilled only when every tool in its own history is on the read-only allowlist (fail-closed) | `src/lib/shadow.js`, `src/lib/drill.js` |
| The shadow home, which holds plaintext session copies, is deleted on every exit path, and the outcome is recorded as `shadowCleanup` | `src/commands/run.js` |

## Operator-owned risk

1. `--allow-tools` executes the tool calls recorded in session history. The sandboxed
   `cwd` still applies, but `pwsh`, `bash` or any absolute path can leave that directory.
   The flag exists because suppressing every tool would make the write round vacuous; it
   is opt-in and prints a banner before running.
2. `--keep` leaves plaintext copies of sessions in the shadow home and the install prefix
   for debugging. It should not be used on an unmanaged machine, and the output should be
   removed afterwards (`dsh-rehearsal clean --yes`).

Related, but a scope limit rather than a risk: candidate installs default to
`--ignore-scripts`, matching the short build-script list the official pnpm setup
whitelists. `--run-scripts` executes third-party lifecycle scripts.

## Out of scope

- Not a sandbox against a hostile candidate `dsh`. A rehearsal runs a build of the harness
  under evaluation; file-level precautions do not apply to a malicious build.
- Not a defence against installed plugins. A rehearsal loads the pinned plugin set, so a
  plugin that exfiltrates data does so during the rehearsal as well.
- Attachment side data (`~/.dsh/attachments`, `cache/attachments`) is neither copied nor
  verified; attachment-reference integrity is declared out of scope rather than assumed
  covered.
- Scrubbing is a filter, not a proof. Real message content or a real user path appearing in
  a report is a defect worth reporting, and report files should be treated as sensitive
  regardless.

## Reporting

Use a [private security advisory](https://github.com/wuwaka/dsh-rehearsal/security/advisories/new).
Include the candidate `dsh` version, OS, Node version, and the tool version
(`dsh-rehearsal --version`).

Report files and `run` output should not be pasted into a public issue: scrubbing is
best-effort, and those files derive from local session history. `report.json` and
`report.md` stay on disk; this tool uploads nothing.
