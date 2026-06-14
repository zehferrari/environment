import assert from "node:assert/strict";
import {
  checkPmChannelCallbackRateLimit,
  resetPmChannelCallbackRateLimitsForTest,
} from "@/lib/agents/pm-channel/rate-limit";

const limits = { agent: 3, target: 2, windowMs: 1_000 };

resetPmChannelCallbackRateLimitsForTest();
assert.equal(
  checkPmChannelCallbackRateLimit({
    kind: "reply",
    agentSlug: "asdrubal",
    targetKey: "direct:asdrubal:msg-1",
    nowMs: 0,
    limits,
  }).allowed,
  true,
);
assert.equal(
  checkPmChannelCallbackRateLimit({
    kind: "reply",
    agentSlug: "asdrubal",
    targetKey: "direct:asdrubal:msg-1",
    nowMs: 0,
    limits,
  }).allowed,
  true,
);
const blockedTarget = checkPmChannelCallbackRateLimit({
  kind: "reply",
  agentSlug: "asdrubal",
  targetKey: "direct:asdrubal:msg-1",
  nowMs: 0,
  limits,
});
assert.equal(blockedTarget.allowed, false);
if (!blockedTarget.allowed) assert.equal(blockedTarget.retryAfterSeconds, 1);

const afterRefill = checkPmChannelCallbackRateLimit({
  kind: "reply",
  agentSlug: "asdrubal",
  targetKey: "direct:asdrubal:msg-1",
  nowMs: 1_000,
  limits,
});
assert.equal(afterRefill.allowed, true, "target bucket should refill after window");

resetPmChannelCallbackRateLimitsForTest();
assert.equal(checkPmChannelCallbackRateLimit({
  kind: "stream",
  agentSlug: "asdrubal",
  targetKey: "task-chat:asdrubal:task-1:msg-1",
  nowMs: 0,
  limits,
}).allowed, true);
assert.equal(checkPmChannelCallbackRateLimit({
  kind: "stream",
  agentSlug: "asdrubal",
  targetKey: "task-chat:asdrubal:task-2:msg-2",
  nowMs: 0,
  limits,
}).allowed, true);
assert.equal(checkPmChannelCallbackRateLimit({
  kind: "stream",
  agentSlug: "asdrubal",
  targetKey: "task-chat:asdrubal:task-3:msg-3",
  nowMs: 0,
  limits,
}).allowed, true);
const blockedAgent = checkPmChannelCallbackRateLimit({
  kind: "stream",
  agentSlug: "asdrubal",
  targetKey: "task-chat:asdrubal:task-4:msg-4",
  nowMs: 0,
  limits,
});
assert.equal(blockedAgent.allowed, false, "agent bucket should cap cross-target floods");

console.log("pm channel rate limit tests passed");
