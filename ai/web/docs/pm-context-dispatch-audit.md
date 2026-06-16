# PM context dispatch audit (ENV-72.1)

Baseline for native OpenClaw PM-channel dispatch surfaces. This slice is observational only: it records metrics around the payloads already being sent and does not change context delivery.

## Surfaces

### Direct PM chat

- Entry point: `lib/agents/chat/direct/actions.ts`.
- Delivery kind: `direct`.
- Context delivery today:
  - `systemPrompt` identifies the direct PM chat, OpenClaw session key, reply routing expectations, optional monitor-role guidance, optional live-fetch project grants, and optional work-item planning grant.
  - `contextText` is the primary inline transcript packet: current direct session transcript, optional base-archive excerpts, optional file context, and optional project environment context.
  - This matches the current direct-chat stopgap: transcript is inline in `contextText` rather than relying on a separate live fetch.
- Metrics emitted in activity payloads under `dispatchMetrics`:
  - `surface: "direct"`
  - `sizes.systemPromptChars`
  - `sizes.contextTextChars`
  - `sizes.textChars`
  - `sizes.transcriptMessageCount`

### Task chat room

- Entry point: `lib/agents/chat/actions.ts`.
- Delivery kind: `task-chat`.
- Context delivery today:
  - `systemPrompt` is primary. It includes task native channel instructions, a recent hot-path block, loopback task/epic/project context grant URLs, discussion reply formatting, optional edit grant, and optional work-item planning grant.
  - `contextText` is intentionally `null`.
  - Full task/project context remains available through scoped live-fetch grants.
- Metrics emitted in activity payloads under `dispatchMetrics`:
  - `surface: "task-chat"`
  - `sizes.systemPromptChars`
  - `sizes.contextTextChars: null`
  - `sizes.textChars`
  - `sizes.transcriptMessageCount` for the inline recent discussion/comment slice.

### Epic chat room

- Entry point: `lib/agents/chat/actions.ts`.
- Delivery kind: `epic-chat`.
- Context delivery today:
  - `systemPrompt` is primary. It includes epic native channel instructions, a recent hot-path block, loopback epic/project context grant URLs, discussion reply formatting, optional edit grant, and optional work-item planning grant.
  - `contextText` is intentionally `null`.
  - Full epic/project context remains available through scoped live-fetch grants.
- Metrics emitted in activity payloads under `dispatchMetrics`:
  - `surface: "epic-chat"`
  - `sizes.systemPromptChars`
  - `sizes.contextTextChars: null`
  - `sizes.textChars`
  - `sizes.transcriptMessageCount` for the inline recent discussion/comment slice.

### Task comments and workflow notifications

- Entry point: `lib/agents/workflow/notifications/task.ts`.
- Delivery kinds: `task-comment` for task comments and most workflow notifications; `task-chat` for action-plan-channel notifications.
- Context delivery today:
  - `systemPrompt` includes task native channel instructions, recent hot-path block, task/epic/project live-fetch grants, workflow capability/rules, commit hygiene, and optional work-item planning grant.
  - `contextText` contains the current turn packet from `buildTaskAgentUserMessage(...)`, including the current comment/notification and live PM context packet.
  - This differs from task/epic chat room messages: task-comment workflow delivery still uses non-null `contextText` for the PM context packet.
- Metrics emitted in activity payloads under `dispatchMetrics`:
  - `surface: "task-comment"` or `"task-chat"`
  - `sizes.systemPromptChars`
  - `sizes.contextTextChars`
  - `sizes.textChars`
  - `sizes.transcriptMessageCount` for the inline recent discussion/comment slice.

## Named follow-ups for later ENV-72 slices

- `ENV-72.followup.task-comment-contextText`: decide whether task-comment/workflow notification turns should converge with task/epic chat-room delivery (`contextText:null`, prompt/live-fetch primary) or keep the current PM context packet in `contextText`.
- `ENV-72.followup.direct-primary-context`: replace the direct-chat inline transcript stopgap with the eventual robust per-surface context delivery mechanism once the target design is ready.
- `ENV-72.followup.metrics-durability`: if dashboard/query requirements need structured columns, promote `dispatchMetrics` out of JSON activity payloads into first-class persisted fields; this slice keeps metrics observational and schema-free.
