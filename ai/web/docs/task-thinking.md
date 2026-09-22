# Task Thinking and concise comments

Task **Thinking** shows emitted progress, available reasoning summaries and tool
activity grouped by agent/run. It does not request or reconstruct private model
reasoning. Missing provider telemetry is labelled explicitly. The displayed
provider/model comes from run telemetry; a completed turn does not imply the task
is complete.

The tab and `/api/tasks/:taskId/thinking` match the existing live PM stream's
owner-only access policy, check task access and respect owner preview mode.
Customers and administrators receive no Thinking data. The client polls every
three seconds only while Thinking and the browser document are visible, supports
agent filtering and earlier-run pagination, pauses following when scrolled back,
and clears data when authorization is revoked. Reading never dispatches work.

## Output routing

- PM-authored autonomous task wakes publish their plain output to Thinking.
  The server identifies them from the stored workflow origin, not words in the
  model's reply. This applies to native and CLI transports, including legacy
  notifications without a deduplication key.
- Answers to human task comments and interactive Action Plan discussion retain
  their original destination. Structured plan submissions still follow the
  existing validated transaction.
- `pm_task_note` explicitly publishes a `finding`, `decision` or `question`.
  Claude CLI uses the same scoped HTTP contract:
  `POST /api/agent/tasks/:taskId/notes` with `messageId`, `token`, `category`, `body`.
  These notes are not approvals or workflow transitions and do not wake agents.
- Blocker, approval, review and completion actions retain their existing comments.
  Agents must not duplicate them with a task note. Existing comments stay intact.
- Thinking produces no comment notifications and is never included in the task
  context serializer. Checkpoints remain the source for continuation.

The note endpoint verifies the originating grant, current agent/task access,
assignee/reviewer role, active run and episode barrier. It accepts 1–2000
characters, with ten distinct notes per run maximum. Content/category/run-derived
IDs make retries idempotent, including replay after a run ends; new late notes
are rejected. No output is silently shortened to fit a comment.

## Persistence and provider support

`TaskThinkingSnapshot` captures activity transactionally before the stream ledger
compacts a final reply. Each run retains the newest 16,000 characters of progress,
16,000 characters of published reasoning and 100 tool records, with a visible
truncation indicator. Stable tool IDs prevent duplicate tool rows. Snapshots share
the run's lifecycle and cascade when it is deleted. Existing runs display retained
stream frames when available; previously discarded history cannot be restored.
No raw tool arguments/results or prompts are added. Workflow tokens, bearer values
and common credential fields are redacted from the Thinking projection; output
instructions additionally prohibit credentials.

A durable autonomous reply receipt is distinct from task completion. It protects
against false missing-reply retries while leaving the existing continuation and
terminal-action rules in charge. It does not create a success comment or mark the
task done. Missing reasoning summaries do not prevent progress/tool display.

Plugin **0.1.11** declares `pm_task_note` for supported native backends. Claude CLI
gets `/notes` in the `pm-task/3` contract. The plugin envelope remains version 1.
OpenAI, Anthropic and Ollama use the same server routing and note authorization.
Providers determine which live summaries/tool events are actually available.

## Validation and deployment

- `node --import tsx scripts/task-thinking-test.ts` — isolated migrated SQLite:
  provider-neutral routing, note authorization/replay, human answers, compacted
  history, bounded output, pagination and access checks.
- `node scripts/pm-task-tools-test.mjs` — native note routing and turn fencing.
- `node scripts/task-thinking-browser-test.mjs` — real Chromium UI against an
  isolated fixture; set `PM_BROWSER_DRIVER` to a resolvable `playwright-core`
  module and optionally `PM_BROWSER_BIN` to Chromium's executable.
- Existing WDT planning, compact runtime, channel lifecycle, workflow boundary,
  customer DOM and plugin compatibility tests remain required, plus TypeScript.

Deploy migration `20260922100000_task_thinking` and the web/consumer together via
`pm-switch --database=main main`; stage plugin 0.1.11 and reload gateways at a safe
turn boundary. Reconcile WORKFLOW.md into agent workspaces. Back up the database
and installed plugin first. Rollback can retain the additive table, but restore
matching application/plugin versions. Do not build the live standalone tree
without its immediate restart.

## Activation — 22 September 2026

- Feature commit: `46721d3`; route startup correction: `138e2d5`.
- Deployed application/consumer receipt:
  `/srv/Data/pm/deployment-receipts/2026-09-22T025806Z-main-138e2d53e3d4.receipt`.
- Backup: `/var/backups/openclaw/task-thinking-20260922T025233Z/`;
  SQLite quick_check passed before deployment.
- Migration applied; both services active; public login and referenced CSS
  returned HTTP 200. Unauthenticated Thinking requests were redirected to login.
- The initial deployment failed startup because the new API directory used
  `[taskId]` beside existing `[id]` routes. It was moved under `[id]` and rebuilt
  immediately. `scripts/api-route-paths-test.mjs` validates all 66 API paths using
  Next's route sorter, and is now an automatic build preflight so this conflict
  is rejected before Next modifies the build tree.
- Plugin 0.1.11 loaded by Asdrubal, Barekbaal and Carmen. Authenticated capability
  checks returned 200; Asdrubal/Carmen advertised `pm_task_note`. Barekbaal uses
  Claude CLI and correctly advertises no native task tools; it receives `/notes`
  through the compact HTTP contract. Karen's gateway was not restarted because
  no gateway change was needed for her existing stream/HTTP path. WORKFLOW.md
  was synchronized into all four agents' workspaces.
- WDT-9 was already Done. Only its remaining no-action-required Done notification
  (`ae7bf02f-e6f8-42da-bca9-2a09c0219d4c`) was canceled with gateway confirmation
  before deployment; no task work was restarted. An authorized production read
  returned ten recent runs with retained history and an earlier-page cursor;
  the run count did not change and WDT-9 remained Done.
- Isolated database, native-tool, WDT planning, compact runtime, channel lifecycle,
  workflow-boundary, customer DOM, plugin compatibility, TypeScript and Chromium
  checks passed. Browser checks included live updates, filtering, missing
  telemetry, manual-scroll preservation, tab switching, reload and access
  revocation. No production agent turn was created solely to test the UI.
