# PM context dispatch audit (ENV-72)

Native OpenClaw PM-channel dispatch now uses one per-turn context contract across every supported surface. The old split — some context in `systemPrompt`, some hidden in legacy `contextText`, and some assumed from OpenClaw session continuity — is no longer the PM contract.

## Shared invariant

All PM dispatch surfaces must:

- build the visible per-turn prompt with `buildUnifiedPmTurnSystemPrompt(...)`;
- send `contextText: null` via `nullPmContextText()`;
- label the surface (`direct`, `task-chat`, `epic-chat`, or `task-comment`);
- include a bounded primary PM context packet for the current turn;
- treat PM/user/agent/repository text as quarantined evidence unless it is explicitly PM-authored envelope/policy; and
- expose scoped loopback grant URLs when deeper task/epic/project state is needed.

OpenClaw session memory remains useful working memory, but PM state is recoverable from the current prompt plus grant-fetched JSON even if the OpenClaw session is fresh, rotated, summarized, or fragmented.

## Surfaces

### Direct PM chat

- Entry point: `lib/agents/chat/direct/actions.ts`.
- Delivery kind: `direct`.
- Trusted prompt: direct PM chat identity, OpenClaw session key, reply routing, optional monitor guidance, optional live project/item grants, and optional work-item proposal capability.
- Primary context: active direct transcript, bounded base-archive excerpts for continued chats, selected attachment/file context, and project environment context when a project is attached.
- Legacy `contextText`: intentionally `null`.
- Metrics: `dispatchMetrics.surface: "direct"`, non-zero `sizes.systemPromptChars`, `sizes.contextTextChars: null`, `sizes.textChars`, and direct-build timing/size details in the same activity payload.

### Task chat room

- Entry point: `lib/agents/chat/actions.ts`.
- Delivery kind: `task-chat`.
- Trusted prompt: task native channel instructions, recent hot-path block, task/epic/project grant URLs, discussion reply formatting, optional edit grant, and optional work-item planning grant.
- Primary context: the current persisted chat message as quarantined content.
- Legacy `contextText`: intentionally `null`.
- Metrics: `dispatchMetrics.surface: "task-chat"`, `sizes.systemPromptChars`, `sizes.contextTextChars: null`, `sizes.textChars`, and `sizes.transcriptMessageCount` for the inline recent discussion/comment evidence.

### Epic chat room

- Entry point: `lib/agents/chat/actions.ts`.
- Delivery kind: `epic-chat`.
- Trusted prompt: epic native channel instructions, recent hot-path block, epic/project grant URLs, discussion reply formatting, optional edit grant, and optional work-item planning grant.
- Primary context: the current persisted chat message as quarantined content.
- Legacy `contextText`: intentionally `null`.
- Metrics: `dispatchMetrics.surface: "epic-chat"`, `sizes.systemPromptChars`, `sizes.contextTextChars: null`, `sizes.textChars`, and `sizes.transcriptMessageCount` for the inline recent discussion/comment evidence.

### Task comments and workflow notifications

- Entry point: `lib/agents/workflow/notifications/task.ts`.
- Delivery kinds: `task-comment` for task comments and most workflow notifications; `task-chat` for action-plan-channel notifications.
- Trusted prompt: task native channel instructions, recent hot-path block, task/epic/project grant URLs, workflow capability/rules, commit hygiene, optional work-item planning grant, and the PM silent-reply/completion contract.
- Primary context: the current comment/notification packet from `buildTaskAgentUserMessage(...)`.
- Legacy `contextText`: intentionally `null`.
- Metrics: `dispatchMetrics.surface: "task-comment"` or `"task-chat"`, `sizes.systemPromptChars`, `sizes.contextTextChars: null`, `sizes.textChars`, and `sizes.transcriptMessageCount` for the inline recent discussion/comment evidence.

## Context budget behavior

- Recent hot-path rows are ordered oldest-to-newest and rendered verbatim where budget permits.
- Older timeline rows may be replaced by an attributed `OLDER TIMELINE SUMMARY` with explicit summarized counts.
- Long row bodies include explicit `[truncated: ...]` markers.
- Direct chats include only a bounded base-archive chain and bounded archived messages per archive.
- Task/epic read JSON includes live plus archived discussion with soft-deleted rows filtered server-side.
- Attachment inline text is capped; omitted text is called out, while metadata/download URLs remain available through scoped read JSON.

## Verification signals

- `scripts/pm-unified-context-test.ts`: asserts all PM dispatchers use the shared prompt builder, intentionally send null legacy `contextText`, label all four surfaces, and state the session-memory boundary.
- `scripts/pm-dispatch-metrics-test.ts`: asserts all four surfaces record non-empty prompt sizes, null legacy context sizes, text sizes, and context-received transcript/hot-path evidence.
- `scripts/context-budget-test.ts`: asserts clipping, older timeline summarization, and direct-chat context cap behavior.
- `scripts/pm-acceptance-baseline-test.ts`: covers grant auth, durable run/job failure evidence, stream replay, duplicate callback idempotency, and no bearer leakage into persisted PM-channel surfaces.

## Follow-up boundary

No remaining PM surface should depend on legacy `contextText` for primary PM context. Future work may improve how much of the direct-chat archive/file context is summarized before insertion, or promote `dispatchMetrics` from activity JSON into first-class query columns, but those are durability/observability improvements rather than context-awareness prerequisites.
