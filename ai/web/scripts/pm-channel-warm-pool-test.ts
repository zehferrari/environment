import assert from "node:assert/strict";
import {
  acquirePmChannelWarmAgent,
  __resetPmChannelWarmPoolForTests,
  pmChannelWarmPoolKey,
  pmChannelWarmPoolSnapshot,
} from "@/lib/agents/pm-channel-warm-pool";
import { buildPmChannelIngressPayload, type PmChannelReplyTarget } from "@/lib/agents/openclaw-pm-channel";

const env = {
  PM_CHANNEL_WARM_POOL_ENABLED: "1",
  PM_CHANNEL_WARM_POOL_TTL_MS: "60000",
  PM_CHANNEL_WARM_POOL_MAX_ENTRIES: "2",
} as unknown as NodeJS.ProcessEnv;

const target: PmChannelReplyTarget = {
  kind: "task-comment",
  agentSlug: "asdrubal",
  taskId: "task-1",
  messageId: "msg-1",
  projectSlug: "environment",
};

const baseArgs = {
  gatewayPort: 65535,
  agentSlug: "asdrubal",
  sessionKey: "pm:environment:task-1:turn:msg-1",
  kind: "task-comment" as const,
  text: "hello",
  actor: { id: "tester", username: "tester", kind: "agent" as const },
  replyTarget: target,
};

__resetPmChannelWarmPoolForTests();

const key = pmChannelWarmPoolKey(baseArgs);
assert.equal(
  key,
  "pm-warm:asdrubal:task-comment:task:task-1:pm:environment:task-1",
  "warm key is stable per agent/kind/thread and strips per-message turn suffix",
);

const first = acquirePmChannelWarmAgent({ ...baseArgs, env, now: 1_000 });
assert.equal(first.hit, false, "first acquire is a warm-pool miss");
assert.equal(first.hint.status, "miss");
assert.match(first.hint.sessionKey, /^pm:environment:task-1:warm:/);
first.release(true);

const second = acquirePmChannelWarmAgent({
  ...baseArgs,
  sessionKey: "pm:environment:task-1:turn:msg-2",
  replyTarget: { ...target, messageId: "msg-2" },
  env,
  now: 2_000,
});
assert.equal(second.hit, true, "same recent thread reuses the warm entry");
assert.equal(second.hint.status, "hit");
assert.equal(second.hint.sessionKey, first.hint.sessionKey, "warm session key remains stable across per-message turns");

const payload = buildPmChannelIngressPayload({
  ...baseArgs,
  warmAgent: second.hint,
});
assert.deepEqual(payload.warmAgent, second.hint, "ingress payload carries the warm-agent hint to OpenClaw");
second.release(true);

const third = acquirePmChannelWarmAgent({
  ...baseArgs,
  sessionKey: "pm:environment:task-2:turn:msg-3",
  replyTarget: { ...target, taskId: "task-2", messageId: "msg-3" },
  env,
  now: 3_000,
});
third.release(true);
const fourth = acquirePmChannelWarmAgent({
  ...baseArgs,
  sessionKey: "pm:environment:task-3:turn:msg-4",
  replyTarget: { ...target, taskId: "task-3", messageId: "msg-4" },
  env,
  now: 4_000,
});
fourth.release(true);
assert.equal(pmChannelWarmPoolSnapshot(4_000).length, 2, "warm pool enforces conservative LRU cap");

const failed = acquirePmChannelWarmAgent({ ...baseArgs, env, now: 5_000 });
failed.release(false);
assert(!pmChannelWarmPoolSnapshot(5_000).some((entry) => entry.key === failed.hint.key), "failed handoff evicts the warm entry");

const directTargetA: PmChannelReplyTarget = {
  kind: "direct",
  agentSlug: "asdrubal",
  messageId: "direct-msg-1",
};
const directTargetB: PmChannelReplyTarget = {
  kind: "direct",
  agentSlug: "asdrubal",
  messageId: "direct-msg-2",
};
__resetPmChannelWarmPoolForTests();
const directFirst = acquirePmChannelWarmAgent({
  ...baseArgs,
  kind: "direct",
  sessionKey: "pm:direct:first-active-chat:agent:asdrubal",
  replyTarget: directTargetA,
  env,
  now: 7_000,
});
assert.equal(directFirst.hit, false, "first direct acquire is a miss");
assert.equal(
  directFirst.hint.key,
  "pm-warm:asdrubal:direct:direct:asdrubal:direct-agent",
  "direct warm key is stable per agent, not per active chat anchor",
);
directFirst.release(true);
const directSecond = acquirePmChannelWarmAgent({
  ...baseArgs,
  kind: "direct",
  sessionKey: "pm:direct:second-active-chat:agent:asdrubal",
  replyTarget: directTargetB,
  env,
  now: 8_000,
});
assert.equal(directSecond.hit, true, "direct chat reuses warm entry across new chats");
assert.equal(
  directSecond.hint.sessionKey,
  directFirst.hint.sessionKey,
  "direct warm session key remains stable across new active chat anchors",
);
directSecond.release(true);

const disabled = acquirePmChannelWarmAgent({
  ...baseArgs,
  env: { ...env, PM_CHANNEL_WARM_POOL_ENABLED: "0" } as NodeJS.ProcessEnv,
  now: 6_000,
});
assert.equal(disabled.hint.status, "disabled", "warm pool can be disabled safely");

console.log("pm channel warm-pool tests passed");
