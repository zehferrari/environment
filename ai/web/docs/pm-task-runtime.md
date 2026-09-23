# Compact PM task runtime

Current change (22 September): PM channel 0.1.12 fixes agent-workspace evidence
uploads and distinguishes live checkpoint steering from CLI guidance through
authenticated PM responses. Continuations coalesce per source run, and capacity
waits name the occupying task. See the [execution handoff audit](audits/execution-handoffs-2026-09-22.md).
PM channel 0.1.11 adds explicit task notes and
routes autonomous narration to the owner-only Thinking tab. Required-attachment
coding tasks retain compact context, explicit review acceptance and native
attachment upload from 0.1.10. See [task Thinking](task-thinking.md) and the
[WDT-9 audit](audits/wdt-9-planning-workflow-2026-09-22.md). The historical table
below records the original 8 September rollout, not the current plugin version.

Enabled on **thinkpad on 2026-09-08**, after the workflow changes were merged
and deployed from `main` at commit `998dae4`. The live website and consumer use
`/srv/Code/environment.worktrees/main` with `/srv/Data/pm/wt-main.db`.

| Component | Verified active configuration |
| --- | --- |
| PM website and consumer | `PM_TASK_RUNTIME_V2=1` in both running processes |
| Persistent deployment configuration | `/etc/default/pm` contains `PM_TASK_RUNTIME_V2=1` |
| Active service configuration | `/etc/default/pm-active-worktree` contains the same flag; both services read this file |
| Gateway plugin | PM channel **0.1.2**, installed under `/usr/local/share/openclaw/plugins/pm-channel` |
| Enabled gateways | Asdrubal, Karen, Barekbaal and Carmen; each authenticated capabilities response advertised runtime version **1** and **15 PM tools** |
| Agent instructions | `AGENTS.md` and `WORKFLOW.md` synchronized from the deployed worktree and verified in every internal agent workspace |

The model-facing contract is `pm-task/3`; the plugin envelope/capability version
is `1`. These version numbers describe different contracts. The feature remains
disabled by default on a fresh installation until explicitly configured. The original 8 September activation required no database migration; the
Thinking release requires `20260922100000_task_thinking`.

## What changes

| Problem | Implemented behavior |
| --- | --- |
| Reintroducing PM on each wake | `pm-task/3` supplies identity, current role, task state, plan, checklist, repository/worktree and durable checkpoint. Generic PM manuals and personal startup files are no longer mandatory task onboarding. |
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

Workflow notifications now distinguish human PM/Web Push delivery from agent
wakes, skip obsolete work, and classify transient versus permanent failures.
Completion has one notification producer and atomically clears stale execution
warnings. See the [V23-42 completion audit](audits/v23-42-notification-completion-2026-09-22.md).

All agents must finish authorized work independent of a missing dependency
before raising a formal blocker. This rule is included in the compact task
contract, the full task context and the shared `WORKFLOW.md`. Early coordination
uses a task note while independent work continues. Missing physical-device
access does not stop automated verification or evidence uploads; actual device
checks remain required only by approved criteria or a demonstrated relevant
limitation. This is a shared operating instruction, not new device access or a
server-side proof that every remaining action depends on the blocker.

The current episode tool budgets remain unchanged: normally 30 calls, with
smaller provider/model ceilings selected by `episodeToolCycleBudgetForModel`.
PM attempts a checkpoint steer at two-thirds of the budget and aborts the turn
at exhaustion. WDT-11 exposed unsuccessful steering and incomplete handoffs;
a future change should use acknowledged checkpoints and a bounded grace period,
preserve active verification jobs, and use actual context occupancy where
available. Aggregate token usage is not context occupancy. Raising the call
limit alone does not address those handoff failures.

The enabled compact path covers PM-owned task notifications to coding agents
including attachment-required tasks. Direct owner chats, interactive work-item
proposals, Epics and general-role agents retain their existing interaction
contract. Native `pm_attach_file` uploads an existing local deliverable under
the current run grant; the CLI contract supplies the corresponding multipart
HTTP operation. Project-wide proposal tools remain outside this runtime.

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

Production activation checks confirmed the installed plugin bundle matched the
deployed source, all four gateways authenticated successfully, both running PM
processes had the enabled flag and a valid loopback origin, and the public login
page and generated CSS returned HTTP 200. nginx, PM and the consumer were active.
These checks did not create a synthetic live task or invoke an LLM; the
88–89% reduction below is still an isolated fixture result.

From `ai/web`, run the two self-contained suites and type check:

```bash
pnpm test:pm-task-tools
pnpm test:pm-task-runtime
pnpm exec tsc --noEmit --incremental false
```

For `pnpm test:workflow`, select and migrate a disposable `DATABASE_URL` first;
some existing suites use the caller's database. Implementation regression checks
used only migrated SQLite files under `/tmp`.

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

Before production activation, the plugin was also loaded against the locally
installed OpenClaw SDK from a copy under `/tmp`, verifying registration, capability authentication and invalid
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

## Installation, configuration and rollback

### Recovery from stalled gateway admission

