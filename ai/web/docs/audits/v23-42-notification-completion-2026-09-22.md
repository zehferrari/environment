# V23-42 notification and completion audit

V23-42 (`cmuaiytpl4f9kovulwaauilm8`, PDF Export margins) completed on
22 September 2026 at 14:49:31 Brisbane, approximately nine seconds after
the owner accepted its review. Every finalization step succeeded on its
first attempt. The three `task.workflow.effect_failed` entries were older:
21 September at 12:47, 13:08 and 13:24. Two review notifications and one
blocker notification targeted the active human user `zeh`.

## Causes

- The outbox used an agent-only sender for human recipients. That sender's
  intentional `null` return became a delivery error and was retried eight times.
- Conversely, an object containing `delivery.ok=false` was treated as success.
- The completion command and the `notify_completion` procedure step each
  emitted a completion notification with different deduplication keys.
- Done did not atomically settle the execution-state projection. V23-42 still
  reported `waiting_review` despite a successful Done transition.
- Epic queue selection ran before writing Done, excluding tasks whose
  prerequisite was the task being completed (the WDT-13 → WDT-14 case).

## Changes

The outbox now routes active, authorized humans to a deduplicated PM activity
and optional best-effort Web Push, without creating an agent turn. Missing
push configuration/subscriptions do not fail durable PM notification delivery.
Agent notifications retain the existing transport and explicitly classify
delivered, skipped, retryable and permanent outcomes. Inactive/missing or
unauthorized recipients fail once; transient transport/server failures retry.
The channel job queue continues to own failures after an asynchronous dispatch
has been accepted.

The finalization command owns completion notifications. The versioned
`notify_completion` procedure step remains compatible but emits no second wake.
Done, execution-state cleanup and supersession of obsolete notification effects
share the transition transaction. Epic queue selection observes Done within
the same completion transaction before choosing the next task in rank order.

Obsolete queued/failed notifications are marked `superseded`, not replayed.
Original failure details and timestamps remain; the activity payload gains
resolution metadata and Activities renders “Historical — superseded”. Genuine
current delivery errors remain visible. In-flight dispatch leases are not
rewritten by the repair; delivery rechecks task stage before sending.

## Verification and scoped repair

`pnpm test:workflow-notifications` uses a migrated temporary SQLite database,
fake agent profiles and queued-only dispatch. It covers human and agent review
recipients, lost-settlement replay, inactive recipients, delivery outcome
classification, obsolete notifications, Done cleanup, duplicate transitions,
preserved historical errors and newly unblocked Epic task selection. The
review-decision suite also asserts one completion notification across the
command and procedure paths.

For an already completed task, inspect first, then apply with a database backup:

```sh
DATABASE_URL=file:/path/to/database.db node --import tsx scripts/reconcile-completed-task-notifications.ts TASK_ID
DATABASE_URL=file:/path/to/database.db node --import tsx scripts/reconcile-completed-task-notifications.ts TASK_ID --apply
```

The repair refuses non-Done tasks. It only supersedes obsolete notification
effects, annotates their historical failures and settles the execution strip.
It does not dispatch messages, rerun repository work or change review evidence.
This change does not alter episode tool-call budgets or grant real-device access.
