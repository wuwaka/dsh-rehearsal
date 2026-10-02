# Security policy

Short version: this tool is **not a security boundary**, and it can be made to
do real things to your machine if you ask it to. Read the two red lines below
before reporting anything as a vulnerability — most "issues" with this tool are
correct behaviour that was not explained well, and those belong in a normal
issue.

## What this tool actually guarantees

Each of these is enforced in code and covered by a test, so a report that one of
them is broken is a genuine vulnerability report:

| Guarantee | Where |
|---|---|
| The rehearsal never installs into your live profile; the candidate goes into a private npm prefix with `DSH_HOME` pointed elsewhere | `src/lib/shadow.js` `installCandidate` |
| Copies of your sessions get their recorded `cwd` rewritten into the shadow, **and** are relocated to the matching encoded workspace directory | `src/lib/sessions.js` `copySet` |
| No credential-shaped environment variable reaches a child process; only the stripped **names** are recorded (`redactedEnvNames`) | `src/lib/util.js:56-75` |
| Telemetry is force-disabled (`DSH_TELEMETRY_MODE=DISABLED`) | `src/lib/util.js:75` |
| Reports contain no message bodies and no user paths: `stderr` is filtered to diagnostic lines, evidence objects are redacted per string, and `finalize()` scrubs every stage, the coverage block, the target and the warnings | `src/lib/report.js:136` — and a test greps the finished report for home paths and reasoning markers |
| Tool providers are suppressed by row id **and** package-name prefix by default; a session is only drilled when every tool in its own history is on the read-only allowlist (fail-closed) | `src/lib/shadow.js`, `src/lib/drill.js` |
| The shadow home — which holds plaintext session copies — is deleted on every exit path, and the outcome is recorded as `shadowCleanup` | `src/commands/run.js` |

## Two red lines that are the operator's responsibility

1. **`--allow-tools` really executes the tool calls recorded in your session
   history.** The sandboxed `cwd` still applies, but `pwsh` / `bash` / any
   absolute path can leave it. This flag exists because refusing to ever run a
   tool would make the write round meaningless; it is opt-in and prints a
   banner.
2. **`--keep` leaves plaintext copies of your sessions on disk** in the shadow
   home and the install prefix, for debugging. Do not use it on a machine you do
   not control, and clean up afterwards (`dsh-rehearsal clean --yes`).

Related, but a scope limit rather than a risk: candidate installs default to
`--ignore-scripts`, matching what the official pnpm setup whitelists.
`--run-scripts` executes third-party lifecycle scripts.

## What is explicitly *not* in scope

- **Not a sandbox against a hostile candidate `dsh`.** You are running a build of
  the harness you are considering upgrading to. If that build is malicious, this
  tool's file-level precautions do not save you.
- **Not a defence against your own plugins.** A rehearsal loads your pinned
  plugin set; a plugin that exfiltrates data does so during the rehearsal too.
- **Attachment side-data is neither copied nor verified** (`~/.dsh/attachments`,
  `cache/attachments`), so attachment-reference integrity is out of scope and is
  stated as such rather than silently assumed.
- Scrubbing is a **filter**, not a proof. If you find real message content or a
  real user path in a report, that is a bug worth reporting — but treat any
  report file as sensitive anyway.

## Reporting

Use a [private security advisory](https://github.com/wuwaka/dsh-rehearsal/security/advisories/new).
Include the `dsh` candidate version, OS, Node version, and the tool version
(`dsh-rehearsal --version`).

Please **do not paste report files or `run` output into a public issue** —
scrubbing is best-effort, and those files are derived from your own session
history. `report.json` / `report.md` are yours; nothing is uploaded anywhere by
this tool.
