# In Progress execution handoff audit — 22 September 2026

At 18:25 AEST, WDT-17 was executing but native evidence uploads repeatedly
failed the OpenClaw media-root policy. V23-43 was waiting while Barekbaal
reviewed WDT-11, although its task strip claimed execution. Both tasks had
dispatched checkpoint and rollover continuations for the same source run,
causing successor supersession and rejected callbacks.

## Corrections

- PM channel 0.1.12 passes agent-scoped roots to the public OpenClaw media
  loader. Previously `cfg` was passed to an option builder that does not infer
  workspace access. Evidence in the configured workspace is allowed; unrelated
  files and symlink escapes remain rejected. Failed uploads explain staging.
- The rollover seal retires earlier armed/queued action continuations. An
  atomic per-source-run claim coalesces remaining siblings, and dispatch uses a
  stable source-run deduplication key. All active lifecycle states protect an
  existing successor, including `waiting_capacity` and `admitted`.
- Native checkpoint steering retains the corrected public SDK export. CLI
  subprocesses use proactive checkpoint instructions and authenticated PM
  context/workflow response guidance instead of claiming embedded injection.
  Acknowledgements distinguish live queued delivery from HTTP-response mode.
- Capacity waits render separately and identify the occupying task. Delivery
  without admission is described as queued for admission.

## Verification

`scripts/pm-task-media-test.mjs` exercises the installed public SDK with an
actual workspace file, unrelated file and escaping symlink, then invokes the
native attachment tool through a simulated upload endpoint and a canceled turn.
`scripts/pm-continuation-coalescing-test.ts` uses an isolated migrated SQLite
database for concurrent claims, retries, late siblings, all active competing-run
states and task/message-scoped checkpoint guidance. Existing episode, native
tool, compact-runtime, watchdog and TypeScript checks cover integration.

## Operational boundaries

WDT-17 reached Done during implementation of this repair. Its accepted result
is preserved; no test upload or new execution turn is created on the completed
task. Its historical failed uploads are not rewritten as successful evidence.

V23-43 subsequently raised a different, concrete Dev checkout dependency:
the deployed UpdateSession Lambda reportedly requires `invoiceId`, while the
branch client sends `sessionId` and `amount`. It requests new publication and
Dev Lambda deployment authorization. This PM repair does not authorize that
deployment, change the payment contract, or clear the blocker. Its checkpoint
also records a temporary zero-surcharge fixture requiring restoration; verify
cleanup as part of that task's Dev testing.
