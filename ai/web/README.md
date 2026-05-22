# ai/web — PM workspace

Single-host Next.js project manager for the OpenClaw agent fleet. Started as
the Stage 1 walking skeleton for
[HOMELAB-43](https://zeh-ferrari.atlassian.net/browse/HOMELAB-43); current
state is post-Stage-2 with the HOMELAB-46 dispatch seam wired, the
HOMELAB-52 agent control surface mounted on `/agents`, the HOMELAB-47
work item editor (Epic CRUD, attachments, principal pool, redesigned task
detail), and HOMELAB-48 on top of it (soft-delete + 7-day bin, taller
description editors, per-task/epic agent chat sidebar with one-shot
description-write grants).

Served by a long-lived Node process at `agents.vixi.au` — see
[deploy/README.md](./deploy/README.md). The legacy static `agents.html`
mission-control page (HOMELAB-42) sat next to this README until HOMELAB-52
folded it into the live `/agents` deck.

## Stack

Next.js 15 App Router · React 19 · Tailwind v4 · Prisma 6 / SQLite ·
NextAuth v5 (Credentials + argon2id) · `@dnd-kit` for the board ·
TypeScript strict, ESM-only.

## Local dev

```bash
pnpm install
cp .env.example .env
# edit DATABASE_URL / AUTH_SECRET as needed
pnpm prisma migrate dev   # applies committed migrations, regenerates client
pnpm dev
```

The Next.js app boots → `instrumentation.node.ts` seeds the `zeh` user
and runs the first agent sync against `$AGENT_INDEX_PATH` (default
`/srv/agents/index.json`). On a dev box where that file is absent, the
boot sync logs an error and continues — log in as `zeh` / `password1`
and rotate the password, then visit `/agents` to see the (empty) table.

Other useful scripts:

```bash
pnpm typecheck                                  # tsc --noEmit
pnpm lint                                       # next lint
pnpm sync:agents                                # one-shot agent sync
pnpm tsx scripts/seed.ts                        # idempotent dev seed
pnpm tsx scripts/pm-dispatch-receiver.ts all    # dispatch seam smoke
pnpm tsx scripts/pm-dispatch-integration.ts     # Slice 3 end-to-end smoke
pnpm tsx scripts/pm-consumer-replay-test.ts     # Slice 4 dedupe acceptance
pnpm tsx scripts/smoke-model-save.ts            # HOMELAB-52 model-save check
```

## Routes

| Route | Purpose |
| --- | --- |
| `app/login`, `app/rotate-password` | unauthenticated routes (forced rotation on first login). |
| `app/(app)/projects` | projects list. |
| `app/(app)/projects/[slug]` | kanban board (5 columns, drag + keyboard nav, Backlog toggle); task cards show assignee + `updated` time. |
| `app/(app)/projects/[slug]/tasks/[taskId]` | task editor — two-column. Main: inline title, description editor, sub-tasks, attachments, comments. Sidebar: status, assignee, reviewer, epic picker, parent, dates. |
| `app/(app)/projects/[slug]/epics` | epic list with status filter (open/done/archived) + inline create (title + description + Acting Manager picker, then redirects into detail for attachments). |
| `app/(app)/projects/[slug]/epics/[epicId]` | epic detail — assignee + acting manager (Epic keeps that label), status, attachments, tasks grouped by their own status, chat sidebar, Delete. |
| `app/(app)/projects/[slug]/bin` | soft-delete bin — lists deleted Epics + Tasks with per-row Restore and "Restore + N children" actions. |
| `app/(app)/agents` | agents grid; merges PM DB rows with Atlas live snapshot. |
| `app/(app)/agents/[agent]` | per-agent deck — Atlas controls, profile editor, model settings. |
| `app/(app)/system/activity` | system-wide ActivityLog stream. |
| `app/api/auth/[...nextauth]` | NextAuth route. |
| `app/api/debug/sync` | manual trigger for the agent sync (auth-only). |
| `app/api/tasks/[id]/ack` | agent ack endpoint — auto To Do → In Progress, emits `task.ack_ready`. |
| `app/api/tasks/[id]/description` | agent description write-back. One-shot grant validated against the `allowDescriptionEdit` chat message. |
| `app/api/epics/[id]/description` | agent description write-back for Epics. Same one-shot model. |
| `app/api/attachments/[id]` | streamed attachment download (auth-gated). |
| `app/api/agents/[agentId]/profile/...` | per-agent profile read/write (HOMELAB-52). |
| `app/api/agents/[agentId]/models` | model settings read/write. |
| `app/api/agents/[agentId]/services/{toggle,restart}` | Atlas service controls. |
| `app/api/agents/[agentId]/registry/toggle` | activate/deactivate registry entry. |
| `app/api/agents/[agentId]/integrations/credentials` | per-agent credential surface. |
| `app/agents/avatars/[name]` | avatar proxy. |

## Library layout

| Path | Purpose |
| --- | --- |
| `lib/auth.ts`, `lib/auth-handlers.ts` | NextAuth credentials + JWT callbacks. |
| `lib/auth/password.ts` | argon2id hashing helpers. |
| `lib/auth/rate-limit.ts` | in-process login rate limit (per-IP + per-username). |
| `lib/agents/sync.ts` | the canonical agent sync — boot + periodic interval. |
| `lib/agents/index-loader.ts` | `/srv/agents/index.json` reader. |
| `lib/agents/credentials.ts` | per-agent host-private credential seeding. |
| `lib/agents/profile.ts` | shared agent profile read/write + ACL. |
| `lib/agents/model-settings.ts` | shared model-config store (HOMELAB-52). |
| `lib/agents/restart.ts` | systemd restart fan-out via Atlas gateway. |
| `lib/agents/seed-zeh.ts` | idempotent seeder for the `zeh` human user. |
| `lib/workflow.ts` | HOMELAB-44 rule library (transition / assignment / hierarchy / acting-manager). |
| `lib/principals.ts` | assignable-principal resolver — active humans + agents with `Agent.role='coding'`. Used by every Task/Epic picker. |
| `lib/agents/chat-targets.ts` | broader chat-only resolver — all active agents regardless of role (includes monitors). |
| `lib/agents/chat-actions.ts` | `sendAgentChatMessage` — persists the message, fires dispatch for task-scoped chats. |
| `lib/bin/actions.ts` | soft-delete + restore server actions for Task and Epic with cascade. |
| `lib/bin/purge.ts` | hourly hard-delete job for rows past the 7-day TTL; reclaims orphaned attachment blobs. |
| `lib/epics/actions.ts` | Epic CRUD server actions (create/rename/assign/acting-manager/status). |
| `lib/attachments/storage.ts` | filesystem write/read/delete under `/srv/Data/projects/<id>/attachments/<sha256>` (dev fallback `./.data/attachments`). |
| `lib/attachments/actions.ts` | upload/delete server actions; enforces XOR(taskId, epicId) target. |
| `components/agent-chat.tsx` | shared chat sidebar mounted on Task + Epic editors. |
| `lib/activity.ts` | ActivityLog write helpers. |
| `lib/markdown.tsx` | server-side markdown renderer with safe-href allowlist + @mention resolver. |
| `lib/pm-events/` | shared `PmEvent` envelope (schema v1). |
| `lib/pm-dispatch/` | emitter side of the HOMELAB-46 dispatch seam — see [its README](./lib/pm-dispatch/README.md). |
| `lib/pm-consumer/` | consumer / dispatcher (OpenClaw-side service) — see [its README](./lib/pm-consumer/README.md). |
| `lib/db.ts` | Prisma singleton. |
| `instrumentation.node.ts` | boot hook (Node runtime only); runs seed + first sync, schedules periodic sync. |
| `middleware.ts` | auth gate + `mustRotatePassword` redirect + forwarded-host handling. |
| `prisma/schema.prisma` | full schema (Stage 1 + Stage 2 + HOMELAB-46 delivery log). |
| `prisma/migrations/` | committed migration history; applied via `prisma migrate deploy`. |
| `deploy/` | systemd unit, nginx vhost, env file template. |

## Capability map

**Auth & identity.** Password-only (Credentials provider + argon2id). No
Google SSO in v1 — deferred to v1.1+. Seeded `zeh` plus one agent user
per `codeOwner`-matched entry in `/srv/agents/index.json`. Login rate
limit is in-process sliding-fixed-window: 10/5min per IP + 5/5min per
username. Forced password rotation on first login is enforced by
`middleware.ts`. Behind nginx the middleware uses `x-forwarded-host` to
keep the secure cookie + redirect host correct.

**Projects + board (Stage 2 / HOMELAB-44).** Five verbatim status
columns — Backlog · To Do · In Progress · Review · Done. Drag-and-drop
(`@dnd-kit`) plus J/K/H/L/Enter/Esc keyboard navigation with a
selection ring; hotkeys back off inside text inputs and interactive
controls. Backlog column has a per-project localStorage show/hide
toggle (hidden by default). Server-side enforcement lives in
`lib/workflow.ts`: `checkStatusTransition`, `checkAssignment`,
`checkHierarchy`, `checkActingManager`. Agents are blocked from
transitioning out of Review or Done. Client rolls back optimistic
moves on rejection.

**Tasks (HOMELAB-44 + HOMELAB-47).** Self-referential `Task` model (no
parallel `SubTask`) — a sub-task is a `Task` with `parentTaskId` set.
The editor is two-column: main pane has inline title, markdown
description, sub-tasks, attachments, and comments (`@mention` resolved
through `lib/markdown.tsx`); sidebar has status, assignee, **Reviewer**
(UI label only — the schema column stays `actingManagerId` and the
audit kind stays `task.acting_manager` so the activity feed is
unchanged), epic picker (with "No epic"), parent task link, and a
created/updated dates panel. Tasks may live without an Epic; an Epic
and its tasks can be assigned to different principals and the task
keeps its own kanban status independent of the Epic's
open/done/archived status. All mutations write `ActivityLog`.

**Epics (HOMELAB-47).** `/projects/<slug>/epics` is a status-filtered
list with inline create; `/projects/<slug>/epics/<id>` is the detail
view. Epics have a single human owner field labelled **Acting manager**
(no Reviewer concept at the Epic level), plus an Assignee, status,
description, attachments, and a tasks panel grouped by each task's own
kanban status. Tasks linked into an Epic still drive their workflow
from the project board.

**Attachments (HOMELAB-47).** Files attached to a Task XOR an Epic;
metadata in the `Attachment` table, bytes on disk under
`/srv/Data/projects/<id>/attachments/<sha256>` (dev fallback
`./.data/attachments/<id>/<sha256>`). Content-addressed: re-uploading
the same bytes reuses the existing blob. Size cap is 25 MiB by default,
tunable via `PM_ATTACHMENT_MAX_BYTES`. Downloads go through
`GET /api/attachments/[id]` with the original filename via
`Content-Disposition`.

**Principal pool.** `lib/principals.ts` is the single resolver every
picker calls — active human Users plus Users whose linked `Agent.role`
is `coding` and not deactivated. Non-coding agents and remote-host
agents that aren't seeded as PM users are intentionally excluded.

**Soft delete + bin (HOMELAB-48).** `deleteTask` / `deleteEpic` stamp
`deletedAt` + `deletedById` and cascade to non-deleted children (Epic
→ tasks → sub-tasks; Task → sub-tasks). Every active-view query
filters `deletedAt: null`. `/projects/<slug>/bin` lists everything in
the bin with per-row Restore plus an optional "Restore + N children"
button that restores rows that share the parent's exact `deletedAt`
timestamp (so only children deleted by THIS cascade come back; rows
deleted independently before/after stay in the bin). The hourly
`purgeBin` job in `instrumentation.node.ts` hard-deletes rows past the
TTL (`PM_BIN_TTL_DAYS`, default 7); orphaned attachment blobs are
swept via `lib/attachments/storage.ts`.

**Agent chat (HOMELAB-48).** Task and Epic editors mount a chat
sidebar (`components/agent-chat.tsx`). The agent picker uses
`lib/agents/chat-targets.ts` — broader than the principal pool so
monitors are reachable. Messages persist as `AgentChatMessage` rows
keyed by (taskId|epicId, agentSlug); message bodies render as full
markdown (`lib/markdown.tsx::renderFullMarkdown`). Each compose box
has an "Allow this agent to edit the description" checkbox; ticked,
the message carries a one-shot grant the agent later spends against
`POST /api/{tasks,epics}/[id]/description`. `editGrantUsedAt` makes
the grant single-use — re-submission returns 410. Per-message Delete
hard-removes the row (chats don't go through the bin); an audit row
records who/when. Task-scoped chats fire a `task.agent_chat` dispatch
envelope (routed by `payload.targetAgentSlug`, NOT by task assignee);
epic-scoped chats persist only — PmEvent v1 is task-scoped and an
epic envelope variant is a deliberate follow-up.

**Agents dashboard.** `/agents` merges the PM `Agent` table with the
Atlas live snapshot at `http://127.0.0.1:3013/agents/snapshot` (busy /
idle / model / current ticket / host services). KPI strip shows agents
online, open tickets, open PM tasks, host services, activity stream
size. `/agents/[slug]` mounts the Atlas controls deck (service
toggle/restart, registry toggle), the model settings editor, and the
profile editor. Profile + model writes go through
`lib/agents/profile.ts` / `lib/agents/model-settings.ts`, are
audit-logged on `ActivityLog` with `targetAgent` + `targetFile`, and
trigger a restart via `lib/agents/restart.ts` so live agents pick up
changes.

**PM → agent dispatch seam (HOMELAB-46).** Workflow rules run first; a
post-persist `notifyDispatch(event)` then emits a typed `PmEvent` envelope
(schema v1) over a configurable driver:

| Driver | Selected via | Notes |
| --- | --- | --- |
| `unix-socket` (default) | `PM_DISPATCH_DRIVER=unix-socket` + `PM_DISPATCH_SOCKET` | NDJSON over AF_UNIX, primary per HOMELAB-45. |
| `file-drop` | `PM_DISPATCH_DRIVER=file-drop` + `PM_DISPATCH_DROP_DIR=/var/lib/pm/drop` | one JSON file per envelope, atomic rename. |
| `http-localhost` | constructed directly via `createHttpLocalhostDriver({ url })` — **not** env-selectable | loopback + Bearer; tests / explicit callers only. |

`notifyDispatch` is the only call-site entry point and never throws —
transport/config/disabled paths all resolve to a `DispatchResult` so a
failed send never affects the rule outcome. With no driver env set, it
short-circuits as `{ ok: false, skipped: "disabled" }`. Consumer side
(`lib/pm-consumer/`) runs as a separate `tsx` process on the OpenClaw
host: dedupes by `${kind}:${task.id}:${event.id}` against the
`PmEventDelivery.dedupeKey` unique index, resolves the target agent's
gateway port, and `POST`s `http://127.0.0.1:<port>/hooks/wake` with the
per-agent Bearer. Truncating `PmEventDelivery` is safe — audit rows
live independently on `ActivityLog`.

## Agent runtime contract

For chat-with-edit-grant (HOMELAB-48) to actually move a description,
two halves must agree: this repo emits the envelope; the OpenClaw
agent runtime (separate repo at `ai/openclaw/`) consumes it and calls
back. The contract:

### What PM emits

When the user sends a chat message with the "Allow agent to edit
description" box ticked, PM:

1. Persists an `AgentChatMessage` row with `allowDescriptionEdit=true`.
2. Calls `notifyDispatch` with a `task.agent_chat` envelope. Example:

```json
{
  "schema": 1,
  "id": "01J7ABCDEF...",
  "kind": "task.agent_chat",
  "occurredAt": "2026-05-22T20:30:00.000Z",
  "actor": { "id": "usr_zeh", "kind": "human", "name": "zeh" },
  "task": {
    "id": "tsk_abc123",
    "key": "tsk_abc123",
    "projectKey": "homelab",
    "title": "Rewrite README"
  },
  "payload": {
    "chatMessageId": "msg_xyz789",
    "targetAgentSlug": "asdrubal",
    "userMessage": "USER REQUEST:\nMake this README more concise.\n\nCURRENT DESCRIPTION (verbatim, between the markers):\n<<<CURRENT_DESCRIPTION\n# Old README...\nCURRENT_DESCRIPTION>>>",
    "allowDescriptionEdit": true,
    "currentDescription": "# Old README...",
    "systemPrompt": "You have been authorised to rewrite the description...",
    "replyEndpoint": {
      "method": "POST",
      "path": "/api/tasks/tsk_abc123/description",
      "bodyShape": {
        "messageId": "msg_xyz789",
        "description": "<agent reply text>"
      }
    }
  }
}
```

`lib/pm-consumer/target.ts` routes this by `payload.targetAgentSlug`
(not by task assignee) and `POST`s `/hooks/wake` on the addressed
agent's gateway with the per-agent Bearer.

### What the agent runtime must implement

1. **Subscribe to `task.agent_chat` on `/hooks/wake`.** Dispatch on
   `kind`. Existing kinds (`task.assigned`, `task.commented`,
   `task.mentioned`, `task.ack_ready`) keep their semantics; this is
   additive.
2. **Treat `payload.systemPrompt` as the LLM system message.** PM
   constructs the strict template ("respond with ONLY the new
   description text, no preamble, no fence wrapper; markdown content
   INSIDE the description is encouraged"). The runtime should pass it
   verbatim — do not paraphrase, do not append your own framing.
3. **Use `payload.userMessage` as the user turn.** It already embeds
   the current description between the `<<<CURRENT_DESCRIPTION`
   markers, so the LLM has full context in conversation form.
4. **Take the LLM reply text and POST it back.** Read
   `payload.replyEndpoint`; do not hard-code the URL. The body is
   exactly:

```bash
curl -fsS -X POST "https://agents.vixi.au${payload.replyEndpoint.path}" \
  -H 'Content-Type: application/json' \
  -H "Cookie: ${pm_session_cookie_for_this_agent}" \
  -d "$(jq -n --arg id "${payload.chatMessageId}" --arg desc "${llm_reply}" \
        '{messageId: $id, description: $desc}')"
```

   The grant is single-use. A second call returns `410 Gone`.

5. **Auth.** The endpoint requires a PM session whose `user.kind` is
   `agent` AND whose linked `Agent.slug` matches the message's
   `targetAgentSlug`. The agent's seeded credential
   (`/etc/openclaw/pm-agent-credentials/<slug>.json`) is the source of
   that session; the runtime must log in with NextAuth once and reuse
   the cookie. A future slice may swap this for a service token.
6. **Mismatch handling.** 400 = wrong task/epic id in the message; 403
   = not addressed to this agent; 404 = task/epic gone (likely soft-
   deleted); 410 = grant already used. None should be retried — they
   are policy faults, not transport faults.

### What `install.sh` should provision

`openclaw/install.sh` (separate repo) is the install path for the
agent runtime + consumer. To support `task.agent_chat`, it must:

- Ensure `PM_DISPATCH_SOCKET` (or `PM_DISPATCH_DROP_DIR=/var/lib/pm/drop`)
  on the PM host matches `PM_CONSUMER_SOCKET` /
  `PM_CONSUMER_DROP_DIR=/var/lib/pm/drop` on the consumer side — both
  ends point at the same path.
- Drop the per-agent Bearer tokens into the file
  `lib/pm-consumer/README.md` documents (`PM_CONSUMER_HOOK_TOKEN_FILE`,
  default `/etc/openclaw/pm-consumer-tokens.json`).
- Provision the agent's PM session — either by running the seeded
  credential flow once and persisting the cookie jar under the agent's
  workspace, or by issuing a service token (future work).
- Configure each agent's `/hooks/wake` handler to dispatch on
  `event.kind === "task.agent_chat"` and route to the LLM call path
  documented above.

This repo's `deploy/pm.env.example` carries the PM-host side, and
`deploy/pm-consumer.service` carries the file-drop consumer side. The
OpenClaw installer should create `/var/lib/pm/drop` and install/start
the consumer service when the PM checkout is present.

## Schema highlights

`prisma/schema.prisma` is the source of truth. Key tables:

- `User` / `RolePermission` / `PasswordResetToken` — auth and identity.
  `User.kind` is `"human" | "agent"`; agent users link to `Agent` via
  `agentId`.
- `Agent` — system-managed mirror of `/srv/agents/index.json`. Carries
  slug, role, `codeOwner`, `gatewayPort`, last-seen `rawJson`, and a
  `deactivatedAt` tombstone.
- `Project` / `ProjectMember` / `Epic` / `Task` / `Comment` — board
  data. `Task` is self-referential for sub-tasks; status uses verbatim
  labels (no Jira aliases); `Project.readmePath` points at
  `/srv/Data/projects/<id>/README.md` on the host filesystem. `Epic`
  carries its own `assigneeId` + `actingManagerId` (HOMELAB-47) —
  independent of any task's principals or status.
- `Attachment` (HOMELAB-47) — file metadata for task/epic uploads.
  XOR(taskId, epicId) is enforced server-side. Content-addressed via
  `sha256`, indexed for de-duped GC.
- `Task.deletedAt` / `Epic.deletedAt` + `deletedById` (HOMELAB-48) —
  soft-delete columns. `deletedAt != null` means in the bin; the value
  is also the cascade-batch anchor and the 7-day purge anchor.
- `AgentChatMessage` (HOMELAB-48) — chat thread per (taskId|epicId,
  agentSlug). Carries `allowDescriptionEdit` and `editGrantUsedAt` for
  the one-shot agent description write-back grant.
- `ActivityLog` — audit trail. `targetAgent` + `targetFile` keep
  agent-control-surface rows independent of project/task lifecycles.
- `PmEventDelivery` (HOMELAB-46 Slice 4) — consumer-side delivery log.
  `@unique(dedupeKey)` drives the replay-test idempotency property.

Migrations under `prisma/migrations/`:

- `20260521081126_init` — Stage 1 baseline.
- `20260521115507_homelab44_stage2_schema` — sub-tasks, project README
  path, verbatim status labels.
- `20260521194341_homelab44_acting_manager` — `Task.actingManagerId`.
- `20260521233000_homelab52_profile_audit` — `ActivityLog.targetAgent` /
  `targetFile` indexes for the profile-editor audit trail.
- `20260522080000_homelab46_pm_event_delivery` — `PmEventDelivery`.
- `20260522112410_homelab47_epics_attachments` — Epic assignee +
  acting-manager, `Attachment` table.
- `20260522121913_homelab48_bin_and_chat` — `Task.deletedAt` /
  `Epic.deletedAt` (+ `deletedById`), `AgentChatMessage` table.

## Environment

See `.env.example` for the full list. Highlights:

- `DATABASE_URL` — `file:./pm.db` for dev; Prisma resolves it relative
  to `prisma/schema.prisma`, landing the file at `prisma/pm.db`.
- `AUTH_SECRET` — `openssl rand -base64 32`.
- `AUTH_TRUST_HOST=true` — required behind nginx.
- `APP_URL` — public URL, used for cookies + reset links.
- `AGENT_INDEX_PATH` — host descriptor (default `/srv/agents/index.json`).
- `AGENT_CREDENTIALS_DIR` — per-agent seed-credential dir (mode 0600).
- `AGENT_SYNC_INTERVAL_MIN` — periodic sync cadence (minutes).
- `PM_DISPATCH_DRIVER`, `PM_DISPATCH_SOCKET`, `PM_DISPATCH_DROP_DIR` —
  dispatch seam selection / endpoints (`lib/pm-dispatch/README.md`).
- `PM_CONSUMER_SOCKET`, `PM_CONSUMER_DROP_DIR`,
  `PM_CONSUMER_HTTP_PORT`, `PM_CONSUMER_HTTP_TOKEN`,
  `PM_CONSUMER_HOOK_TOKEN_*` / `PM_CONSUMER_HOOK_TOKEN_FILE` —
  consumer side (`lib/pm-consumer/README.md`).
- `PM_ATTACHMENT_ROOT` — override the on-disk root for attachments.
  Defaults to `/srv/Data/projects` in production and
  `<cwd>/.data/attachments` otherwise.
- `PM_ATTACHMENT_MAX_BYTES` — per-file size cap, default 25 MiB.
- `PM_BIN_TTL_DAYS` — soft-delete retention, default 7.
- `PM_BIN_PURGE_INTERVAL_MIN` — purge job cadence, default 60.

## Deployment

Manual bootstrap on `agents.vixi.au`; the full playbook lives in
[deploy/README.md](./deploy/README.md). After Stage 1:

- Schema changes — generate with `pnpm prisma migrate dev --name <change>`
  locally, commit the new migration dir, roll forward on the host with
  `pnpm prisma migrate deploy`. Never `db push` against the production DB.
- The PM webapp and the `pm-consumer` process restart independently —
  Slice 4 does not require rebuilding Next when only the consumer changes.

## Background / spikes

- `docs/spikes/HOMELAB-45-transports/` — transport selection memo and
  bench harness that picked AF_UNIX as primary with the file-drop
  fallback used here.

## Known follow-ups

- Email send for `password_reset_tokens` (schema exists; sender deferred
  to v1.1 polish).
- Permission enforcement on top of the `RolePermission` stub.
- A PM-visible task key separate from `task.id` (HOMELAB-46 commentId
  12265 — current dispatch envelopes assert `task.key === task.id`,
  which the Slice 3 integration smoke pins).
- OpenClaw-side AF_UNIX listener for `PM_DISPATCH_SOCKET` is a
  prerequisite for any live agent-wake roll-out beyond file-drop.

## Review notes (2026-05-22)

Snapshot read of the codebase from a passing reviewer. Opinions, not
directives — keep, push back on, or delete as fits. Items the HOMELAB-47
slice already addressed (poor task editor layout, agents missing from
pickers, no attachments, tasks coupled to epic state, missing dates) are
deliberately not repeated below.

**What's working well**

- Seam discipline at the dispatch boundary. `notifyDispatch` returns a
  `DispatchResult` instead of throwing, rule enforcement strictly
  precedes dispatch, and `http-localhost` is deliberately not
  env-selectable so it can't be misconfigured into production. These
  are decisions that don't show up in first-draft code.
- Migration hygiene. Committed migrations, `db push` explicitly banned
  in prod, the deploy README walks the steps.
- `PmEventDelivery` design — `UNIQUE(dedupeKey)` for idempotency,
  audit rows living separately on `ActivityLog` so the delivery log can
  be truncated without losing history.
- Schema comments explain *why* (the `codeOwner` constraint, the
  `readmePath` decision, "no parallel SubTask"), not just *what*.
- Obvious-but-wrong abstractions resisted: verbatim status labels
  (no Jira aliases), self-referential `Task` instead of a separate
  `SubTask`, `lib/workflow.ts` separated from persistence.
- The HOMELAB-45 spike kept around with a memo + bench, defending a
  current architectural choice.

**Things worth pushing on**

- The single-host assumption is load-bearing in many places at once:
  in-process rate limit, `setInterval`-driven periodic sync,
  file-drop directory, credential dir, host-local Atlas snapshot fetch.
  Going multi-host is a refactor, not a switch flip — surface area is
  larger than it looks.
- `/agents` does an uncached `fetch` to `127.0.0.1:3013/agents/snapshot`
  with no timeout and silently swallows errors. If Atlas hangs, the
  dashboard hangs. A short timeout + "snapshot unavailable" banner
  costs ~10 lines and removes a class of incident.
- `task.key === task.id` pinned by integration assertion is a
  known-wrong invariant kept honest by tests. Every additional consumer
  that relies on the conflation widens the eventual migration.
- Three dispatch drivers + a disabled state for a single-host system is
  a lot of optionality. Defensible (primary + fallback + test driver),
  but worth watching whether file-drop ever actually gets used in anger
  or quietly bit-rots.
- Tests are smoke scripts under `scripts/`, not a test runner. Fine for
  a solo skeleton, but the most consequence-laden file in the repo
  (`lib/workflow.ts`) runs on faith between manual smokes.
- `User.mustRotatePassword` defaults `true`. Right for the seeded flow,
  sharp edge for any future programmatic user-creation path.
- `Task.rank` is a plain `Int` with a "simple Int for v1" comment. The
  rebalance day will come; the comment is honest about it.
- `ActivityLog` is accumulating denormalized audit fields (`targetAgent`,
  `targetFile`) plus its own index set. Works today, but the indexing
  surface keeps growing — at some point this is two tables, not one.

**Net read**

Well-architected for what it is: a deliberately single-host,
single-developer system with sharp seams against the things that *do*
leave the box (dispatch boundary, migration story, audit trail). Risk
is concentrated in the single-host assumptions and the absence of a
real test runner, not in the design.
