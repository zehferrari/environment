# PM workflow regression suite (ENV-124)

The PM Workflow Improvement Epic changed how runs settle, how plans become
checklists, how blockers are validated, and how interrupted execution recovers.
This suite is the guard on all of it: twelve named regression cases, each one a
failure mode that actually happened in production, replayed against the real
route handlers and the real production writers.

## Running it

```bash
cd ai/web
pnpm test:workflow-regression            # all five groups, concurrently
pnpm test:workflow-regression --serial   # one at a time, live output
pnpm test:workflow-regression --only=lifecycle,blocker
```

Individual groups also have their own script, which is what you want while
iterating on one of them:

```bash
pnpm test:workflow-regression-lifecycle
pnpm test:workflow-regression-plan-steps
pnpm test:workflow-regression-blocker
pnpm test:workflow-regression-concurrency
pnpm test:workflow-regression-fixture
```

Exit code 0 means every case passed. A failure names the group and the case id
(`C4`, `C11`, …) so it maps straight back to the list below.

## The twelve cases

| Case | Group | What it proves |
| --- | --- | --- |
| 1 | lifecycle | An agent that starts and returns an empty final response is treated as **interrupted**, not complete. |
| 2 | lifecycle | A process that dies after accepting a run does not leave the run accepted forever. |
| 3 | lifecycle | A process that dies after recording start but before queuing the continuation still recovers. |
| 4 | lifecycle | A context-compaction failure produces exactly one bounded retry continuation, preserves progress, and escalates instead of looping. |
| 5 | lifecycle | An older accepted run alongside a newer completed run is superseded, not left active. |
| 10 | lifecycle | Execution crossing multiple fresh sessions does not lose progress. |
| 6 | plan-steps | An approved **sequential** plan creates progress checklist entries. |
| 7 | plan-steps | An approved **parallel** plan creates delegatable subtasks, distinct from checklist entries. |
| 8 | blocker | A browser failure is diagnosed and retried inside the episode budget instead of immediately becoming a formal blocker. |
| 9 | blocker | A permission grant clears the blocker and resumes execution exactly once. |
| 11 | concurrency | Duplicate callbacks create no duplicate runs and no duplicate subtasks. |
| 12 | concurrency | Two monitor/watchdog workers racing a recovery converge on one repair. |

The fixture group replays the Patricia E6 outage drill (see below) and asserts
the post-Epic behaviour for that exact event sequence.

## How the harness works

`scripts/lib/workflow-scenario-harness.ts` provides the shared spine and
nothing else — every behavioural assertion lives in a scenario file, so a change
in what PM *should* do never has to be made in the harness.

Three conventions are load-bearing:

1. **`DATABASE_URL` is repointed at a throwaway database before any `@/lib`
   import.** `@/lib/db` reads it at module-eval time, so a static top-level
   import in a scenario file would bind the live `pm.db`. Everything the harness
   returns comes through `await import(...)` after the sandbox exists.
2. **`prisma migrate deploy`, not `db push`.** The run lifecycle depends on
   partial unique indexes that only exist in raw-SQL migrations. A pushed schema
   silently drops them, and the supersede and idempotency cases would then pass
   against a database production does not have.
3. **The real route is imported, not re-implemented.** `makeWorkflowPoster`
   POSTs to `/api/agent/tasks/[taskId]/workflow` in-process with a genuinely
   signed token, so auth, the rollover barrier, every action branch and the
   response decorator all run. A scenario that bypassed the route would prove
   nothing about what an agent actually receives.

On determinism: the harness seeds ids and row timestamps but does **not** stub
the global clock. Production code calls `new Date()` inside the transactions
under test, and replacing it would mean asserting against a fiction. What is
made deterministic is everything the test controls.

Groups run as separate child processes. That is required, not an optimisation —
two groups in one process would share whichever database was imported first.

## The permanent fixture

`scripts/fixtures/patricia-e6-outage-drill.json` is the committed event sequence
from the Patricia task *"9. Outage drill: prove the fail-soft contract (E6)"*.
Committing it is the point: the regression survives with no database access, on
any host, after the source rows are archived.

`scripts/export-pm-event-fixture.ts` regenerates it. It is read-only, it works
from a **copy** of the database rather than the live file, it redacts tokens,
secrets and PII, and it emits deterministic JSON (stable key order, stable row
order, normalised timestamps) so re-running it produces a byte-identical file.
The replay suite asserts the fixture's own row counts, so a truncated or
corrupted fixture fails loudly instead of silently replaying nothing.

### Redaction

Three axes, because a secret can arrive three ways:

1. **By field name** — `token`, `secret`, `passw`, `email`, `…Key` and friends
   are replaced wholesale, including keys nested inside embedded JSON payloads.
   A short allowlist (`sessionKey`, `targetKey`, `base_sha`, …) exempts routing
   identifiers the replay genuinely needs; allowlisted fields still go through
   every value-shape rule, so the allowlist can never become a leak channel.
2. **By value shape** — JWTs, bearer headers, vendor-prefixed API keys, email
   addresses, and (outside the allowlist) high-entropy blobs.
