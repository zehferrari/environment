# `lib/pm-consumer`

PM consumer / dispatcher (HOMELAB-46 Slice 4).

Long-running OpenClaw-side service that reads PmEvents from the
dispatch boundary (`lib/pm-dispatch`), validates them, resolves the
target agent, and wakes that agent's OpenClaw gateway via
`POST /hooks/wake`. Slices 1-3 produced the envelope + emitter side;
this slice closes the loop on the consumer end.

## Transports

Per the HOMELAB-45 In Review memo (commentId 12162), the consumer
exposes three transports:

| Transport     | Selection                                                | Role                                                     |
|---------------|----------------------------------------------------------|----------------------------------------------------------|
| AF_UNIX       | `PM_CONSUMER_SOCKET=<path>`                              | Primary. NDJSON over a per-host socket.                  |
| File-drop     | `PM_CONSUMER_DROP_DIR=<dir>`                             | Fallback. One JSON file per envelope; consumed in order. |
| HTTP localhost| `PM_CONSUMER_HTTP_PORT=<port>` + `PM_CONSUMER_HTTP_TOKEN`| Explicit-opt-in only. Loopback bind, Bearer auth.        |

Both socket and file-drop legs can run concurrently and an in-process
"call the consumer directly" transport is **not** exposed — that's
the boundary that keeps HOMELAB-44 rule enforcement upstream of
dispatch.

## Pipeline

For each received envelope:

1. `parsePmEvent(raw)` — wire-shape validation (kind, schema, id,
   actor, task, payload). Reject path writes nothing.
2. `dedupeKeyFor(event)` — deterministic key from
   `${kind}:${task.id}:${event.id}`. Identical envelopes produce
   identical keys.
3. `appendDelivery(...)` — `PmEventDelivery.create` with
   `@unique dedupeKey`. A UNIQUE conflict shortcuts the pipeline as a
   `skipped-duplicate` outcome with no downstream side effects.
4. Target resolution — User → Agent (PM DB) → gateway port
   (`/srv/agents/index.json`). No agent target ⇒ "unmatched".
5. Wake — `POST http://127.0.0.1:<gateway_port>/hooks/wake` with the
   per-agent Bearer token. Non-2xx ⇒ "failed", network error ⇒
   "failed".
6. Audit — exactly one `ActivityLog{ kind: "agent.wake.<outcome>" }`
   row per envelope, with `targetAgent` set so HOMELAB-51's
   agent-action audit trail can be queried per-slug.

`PmEventDelivery` can be truncated for retention without losing the
audit trail — that's the HOMELAB-51 "audit-survives-pm_events-
truncation" property.

## HOMELAB-46 acceptance

- Typed envelope validation: `parsePmEvent` rejects anything not on
  schema version 1.
- `UNIQUE(dedupe_key)`: enforced by the `PmEventDelivery.dedupeKey`
  unique index in the Slice 4 migration.
- Replay test: `scripts/pm-consumer-replay-test.ts` fires the same
  envelope twice (once over socket, once via file-drop) and asserts
  exactly one mock-gateway hit + one delivered row + one duplicate
  audit row.

## Per-agent Bearer tokens

`POST /hooks/wake` is bearer-auth'd per the OpenClaw gateway docs
(`docs/automation/cron-jobs.md`). Tokens are resolved in this order:

1. `PM_CONSUMER_HOOK_TOKEN_<UPPERCASE_SLUG>` env var (local-dev /
   tests).
2. `PM_CONSUMER_HOOK_TOKEN_FILE` JSON map (default
   `/etc/openclaw/pm-consumer-tokens.json`).

A missing token surfaces as a `failed` outcome — the consumer never
falls back to an empty bearer.

## Running

```bash
# Primary + fallback (production deployment shape):
PM_CONSUMER_SOCKET=/run/pm/events.sock \
PM_CONSUMER_DROP_DIR=/var/lib/pm/drop \
pnpm tsx scripts/pm-consumer.ts

# Replay-test acceptance:
pnpm tsx scripts/pm-consumer-replay-test.ts
```

## Rebuild / restart guidance (Asdrubal request, HOMELAB-44 cmt 12317)

- Schema change: `pnpm prisma migrate deploy` (or `db push` for the
  dev DB) applies the Slice 4 migration that adds `PmEventDelivery`.
  Existing tables are untouched.
- App rebuild: not required — the consumer is a separate `tsx`
  process, not bundled into Next. The PM webapp (`pnpm dev` /
  `pnpm build`) is unaffected by Slice 4 and does not need a restart
  to keep emitting events.
- Live consumer: restart the `pm-consumer` process (no daemon yet —
  run it under `tmux`, systemd, or whatever process supervisor the
  host uses) to pick up new code. Stopping it mid-flight is safe —
  unprocessed file-drop envelopes survive on disk and the socket leg
  re-binds on next start.
