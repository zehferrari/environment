import { readFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const cacheSource = readFileSync(join(root, "lib/agents/speculative-context.ts"), "utf8");
const actionsSource = readFileSync(join(root, "lib/agents/chat-actions.ts"), "utf8");
const decomposedComposer = readFileSync(join(root, "components/chat-room-decomposed.tsx"), "utf8");
const legacyComposer = readFileSync(join(root, "components/legacy-chat-room.tsx"), "utf8");

for (const [name, source] of [
  ["decomposed composer", decomposedComposer],
  ["legacy composer", legacyComposer],
] as const) {
  assert(
    source.includes("useState(() => generateClientMessageId())")
      && source.includes('name="messageId" value={draftMessageId}'),
    `${name} must keep a stable draft message id for prebuilt grants`,
  );
  assert(
    source.includes("window.setTimeout")
      && source.includes("prebuildAgentChatContext(formData)")
      && source.includes("Speculative context is best-effort"),
    `${name} must debounce speculative prebuild and treat it as best-effort`,
  );
}

assert(
  actionsSource.includes("export async function prebuildAgentChatContext")
    && actionsSource.includes("scheduleSpeculativeAgentChatContext"),
  "chat-actions must expose a server action for speculative context prebuild",
);
assert(
  actionsSource.includes("consumeSpeculativeAgentChatContext")
    && actionsSource.includes("prebuiltContext?.baseSystemPrompt ??"),
  "send path must consume cache hits and preserve synchronous fallback",
);

for (const token of [
  "PM_SPECULATIVE_CONTEXT_TTL_MS",
  "PM_SPECULATIVE_CONTEXT_DEBOUNCE_MS",
  "pending.set",
  "cache.set",
  "cache.delete(key)",
]) {
  assert(cacheSource.includes(token), `speculative cache must include ${token}`);
}

for (const invalidator of [
  "db.comment.aggregate",
  "db.agentChatMessage.aggregate",
  "db.activityLog.aggregate",
  "db.attachment.count",
  "db.projectMember.aggregate",
  "db.user.aggregate",
]) {
  assert(cacheSource.includes(invalidator), `revision must include ${invalidator}`);
}

assert(
  cacheSource.includes("resolveTargets")
    && cacheSource.includes("resolveDirectedFromDiscussionRow")
    && cacheSource.includes("createContextGrantUrl"),
  "prebuild must resolve exact targets and reuse existing context grants/prompts",
);

console.log("speculative context tests passed");
