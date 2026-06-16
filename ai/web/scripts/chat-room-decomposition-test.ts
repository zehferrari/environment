import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const wrapper = readFileSync(join(root, "components/chat-room.tsx"), "utf8");
const decomposed = readFileSync(join(root, "components/chat-room-decomposed.tsx"), "utf8");

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  wrapper.includes('process.env.NEXT_PUBLIC_PM_DECOMPOSED_CHAT_ROOM === "0"'),
  "chat room wrapper must keep the legacy room behind the explicit opt-out flag",
);
assert(
  wrapper.indexOf("<LegacyChatRoom") < wrapper.indexOf("<DecomposedChatRoom"),
  "wrapper must default to the decomposed chat room, with legacy as the explicit fallback",
);

for (const component of ["MessageList", "Composer", "StreamController"]) {
  assert(
    decomposed.includes(`const ${component} = React.memo(function ${component}`),
    `${component} must be extracted behind a memo boundary`,
  );
}

const composerStart = decomposed.indexOf("const Composer = React.memo(function Composer");
const streamStart = decomposed.indexOf("const StreamController = React.memo(function StreamController");
assert(composerStart > -1 && streamStart > -1, "composer and stream controller components must exist");
const composerSource = decomposed.slice(composerStart);
assert(
  !composerSource.includes("<StreamingAgentReply"),
  "Composer must not own streaming reply state or render StreamingAgentReply",
);
assert(
  decomposed.includes('performance.mark(`pm-chat-render:composer:'),
  "Composer render-count probe must be available for stream tick verification",
);
assert(
  decomposed.includes('performance.mark(`pm-chat-render:stream-controller:'),
  "StreamController render-count probe must be available for stream tick verification",
);

assert(
  decomposed.includes('roomId={ChatStreamManager.roomId({')
    && decomposed.includes('targetKind: taskId ? "task-chat" : "epic-chat"'),
  "task/epic action-plan streams must use ChatStreamManager room ids instead of per-message stream keys",
);

const taskCommentStreams = readFileSync(join(root, "components/task-comment-streams.tsx"), "utf8");
assert(
  taskCommentStreams.includes('targetKind="task-comment"')
    && taskCommentStreams.includes('roomId={ChatStreamManager.roomId({')
    && taskCommentStreams.includes('router.refresh()'),
  "task comment streams must use ChatStreamManager room ids and refresh when terminal replies land",
);

const persistentStreamProvider = readFileSync(join(root, "components/persistent-pm-stream-provider.tsx"), "utf8");
assert(
  persistentStreamProvider.includes('return `pm-stream:v1:${record.key}:${record.activeTargetKey}`;')
    && persistentStreamProvider.includes("if (record.activeTargetKey !== nextTargetKey)")
    && persistentStreamProvider.includes("teardownRecord(record);"),
  "room streams must isolate cross-tab coordination by active target and reset the coordinator when retargeting",
);

assert(
  decomposed.includes('const VIRTUAL_MESSAGE_ESTIMATED_HEIGHT')
    && decomposed.includes('const VIRTUAL_MESSAGE_OVERSCAN')
    && decomposed.includes('function useVirtualizedMessageRows'),
  "MessageList must use a dependency-free virtualized row window",
);
assert(
  decomposed.includes('data-virtualized-message-list="true"')
    && decomposed.includes('virtualMessages.map')
    && decomposed.includes('topSpacer')
    && decomposed.includes('bottomSpacer'),
  "MessageList must render only the visible slice plus spacer padding",
);
assert(
  decomposed.includes('getMessageGroupState(displayedMessages, index)')
    && decomposed.includes('<DeletedMessageDivider')
    && decomposed.includes('<ProposalReview')
    && decomposed.includes('<StreamController'),
  "virtualization must preserve grouping, soft deletes, proposals, and streaming rows",
);
assert(
  decomposed.includes('new ResizeObserver(updateHeight)')
    && decomposed.includes('container.scrollTop += delta')
    && decomposed.includes('container.scrollTop = container.scrollHeight'),
  "measured row heights must handle dynamic resizes without visible scroll jumps",
);

console.log("chat-room decomposition contract ok");
