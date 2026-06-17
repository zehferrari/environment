# PM session-key namespacing — regression coverage & rollout checks

End-to-end regression coverage and operator rollout checks for the PM route-key
namespacing fix (ENV-86 canonicalization + ENV-87 reconciler). This is the
verification layer for ENV-88.

## What regressed and what guards it

The web app emits a **bare** PM session key
(`buildPmOpenClawSessionKey`, `lib/agents/auth/session-bindings.ts`):

```
pm:<scopeType>:<scopeId>:agent:<agentSlug>      # scopeType ∈ direct|task|epic
```

Before ENV-86 the gateway PM inbound path recorded that key **verbatim**, so PM
sessions lived outside the `agent:<id>:` namespace. ENV-86 inserts a canonicalizer
on the inbound seam (`openclaw-pm-channel/session-key.js`, applied in
`openclaw-pm-channel/index.js`) so the persisted/routed key becomes:

```
agent:<agentId>:pm:<scopeType>:<scopeId>:agent:<agentSlug>
```

`<agentId>` is the route agent id from `channels.pm.agentId` (default `main`).

The regression is a **continuity** failure: a second turn on the same anchor must
resume the first turn's session instead of forking a new one. Because the store
key is a pure function of `(channels.pm.agentId, bare web key)`, continuity holds
across a gateway restart / `openclaw.json` regeneration **iff** that key is stable.

## Coverage

| Layer | Test | Covers |
| --- | --- | --- |
| Contract — canonicalizer seam | `test:pm-session-key-canonicalization` | direct/task/epic scoping, idempotency, route-id normalization (ENV-86) |
| E2E — restart / config-regen continuity | `test:pm-session-key-restart-continuity` | same store key across boots for direct/task/epic; bare key is canonicalized not recorded verbatim; per-account `agentId`; agentId-change hazard |
| Reconciler | `test:repair-pm-session-bindings` | migrate / split-pair / conflict / idempotency / on-disk apply (ENV-87) |
| Rollout guard | `test:scan-bare-pm-session-keys` | post-deploy detection of bare `pm:*` keys minted after cutover |

The gateway SDK that `openclaw-pm-channel/index.js` imports is not present in the
web app's `node_modules`, so `runPmTurn` cannot be driven in-process. The E2E
test therefore exercises the two **real** importable halves of the seam — the
web-app key builder and the gateway canonicalizer — and models the single line
the inbound handler runs between them (scope under the configured route agent id).

## Post-deploy smoke check

After cutting over to the namespacing fix, confirm no **new** bare `pm:*` keys are
being minted. `scripts/scan-bare-pm-session-keys.ts` buckets bare keys by creation
time vs a cutover timestamp and **exits non-zero** if any were created at/after it
(pre-cutover bare keys are the reconciler's job and do not fail the check):

```bash
pnpm --dir ai/web scan-bare-pm-session-keys \
  --store ~/.openclaw/agents/main/sessions/sessions.json \
  --cutover 2026-06-17T00:00:00Z
```

```
store:            .../sessions.json
cutover:          2026-06-17T00:00:00.000Z
total keys:       2
bare pm keys:     1
post-cutover:     0 (FAIL if > 0)
pre-cutover:      1 (reconciler's job)
undatable:        0

OK: no bare pm:* keys created after cutover.
```

A non-empty `post-cutover` list means PM canonicalization is **not in effect** for
new turns (fix not deployed, or regressed). Use `--json` for CI; exit `1` = found
offenders, `0` = clean, `2` = usage/IO error.

## One-time historical repair (dry-run sample)

Conversations that existed before the cutover stay stranded under the bare key
until reconciled. Always dry-run first (see `repair-pm-session-bindings.md`):

```bash
pnpm --dir ai/web repair-pm-session-bindings \
  --store ~/.openclaw/agents/main/sessions/sessions.json
```

```
store:        .../sessions.json
agentId:      main
total keys:   2
namespaced:   1
bare pm keys: 1
migrations:   1
split-pairs:  0
conflicts:    0 (skipped for manual review)
  migrate    pm:direct:asdrubal:agent:barekbaal  ->  agent:main:pm:direct:asdrubal:agent:barekbaal

dry-run: no changes written. Re-run with --apply to reconcile.
```

Re-run with `--apply` (writes a timestamped backup first) once the plan looks
right, then re-run the post-deploy smoke check above to confirm a clean store.

## Continuity hazard — keep `channels.pm.agentId` stable

The persisted key is namespaced under `channels.pm.agentId`. If a regenerated
`openclaw.json` **changes** that value, every PM session re-homes to the new
namespace and prior conversations stop resuming. When regenerating config, keep
`channels.pm.agentId` (and any per-account `agentId`) stable; if it must change,
run the reconciler against the new agent id afterward. The E2E test pins this
behavior so a config-templating change that drops/rewrites `agentId` is caught.

## Run the full suite

```bash
pnpm --dir ai/web test:pm-session-key-canonicalization
pnpm --dir ai/web test:pm-session-key-restart-continuity
pnpm --dir ai/web test:repair-pm-session-bindings
pnpm --dir ai/web test:scan-bare-pm-session-keys
```
