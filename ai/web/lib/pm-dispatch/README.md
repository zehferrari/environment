# `lib/pm-dispatch`

PM event dispatch boundary (HOMELAB-46 Slices 1–3).

The webapp's task mutation routes / server actions call
`notifyDispatch(event)` after a workflow rule + persistence step has
accepted the change. Dispatch never affects rule outcomes — a failed
send returns `{ ok: false }` and is logged; the persisted state
stands. `notifyDispatch` is the only call-site entry point and is
guaranteed not to throw: transport, config, and disabled-env paths
all resolve to a `DispatchResult` with `ok=false`.

## Wired call sites (Slice 2)

- `app/api/tasks/[id]/ack/route.ts` — emits `task.ack_ready` after the
  auto To Do → In Progress transition is persisted.
- `app/(app)/projects/[slug]/tasks/[taskId]/page.tsx`
  - `createComment` — emits `task.commented` for the comment plus one
    `task.mentioned` per resolved `@username` in the body.
  - `assignTask` — emits `task.assigned` with the previous and new
    assignee shape after the row is updated.

HOMELAB-44 enforcement (`checkAssignment`, `checkStatusTransition`,
`autoTransitionOnAck`) is unchanged: rule rejections still run before
the DB write, dispatch only runs on the post-persist path.

## Drivers

| Driver           | Selected via                                | Notes                                      |
|------------------|---------------------------------------------|--------------------------------------------|
| `unix-socket`    | `PM_DISPATCH_DRIVER=unix-socket` (default)  | NDJSON over AF_UNIX; primary per HOMELAB-45 |
| `file-drop`      | `PM_DISPATCH_DRIVER=file-drop`              | One JSON file per event, atomic rename     |
| `http-localhost` | constructed directly only — **not** env-selectable | Setting `PM_DISPATCH_DRIVER=http-localhost` throws. Callers/tests must build it via `createHttpLocalhostDriver({ url })`. |

## Required env

- `PM_DISPATCH_SOCKET` — absolute path of the AF_UNIX socket (unix-socket driver).
- `PM_DISPATCH_DROP_DIR` — directory for the file-drop fallback.
- `PM_DISPATCH_HTTP_URL` — *not* read by `readDispatcherConfig`; only honoured if a caller passes it explicitly into `createHttpLocalhostDriver({ url })`.

If **neither** `PM_DISPATCH_SOCKET` nor `PM_DISPATCH_DROP_DIR` is set,
`notifyDispatch` short-circuits to a disabled state: it logs once and
returns `{ ok: false, skipped: "disabled" }`. This is the local-dev
and unit-test default and keeps the workflow path noise-free.

## Prerequisite for live agent wake

The `unix-socket` driver needs **an OpenClaw-side AF_UNIX listener**
bound to `PM_DISPATCH_SOCKET` before any agent ack-seam wiring can be
turned on. That listener is **not** in this repo and is **not**
delivered by HOMELAB-46 Slice 1 — it is the OpenClaw runtime work that
follows Slice 1. Until that lands:

- the dispatcher is safe to enable in non-prod environments using the
  `file-drop` driver, with the harness in
  `scripts/pm-dispatch-receiver.ts` standing in for the consumer;
- call sites are wired through the seam but no live agent is woken;
- failed sends are logged and surfaced via `DispatchResult.ok=false`
  so observability is in place from day one.

Surface this prereq to zeh as a follow-up before any agent-wake roll-out.

## Smoke harness

```bash
pnpm tsx scripts/pm-dispatch-receiver.ts filedrop
pnpm tsx scripts/pm-dispatch-receiver.ts socket
pnpm tsx scripts/pm-dispatch-receiver.ts notifier
pnpm tsx scripts/pm-dispatch-receiver.ts all
```

`filedrop` and `socket` exercise the driver round-trip. `notifier`
asserts the Slice 2 facade contract: `notifyDispatch` returns
`ok=false` + `skipped="disabled"` when no env is set, and round-trips
through the file-drop driver when `PM_DISPATCH_DROP_DIR` is set.

## Integration smoke (Slice 3)

```bash
pnpm tsx scripts/pm-dispatch-integration.ts
```

End-to-end smoke against a throwaway sqlite (`prisma db push` into a
temp `DATABASE_URL`) plus a temp `PM_DISPATCH_DROP_DIR`. Seeds a
project + human actor + agent assignee + task, mirrors the
`assignTask` server-action persistence + dispatch shape, then reads
the dropped envelope and asserts envelope identity (`task.id`,
`task.key`, `task.projectKey`, actor, payload assignee). `task.key`
is asserted to equal `task.id` — that is the current contract flagged
in HOMELAB-46 commentId 12265, and this assertion will fail loudly if
that ever drifts before a PM-visible key is introduced for live wake.
