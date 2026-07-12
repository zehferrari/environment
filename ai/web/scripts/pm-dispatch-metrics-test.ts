import assert from "node:assert/strict";
import { buildPmChannelDispatchMetrics } from "@/lib/agents/pm-channel/openclaw";

const base = {
  gatewayPort: 3210,
  agentSlug: "asdrubal",
  sessionKey: "pm:test",
  text: "hello",
  actor: { id: "u1", username: "owner", kind: "human" as const },
};

const directMetrics = buildPmChannelDispatchMetrics({
  ...base,
  kind: "direct",
  contextText: null,
  systemPrompt: "system transcript",
  replyTarget: { kind: "direct", agentSlug: "asdrubal", messageId: "m1" },
}, 3);

assert.deepEqual(directMetrics, {
  surface: "direct",
  sizes: {
    systemPromptChars: 17,
    contextTextChars: null,
    textChars: 5,
    transcriptMessageCount: 3,
  },
});

const taskChatMetrics = buildPmChannelDispatchMetrics({
  ...base,
  kind: "task-chat",
  contextText: null,
  systemPrompt: "primary prompt",
  replyTarget: { kind: "task-chat", agentSlug: "asdrubal", taskId: "t1", messageId: "m2" },
}, 8);

assert.equal(taskChatMetrics.surface, "task-chat");
assert.equal(taskChatMetrics.sizes.contextTextChars, null);
assert.equal(taskChatMetrics.sizes.systemPromptChars, "primary prompt".length);
assert.equal(taskChatMetrics.sizes.transcriptMessageCount, 8);

const missingPromptMetrics = buildPmChannelDispatchMetrics({
  ...base,
  kind: "epic-chat",
  contextText: undefined,
  systemPrompt: undefined,
  replyTarget: { kind: "epic-chat", agentSlug: "asdrubal", epicId: "e1", messageId: "m3" },
});

assert.equal(missingPromptMetrics.sizes.systemPromptChars, 0);
assert.equal(missingPromptMetrics.sizes.contextTextChars, null);
assert.equal(missingPromptMetrics.sizes.transcriptMessageCount, null);

for (const fixture of [
  {
    kind: "direct" as const,
    replyTarget: { kind: "direct" as const, agentSlug: "asdrubal", messageId: "turn-direct" },
  },
  {
    kind: "task-chat" as const,
    replyTarget: { kind: "task-chat" as const, agentSlug: "asdrubal", taskId: "t1", messageId: "turn-task-chat" },
  },
  {
    kind: "epic-chat" as const,
    replyTarget: { kind: "epic-chat" as const, agentSlug: "asdrubal", epicId: "e1", messageId: "turn-epic-chat" },
  },
  {
    kind: "task-comment" as const,
    replyTarget: { kind: "task-comment" as const, agentSlug: "asdrubal", taskId: "t1", messageId: "turn-task-comment" },
  },
]) {
  const metrics = buildPmChannelDispatchMetrics({
    ...base,
    kind: fixture.kind,
    contextText: null,
    systemPrompt: `PM PER-TURN CONTEXT CONTRACT\nSurface: ${fixture.kind}\nPRIMARY PM CONTEXT PACKET`,
    replyTarget: fixture.replyTarget,
  }, 1);
  assert.equal(metrics.surface, fixture.kind);
  assert.equal(metrics.sizes.contextTextChars, null, `${fixture.kind} records null legacy contextText`);
  assert(metrics.sizes.systemPromptChars > 0, `${fixture.kind} records visible per-turn prompt size`);
  assert.equal(metrics.sizes.transcriptMessageCount, 1, `${fixture.kind} records context-received transcript evidence`);
}

console.log("pm-dispatch-metrics-test: ok");