WDT-17 exposed a queued-turn failure on 2026-09-22: after a restart, an
expired turn kept retrying a rejected PM callback while watchdog replacements
reused its open episode. HTTP delivery succeeded but no replacement gained
execution admission. This is a transport/session failure, not plan approval
or evidence that the model provider exhausted its allowance.

Watchdog continuations now request a new execution session. PM closes the
previously dispatched episode with `runtime_recovery`, preserves its checkpoint,
and supplies the successor with a full bounded brief and new tool credentials.
Ordinary continuations retain their existing episode. Retrying the same recovery
message does not rotate again.

The PM plugin cancellation boundary first calls the public gateway
`sessions.abort` API with `clearQueued: true` for the exact canonical PM session,
then drains any embedded run. An absent embedded run alone no longer proves
that its follow-up queue is empty. Failed queue cancellation fails the fence;
obsolete runs remain unauthorized and no callback permissions are weakened.
The public client uses the agent's configured local gateway credentials;
the internal `runtime.gateway.request` shortcut is unavailable to third-party
plugins. Checkpoint steering imports `queueAgentHarnessMessage` from
`openclaw/plugin-sdk/agent-harness-runtime`; the narrower `agent-harness`
export does not include it in OpenClaw 2026.9.3. A missing steer warning can
otherwise turn every tool-budget cutoff into an empty-checkpoint continuation.

For operational recovery, install the updated plugin, retire the affected
session's queue, and dispatch `sendTaskWorkflowNotification` with
`restartExecutionSession: true`. Verify `admittedAt` and actual task progress
before clearing the watchdog escalation. Preserve the implementation, evidence,
approval, and any independent formal blocker. Never call a successful HTTP 202
handoff a successful recovery.

### Deployment

For subsequent installations, deploy compatible application code through
`pm-switch`, install the complete plugin bundle, synchronize instructions, and
verify gateway capabilities before enabling compact turns. On thinkpad, run the
following from the deployed `ai/web` directory:

```bash
sudo node deploy/install-openclaw-pm-channel.mjs --registry /etc/openclaw/agents.json --token-group karen --restart
sudo /usr/local/sbin/openclaw-doc-sync
```

The installer preserves existing per-agent tokens, updates canonical and runtime
config copies, and restarts enabled gateways. The token group must match the PM
service group (`karen` on thinkpad). It must stage `task-tools.js` and
`task-telemetry.js` together with `index.js`; a website rebuild alone does not
reload plugins already running in gateways.

Set `PM_TASK_RUNTIME_V2=1` in **both** `/etc/default/pm` and
`/etc/default/pm-active-worktree`, preserving their ownership, permissions and
other values, then restart `pm.service` and `pm-consumer.service`. The base file
makes the setting survive future `pm-switch` operations; the active file is what
both installed units currently read. Changing only one file either leaves the
running services on the old setting or loses activation on the next deployment.
No website rebuild is needed for this server-side environment flag. Verify the
value in both running processes after restart. The flag is deployment-wide,
not a per-project allowlist.

Gateway verification uses authenticated loopback
`GET /pm-channel/capabilities` with the agent's PM-channel bearer, never its
gateway operator credentials. Expect `taskRuntimeVersions: [1]` and the 15
`pm_*` tool names. Keep the endpoint and credentials off public nginx routes and
out of logs. Capability availability does not grant a task role: tools are
exposed only in an eligible, authenticated PM turn, and mutations retain their
server-side authorization checks.

To stop new compact turns, remove the flag or set it to `0` in both env files,
then restart the website and consumer. Keep plugin 0.1.2 installed while already
queued compact turns drain, or cancel those turns through normal PM controls
before reverting the plugin/application. Retaining the new plugin is compatible
with legacy turns. Rollback does not require changing the database pairing.

The 2026-09-08 activation installed/restarted the gateways, synchronized their
docs, changed the two env files and restarted PM services. The preceding website
deployment used `pm-switch --database=main main`. No nginx configuration changes
or manual production task/plan/episode edits were made.

## Native tool discovery repair — 2026-09-09

PH-192 exposed a gap in the initial activation check: plugin 0.1.2's capability
endpoint advertised tools that OpenClaw did not discover because the manifest
omitted `contracts.tools`. Plugin 0.1.3 declares all 15 tools and makes the
capability handshake validate those declarations. It was activated on Asdrubal
after its current turn finished; other gateways were not restarted in this
repair. A real compact task turn then invoked `pm_context` and `pm_checkpoint`
successfully. See the [PH-192 audit](audits/ph-192-workflow-2026-09-09.md) for
rollout details, the retry-loop evidence and the remaining external blocker.

For future plugin activation, verify actual native-tool invocation and its
durable PM effect. A successful capabilities request alone does not prove
that model tool discovery works.


## PH-192 reset follow-up — backend compatibility (10 September 2026)

Gateway tool registration does not mean a CLI subprocess inherits those tools.
Barekbaal's `claude-cli/claude-opus-5` turn received `pm_context` and
`pm_submit_plan` instructions but only had Claude CLI's own tool registry.
Resetting the task changed its session/state, not that backend limitation.

The fix on `fix-v23-workflow-handoffs` keeps the compact snapshot and selects
its interface from the agent's configured primary model and fallback chain:

