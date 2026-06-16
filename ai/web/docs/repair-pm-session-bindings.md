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
- **split-pair** — the canonical sibling exists **and** the two conversations do
  **not overlap in time** (one ended before the other began, compared via
  `sessionStartedAt`/`lastInteractionAt`). These are the same logical thread that
  was split at the cutover. The earlier conversation is the *predecessor* and the
  later one the *successor*. The tool merges them by concatenating the
  predecessor transcript **ahead of** the successor transcript (chronological
  order) into the canonical record's `sessionFile`, folds both windows and token
  counts into the surviving canonical record, then drops the bare key — so the
  canonical key resumes with the **full, combined history** and both histories
  are preserved.
- **conflict** — the canonical sibling exists **and** the timelines **overlap**
  (interleaved activity), or required timeline / `sessionFile` data is missing.
  The histories are genuinely divergent and cannot be safely auto-ordered, so the
  pair is reported with its reason (`overlapping-timelines`,
  `insufficient-timeline-data`, `missing-session-file`) and **skipped for manual
  review** — never auto-merged.

The dry-run report and `--json` output count and list each class distinctly
(`migrations` / `split-pairs` / `conflicts`), and any split-pair skipped at apply
time (e.g. a transcript file that vanished) is reported separately.

Already-namespaced keys and non-PM keys are ignored.

## Safety properties

- **Dry-run by default.** Without `--apply` nothing is written.
- **Backup before mutation.** `--apply` first copies the store to
  `sessions.json.bak-<timestamp>`, then writes via a temp file + atomic rename.
  Each split-pair merge also backs up the destination transcript to
  `<sessionFile>.bak-<timestamp>` before rewriting it.
- **No data loss.** Migration only re-keys an existing record; its transcript is
  untouched. A split-pair merge writes the combined transcript to the canonical
  `sessionFile` (original backed up) and leaves the predecessor's own transcript
  file intact on disk, so the operation is fully reversible from the backups.
  Conflicts are never merged.
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
