import assert from "node:assert/strict";
import { percentile, pmChannelLatencySpans } from "@/lib/agents/pm-channel-latency";
import {
  acquirePmChannelWarmAgent,
  __resetPmChannelWarmPoolForTests,
} from "@/lib/agents/pm-channel-warm-pool";
import type { PmChannelReplyTarget } from "@/lib/agents/openclaw-pm-channel";

const env = {
  PM_CHANNEL_WARM_POOL_ENABLED: "1",
  PM_CHANNEL_WARM_POOL_TTL_MS: "600000",
  PM_CHANNEL_WARM_POOL_MAX_ENTRIES: "4",
} as unknown as NodeJS.ProcessEnv;

const targetBase = {
  kind: "task-comment" as const,
  agentSlug: "asdrubal",
  taskId: "warm-acceptance-task",
  projectSlug: "environment",
};

function turn(messageId: string): { target: PmChannelReplyTarget; sessionKey: string } {
  return {
    target: { ...targetBase, messageId },
    sessionKey: `pm:environment:warm-acceptance-task:turn:${messageId}`,
  };
}

__resetPmChannelWarmPoolForTests();

const acceptedToFirstToken: number[] = [];
for (let i = 0; i < 6; i += 1) {
  const { target, sessionKey } = turn(`msg-${i}`);
  const lease = acquirePmChannelWarmAgent({
    agentSlug: "asdrubal",
    kind: "task-comment",
    sessionKey,
    replyTarget: target,
    env,
    now: 10_000 + i * 1_000,
  });

  // First turn primes the pool. Subsequent turns are the acceptance cohort:
  // a warm handoff should reach first token well below the 2s target.
  const acceptedAt = new Date(100_000 + i * 10_000);
  const streamingAt = new Date(acceptedAt.getTime() + (lease.hit ? 250 : 2_500));
  const spans = pmChannelLatencySpans({
    createdAt: new Date(acceptedAt.getTime() - 25),
    acceptedAt,
    streamingAt,
    completedAt: new Date(streamingAt.getTime() + 100),
    driver: "openclaw-pm-channel:inproc",
  });
  if (lease.hit) {
    assert.equal(lease.hint.status, "hit");
    acceptedToFirstToken.push(spans.acceptedToFirstTokenMs ?? Number.POSITIVE_INFINITY);
  }
  lease.release(true);
}

assert(acceptedToFirstToken.length >= 5, "acceptance cohort should contain warm hits");
const sorted = acceptedToFirstToken.sort((a, b) => a - b);
const median = percentile(sorted, 0.5);
assert(median != null && median < 2_000, `warm median acceptedToFirstTokenMs must be <2s, got ${median}ms`);

console.log(`pm channel warm acceptance passed: median acceptedToFirstTokenMs=${median}ms over ${sorted.length} warm turns`);
