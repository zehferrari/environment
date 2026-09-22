# WDT-10 approval routing and configuration recovery

Epic: `cmuawrarfubg6ovulqyvywf3x` (September Customers Feedback).
Audited against `e639f1c0`, then corrected on `main`.

## Evidence

- The Epic approval targeted Barekbaal, but generic chat mention expansion
  also dispatched Asdrubal and Carmen from the assignment summary.
- WDT-13 submitted eight times with the same missing effective PM Git identity.
  Local `git config` could not fix the PM job's missing identity fields.
  Project settings were subsequently repaired, but the formal blocker remained.
- WDT-11's approved baseline inspection stopped at the managed browser's
  private-target policy. Its manager notification exhausted its claim attempts.
  This is a separate dependency; a Git-settings repair must not clear it.
- Reporter-only Action Plan approval is configured for this project. The
  manager was correct to seek owner approval. Existing explicit plan acceptance,
  delegation and terminal-action protections remain authoritative.

## Corrected behavior

Epic approval uses the directed Epic workflow notifier. Mentioned workers are
context only; their assignment notifications remain owned by queue refill.

Worktree preparation, implementation start and review submission require a
complete effective Git identity (project → primary active workspace → system).
Missing values return `git_identity_incomplete` with the exact PM field names
and instruction to stop repeating builds/submissions. Submission rejection
occurs before execution freeze or verifier-job creation. A procedure rechecks
settings before enqueueing validation to cover settings changes after admission.
Task notifications and repository preparation use the same inheritance chain.

An evidence-backed report of this exact PM configuration failure is accepted
without artificial retry rounds. Other technical failures retain the existing
bounded diagnostic rules.

The watchdog rechecks identified Git-identity blockers, including old reports
with the original error text. Once effective settings are complete, it enqueues
one durable notification per blocker comment and assignee. The worker verifies
current state, clears the blocker through the workflow and resumes its existing
checkpoint. This polling catches repairs at every settings level and survives
process restarts; it does not require a second settings save. Unrelated browser,
permission and human-override blockers are excluded. It does not clear blockers
or mark work complete automatically.

The procedure runner separately resumes only a typed configuration-failed
preparation/validation step once its identity is repaired. It checks task status,
cycle identity, newer procedures and unrelated blockers inside a transaction.
Completed procedure steps are retained. Stale cycles are never restarted.

## Validation

`wdt-configuration-recovery-test.ts` uses an isolated migrated database to check
repeated start/submission refusal with no jobs, inheritance, partial settings,
one recovery notification, unrelated blockers, stale cycles and manager-only
Epic dispatch despite worker mentions. Existing planning, formal-blocker and
workflow-boundary checks cover interaction with the current workflow engine.
No schema migration or PM plugin upgrade is needed.

## Operations

Deploy via `sudo -u karen /usr/local/sbin/pm-switch --database=main main`.
Confirm WDT-13's effective identity before waking Carmen. Preserve existing
work and successful validation evidence; submit once after clearing the blocker.

For WDT-11, use OpenClaw's supported browser SSRF host exception for the approved
loopback fixture, not an alternate browser/CDP bypass. An exact `127.0.0.1`
exception is host-scoped (all ports); OpenClaw does not provide a path/port-scoped
host exception. Keep broad private-network access disabled, retain Chromium's
sandbox, and verify navigation through the managed browser before resuming.
Keep the exception in Asdrubal's canonical config so config sync preserves it.
The fixture server may need restarting before the agent repeats the baseline.

Runtime verification found an additional OpenClaw 2026.9.3 limitation: direct
`browser open <http URL>` for a local managed profile does not select the
Playwright path and refuses strict redirect inspection even when the host is
allowed. The installed Playwright module itself loads correctly. The supported
sequence `browser open about:blank`, then `browser navigate <URL>` invokes
Playwright with the same SSRF policy. This sequence successfully loaded the PM
loopback login page; no runtime patch or policy bypass was used. Supply the
returned target ID on subsequent browser actions. WDT-11's fixture server was
not running at verification time and must be restarted for the actual baseline.

Before deployment, the live DB and both Asdrubal configurations were backed up
under `/var/backups/openclaw/wdt-10-recovery-20260922T035549Z/`. Asdrubal's canonical
config now explicitly allows only `127.0.0.1` as the additional browser host,
with broad private-network access false; host config sync and a gateway restart
applied it. Other agents' browser policies were not changed.
