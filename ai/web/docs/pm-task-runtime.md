# Compact PM task runtime — staged implementation

Implemented in `fix-v23-workflow-handoffs`. Production rollout is separate.
`PM_TASK_RUNTIME_V2` is off unless explicitly set to `1` in the PM server and
consumer environment. There are no new database migrations.

## What changes

| Problem | Implemented behavior |
| --- | --- |
| Reintroducing PM on each wake | `pm-task/2` supplies identity, current role, task state, plan, checklist, repository/worktree and durable checkpoint. Generic PM manuals and personal startup files are no longer mandatory task onboarding. |
| Reconstructing HTTP and credentials | PM channel plugin 0.1.2 registers scoped `pm_*` tools. The active ingress generation supplies task/message identity and credentials outside the model's prompt and tool schema. |
| Revisions start cold | Task/agent session bindings persist across planning feedback and plan review. Different agents have separate sessions; every message receives its own credentials. |
| Multiple reset counters | Checklist bookkeeping consumes the real tool budget, not a second workflow-action charge. Open execution episodes own rotation; the existing completed-turn fallback still bounds planning sessions. Context-failure recovery and hard tool limits remain. |
| Replanning at handoff | Turns carry the latest durable checkpoint with decisions, evidence, remaining work and next action. Missing historical facts are retrieved on demand. |
| Elaborate plans for small changes | Default to sequential work, usually one implementation step and focused verification. Approval creates the checklist; agents reuse it. Independent review remains required. |
| No reliable comparison | Preparation logs record old/new PM prompt character sizes. Correlated model usage events persist numeric token/cache measurements when the gateway reports them. A read-only report groups runs by contract, role, provider and model. |

The earlier V23-38 fixes remain: review wakes are keyed by plan revision;
preparation owns the sole post-approval wake; `start` preserves its continuing
execution episode; the context API returns the canonical structured Action Plan.
This follow-up also gives plan-feedback wakes their own revision keys and fixes
the workflow route rejecting a run in the legitimate `admitted` state.

## Scope and contracts

The opt-in path covers PM-owned task notifications to coding agents without an
attachment-required review gate. Direct owner chats, interactive work-item
proposals, Epics, general/artifact agents and attachment-required tasks retain
their existing interaction contract. Native attachment upload and project-wide
proposal tools are not part of this rollout.

The prompt is an enqueue-time snapshot, not lasting authority. The API rechecks
origin, task access, current role, workflow state and execution fences for every
mutation. A plan decision binds the revision shown to the reviewer; reading a
new plan through `pm_context` updates that binding. Exact lost-response replay
uses the existing command receipt. Stale decisions cannot silently approve a
newer revision.

Large descriptions, evidence and checklists have explicit omission markers.
An oversized plan is summarized with the omitted-step count, and its full
criteria must be read before deciding. `pm_context` supports `current`, `plan`
and explicit `history`; full history is not a startup requirement. Context reads
retain existing scoped-grant expiry/usage limits. An expired grant is reported
as a tool error, not replaced by searching local credentials.

The channel validates task-scoped loopback URLs and the requested tool list
before accepting ingress. Tools are unavailable outside the active PM session,
and closures from canceled/replaced generations cannot act. Gateway delivery
checks authenticated `/pm-channel/capabilities` before posting a compact turn.
An old plugin causes a clear dispatch failure; it never receives an unusable
compact instruction set. The ingress record is released if context assembly
fails before model dispatch.

`llm_input`/`llm_output` hooks correlate provider usage to the active generation.
No prompt, reasoning, tool arguments or credentials enter usage records. The
hook's aggregate input/output/cache counts are **not** treated as instantaneous
context pressure. Existing explicit prompt/window-pressure handling remains;
hard tool limits are still the fallback when window telemetry is unavailable.
Missing gateway usage is reported as unavailable, never zero cost.

## Verification

From `ai/web`, run the two self-contained suites and type check:

```bash
pnpm test:pm-task-tools
pnpm test:pm-task-runtime
pnpm exec tsc --noEmit --incremental false
```

For `pnpm test:workflow`, select and migrate a disposable `DATABASE_URL` first;
some existing suites use the caller's database. Validation for this branch used
only migrated SQLite files under `/tmp`.

The two new suites use injected transport or a migrated disposable SQLite DB.
They cover credentials, task/session/generation fencing, role refusal, native
plan submission/feedback through the real HTTP handler, receipt replay, stale
plan decisions, distinct revision wakes, continuity, rotation ownership,
telemetry sanitization and old-gateway refusal. The runtime fixture queues fake
notifications and never dispatches a live agent.

On the isolated small-task fixture, initial planning, revised planning and plan
review PM prompts fell from approximately 27–31k characters to 3.3k: **88–89%**.
These are PM prompt characters, not total model input tokens or measured live
latency. OpenClaw's own bootstrap/context and reasoning still contribute cost.
The legacy prompt builder currently runs before compact rendering, so this
change reduces transmitted context; it does not claim to remove all server-side
context-construction work.

The plugin was also loaded against the locally installed OpenClaw SDK from a
copy under `/tmp`, verifying registration, capability authentication and invalid
runtime rejection without installing it or contacting a gateway.

## Read-only comparison

Use an explicitly selected SQLite database snapshot. The command opens SQLite
read-only and does not load an environment file or infer the live DB path:

```bash
pnpm report:pm-task-workflow --database=/tmp/pm-comparison.db --task=TASK_ID
```

The JSON contains queue/admission timings, first-tool timing, the last recorded
workflow-action timing, total duration, observed tool counts, measured token
and cache counts, revisions, episode close reasons, rotations and p50/p95
summaries. First-tool timing does not establish that the tool performed useful
work. Unknown values remain `null`; repeated model-usage callbacks are deduped.

For a future controlled comparison, use matched small tasks with the same
agent/provider/model, repository starting point, task scope and verification
requirements. Record cold and warm sessions separately. Compare multiple runs
with the flag off/on and inspect failures/cancellations, plan revisions, total
input/output/cache tokens, tool calls and end-to-end duration. Require correct
handoffs, independent review and passing acceptance checks before accepting a
speed gain. Tune model/reasoning settings only after those measurements.

## Future activation and rollback — not executed

1. Review/publish the fix branch. Keep the runtime flag off while installing the
   complete plugin 0.1.2 bundle through the existing PM channel installer and
   reconciling the shared agent docs. Restart the affected gateways through that
   controlled installation workflow. Confirm the authenticated capabilities.
2. Promote the reviewed worktree through `pm-switch` under separate production
   authorization. Do not run a standalone build against the live checkout.
3. Enable `PM_TASK_RUNTIME_V2=1` consistently for the PM server and consumer in
   an isolated/canary environment, then run the matched-task comparison. The
   flag is deployment-wide, not a per-project allowlist.
4. To stop new compact turns, unset the flag in both services. Already queued
   compact turns still require the new plugin: drain/cancel those through the
   normal PM controls before reverting the gateway plugin or application.

No production DB edits, live agent messages, builds, installer calls, service
restarts, `pm-switch` operations or nginx changes were performed for this work.