3. **By free text** — credentials a human typed into a comment. This axis was
   added after the first export shipped a plaintext password: PM's richest
   columns are `body`/`payload` prose, where a secret is disclosed in a sentence
   and no field name marks it. It covers quoted disclosures (`reset the password
   to "…"`), bare assignments (`cvv: …`, `api_key=…`), payment card numbers
   (Luhn **and** a real issuer prefix, or any card-labelled digit run), gateway
   payment identifiers (`merchantId`, `receipt`, `transactionId`) and long bare
   digit runs that are not plausible epoch timestamps.

The free-text rules are deliberately anchored — a credential noun, a short
connector, then the value — rather than "redact anything near the word
password". This history is three weeks of humans discussing a login failure, so
`password` appears 68 times in sentences that disclose nothing; an over-broad
rule would quietly gut the fixture's evidentiary value instead of failing.

E1 proves both directions. It sweeps the parsed leaves (not just the raw bytes —
in the committed JSON the disclosure reads `password to \"…\"`, and the
backslash defeats any regex anchored on a quote), asserts the redactor's rules
directly against a table of synthetic disclosures, **and** asserts that prose
merely discussing a password, along with the identifiers replay depends on,
survives untouched. The one literal we know a human disclosed is pinned by
SHA-256 digest over every fixture token — writing the plaintext into the test to
prove the plaintext is absent from the fixture would be self-defeating.

## Findings

Building these scenarios surfaced six gaps in production. The first three and
the fifth were closed by later Epic items; the fourth is a real race that is
fixed in this branch; the sixth is by-design and pinned in place by an
assertion plus a `// FINDING:` comment, so the day someone changes it the
assertion fails loudly and the change gets recorded rather than drifting in
unnoticed.

### 1. The invariant adapter is blind to two landed fixes — CLOSED

Earlier drafts of this doc reported the adapter could not see the ENV-117
lease columns or the ENV-119 structured plan steps. Both are now wired through:

- `lib/workflow-invariants-db.ts` selects `leaseExpiresAt` and `heartbeatAt`
  and the predicate's `runLeaseExpired` honours `leaseExpiresAt` directly,
  falling back to the derived TTL only on pre-ENV-117 rows. The canonical
  scenario's T2 seeds such a legacy row (no lease columns set), so WFI-002 and
  WFI-003 still genuinely fire there — that is correct behaviour, not blindness.
- `planStepSource` is classified as `"structured"` when an approved
  `ActionPlan` with steps exists (`workflow-invariants-db.ts`), so WFI-008 was
  removed from `lib/workflow-invariants-baseline.json`. The db test asserts
  `planStepSource: "structured"` for T1.

### 2. WFI-005 fires again: the retry ladder writes no disposition — CLOSED

Earlier drafts reported the turn-failure retry ladder writing
`disposition: null` on a terminal run. Both branches now stamp an explicit
disposition:

- `retryOrFailPmChannelJobForTurnFailure` writes `disposition: "continue"` on
  the retry-eligible branch (run stays `queued`, job stays `retryable`) and
  `disposition: "failed"` on the exhausted branch. C1 asserts both: WFI-005
  stays silent on the retry path and the terminal write carries `"failed"`.
- `requeueStaleClaimedPmChannelJobs` writes `disposition: "continue"` on the
  non-exhausted branch and `"failed"` on exhaustion.

### 3. `add_subtask` is not idempotent under duplicate delivery — CLOSED

`createSubTaskItem` deduplicates via a `findFirst` lookup (by
`actionPlanStepId` when present, else by `(taskId, kind, text)`) and the schema
enforces `@@unique([taskId, kind, text])` on `SubTask`. C11 asserts three
identical callbacks converge on one run, one continuation, and one checklist
row, and that a second outbox row is rejected by the unique constraint.

### 4. The watchdog recovery budget is read-then-write with no guard — FIXED

`consumeRecoveryBudget` was a read-then-upsert with no conditional update and no
unique key, so two racing passes that both read the pre-repair count could each
claim the same unit. SQLite serialises the statements so a single charge was
observed, but the bound only held on that engine. C12 asserted the guaranteed
range (`1 <= recoveryCount <= passes`) rather than a precise count.

This branch replaces the read-then-upsert with a conditional update guarded by
the current `recoveryCount` (or the window-reset sentinel), so the count
advances atomically: a racing pass that read the same pre-value is rejected by
the `where` clause and retries against the new state. C12 now asserts the
precise count (`recoveryCount === passes.length`).

### 5. Delegation is keyed off `assigneeId`, not step kind — CLOSED

Earlier drafts reported `createChecklistAndDelegatableTasksFromPlan` branching
on `step.assigneeId`. It now branches on `step.kind === "parallel"`:

- a `parallel` step creates an unassigned child `Task` when no delegate is
  named (`assigneeId: step.assigneeId ?? null`), and a child carrying the
  delegate when one is;
- a `sequential` step never becomes a child task regardless of assignee.

So the trigger is the plan's own declared shape, not the presence of an
assignee.

### 6. A downgraded blocker spends no episode budget — pinned, by-design

The `incident` path returns 422 before `recordPmChannelRunWorkflowAction`, so an
agent can call `flag_blocker` repeatedly within one turn without advancing the
cycle counter. The tool budget bounds any agent that actually retries the
browser between attempts, but a turn that spams `flag_blocker` with no tool
calls in between is bounded by nothing on the workflow-action side. Arguably
correct — a refused escalation is not progress — but it is unbounded, so it is
pinned in case C8.