- Native API backends retain scoped `pm_*` tools.
- CLI backends, CLI fallbacks, and unreadable/unknown model configuration use
  the existing scoped HTTP API through Bash/exec. The compact contract supplies
  the per-message capability and allowed action schemas. It explicitly replaces
  earlier native-only instructions. No registry search or credential discovery
  is needed. Endpoint/task validation and the existing API permission,
  approval, revision, replay and cancellation checks still apply.
- Plugin 0.1.4 advertises native task tools only for a compatible configured
  backend. A stale compact/native payload is refused when the gateway backend
  is CLI, before spending another model turn.
- Explicit planning notifications carry an expected `submit_plan` outcome.
  A completed model turn without a durable plan or terminal workflow action
  raises the task's reporter alert and records a failed workflow disposition
  and readable activity event. Policy updates, context-only turns and reviewer
  assignment notices do not owe a new plan. No automatic retry is added.
- Hard reset still purges work, chat and execution state, but retains previous
  reset events and small summaries of backend/model, run status/action counts
  and selected runtime interface. It retains no prompts, credentials or old
  conversation content in those summaries.

`PM_AGENT_CONFIG_ROOT` defaults to `/srv/agents/openclaw`. The test harness
points it at temporary model configurations; it must not be set to the fixture
path in the live service. Both selected interfaces appear in
`pm.task.runtime.prepared` without exposing HTTP capabilities.

Activation requires the web/consumer source update and the plugin installer;
installing the plugin alone does not give the old web service the compact HTTP
contract. Preserve the current main deployment until this branch is merged
and promoted, then install/restart gateways when idle. No schema migration is
introduced by this follow-up.

### Role-based effort

PM channel 0.1.5 adds a one-shot effort policy: High for ordinary work and
xHigh, otherwise Max, otherwise supported High for planning/manager/review
turns. Selection uses gateway model metadata and current PM roles at dispatch.
See [Agent model upgrades](agent-model-upgrades.md#effort-by-pm-role).
This branch change is pending merge/deployment; the live default configuration
can be updated independently.

### Publishing before remote verification

Coding assignees can use `publish_checkpoint` for an In Progress standalone
task as well as an Epic child, with a fresh owner or PM-validated reviewer authorization. Standalone
publication pushes the task feature branch and preserves the original review
base; Epic-child publication uses the Epic integration branch. Both keep the
task active and require the remaining checks before `ready_for_review`.

### Thinking and explicit task notes

Plugin 0.1.11 / `pm-task/3` routes autonomous narration into the task Thinking tab.
The native `pm_task_note` tool and CLI `/notes` endpoint publish explicit concise
findings, decisions and questions. Existing workflow actions keep their blocker
and completion evidence. Thinking is display-only and is not added to future
prompts. See [task Thinking](task-thinking.md) for retention and rollout.

## Configuration dependency recovery

Repository preparation and start/submission reject incomplete effective PM Git
identity with `git_identity_incomplete`. Configure `defaultGitUserName` and
`defaultGitUserEmail` in Project, Workspace or System settings; changing local
`git config` does not repair the verifier's configuration. Report the exact
configuration dependency once and preserve completed work and test evidence.
The watchdog schedules one verification wake after the settings are repaired;
the agent clears the matching blocker through the normal workflow. Typed failed
procedure steps resume only while their original task/cycle is current.
See [WDT-10 audit](audits/wdt-10-configuration-recovery-2026-09-22.md).

### Scoped reviewer permissions (2026-09-23)

PM channel 0.1.14 adds `pm_review_permission` for the independent reviewer during
In Progress or Review. Each request gets a deliberate scope assessment against
the approved plan; this is not automatic approval. See the
[V23-43 audit](audits/v23-43-reviewer-permissions-2026-09-23.md) for request fields,
plan/cycle fences, owner escalation and rollout checks. `currentPermission` in
the compact snapshot and task read API includes the exact request, latest
reviewer decision and any grant even when older history has been clipped.


### Structured review corrections

`review_feedback` requires `findings: [{title, acceptanceCriteria, scopeReference}]`
(1–20 items). The canonical review decision atomically creates pending
implementation subtasks, preserves the reviewed candidate/plan reference, and
queues the assignee handoff. Comment-only feedback is rejected without moving
the task. Browser, native tools, and scoped HTTP share this contract.

`complete_subtask` requires `completionEvidence` for a correction. Open findings
block resubmission and acceptance even if their checklist row is accidentally
removed elsewhere. Ordinary deletion is rejected. An independent reviewer may
use `remove_subtask` with `supersededReason` and a later owner-authored
`ownerInstructionCommentId` to supersede obsolete work; the finding remains
visible as superseded. That decision authorizes no expanded implementation.
The Sub-Tasks tab shows criteria, scope, candidate, evidence and supersession
reasons; context reads expose `reviewFindings` outside clipped comment history.

Deployment requires migration `20260923010000_review_findings`, a PM rebuild,
and PM channel plugin 0.1.15 on all agent gateways. Historical feedback is not
automatically interpreted or converted; reconcile it with current owner scope.
