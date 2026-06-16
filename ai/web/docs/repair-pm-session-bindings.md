# Repairing fragmented PM session bindings

## Background

PM dispatches to OpenClaw using a route session key built by
`buildPmOpenClawSessionKey` (`lib/agents/auth/session-bindings.ts`):

```
pm:<scopeType>:<scopeId>:agent:<agentSlug>          (conversation key)
pm:<scopeType>:<scopeId>:agent:<agentSlug>:turn:<id> (per-turn key)
```

Before **ENV-86**, the gateway recorded that inbound key verbatim, so PM
sessions were persisted in the agent store (`sessions.json`) under those **bare**
keys. ENV-86 added a canonicalizer (`openclaw-pm-channel/session-key.js`) so new
inbound PM keys are scoped under the route agent namespace:

```
agent:<agentId>:pm:<scopeType>:<scopeId>:agent:<agentSlug>[:turn:<id>]
```

Conversations that existed before the cutover are stranded under the bare key,
while future turns resume under the canonical namespaced key — the binding is
**fragmented**, breaking conversation continuity for those scopes.

## What the tool does

`scripts/repair-pm-session-bindings.ts` reconciles a single agent's
`sessions.json` toward the canonical namespaced form. It reuses the exact ENV-86
canonicalizer, so a repaired key is byte-for-byte what the runtime now produces.

For each bare `pm:*` key it computes the canonical sibling and classifies it:

- **migrate** — the canonical sibling does **not** exist. The record (and its
  transcript pointer / `sessionId`) is re-keyed to the namespaced form so future
  canonicalized dispatches resume the same session. The embedded self-reference
  (`sessionKey`, `systemPromptReport.sessionKey`) is updated; nothing else in the
  record changes.
- **conflict** — the bare key **and** its namespaced sibling both exist. Each
  owns a distinct `sessionId`/transcript, so the histories have diverged. The
  case is reported and **skipped for manual review** — never auto-merged.

Already-namespaced keys and non-PM keys are ignored.

## Safety properties

- **Dry-run by default.** Without `--apply` nothing is written.
- **Backup before mutation.** `--apply` first copies the store to
  `sessions.json.bak-<timestamp>`, then writes via a temp file + atomic rename.
- **No data loss.** Migration only re-keys an existing record; the transcript
  `.jsonl` is referenced by `sessionId`/`sessionFile` inside the record and is
  untouched. Conflicts are never merged.
- **Idempotent.** Once a key is namespaced it is no longer a candidate, so a
  second run is a clean no-op.

## Usage

```bash
# Dry-run report (read-only):
pnpm --dir ai/web repair-pm-session-bindings \
  --store ~/.openclaw/agents/main/sessions/sessions.json

# Machine-readable plan:
pnpm --dir ai/web repair-pm-session-bindings \
  --store ~/.openclaw/agents/main/sessions/sessions.json --json

# Apply (writes a timestamped backup first):
pnpm --dir ai/web repair-pm-session-bindings \
  --store ~/.openclaw/agents/main/sessions/sessions.json --apply
```

The agent id is inferred from a store path shaped like
`.../agents/<agentId>/sessions/sessions.json`; override with `--agent-id <id>`.

> **Operational note:** run `--apply` against a store whose agent is not mid-run
> (or during a maintenance window). The migration re-keys live conversation
> records; applying while the owning agent is actively writing the same
> `sessions.json` risks racing the runtime's own writes. Always confirm the
> dry-run report and keep the generated backup until continuity is verified.

## Tests

```bash
pnpm --dir ai/web test:repair-pm-session-bindings
```
