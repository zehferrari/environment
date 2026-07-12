import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { applyPmChannelStreamCallback } from "@/lib/agents/pm-channel/stream-callback";
import { PM_SILENT_REPLY_TOKEN } from "@/lib/agents/ops/pm-silence";
import {
  applyPmChannelStreamInput,
  emptyPmChannelStreamState,
  type PmChannelStreamInput,
} from "@/lib/agents/pm-channel/stream";
import { pmChannelRunTargetKey } from "@/lib/agents/pm-channel/runs";
import { replayPmChannelStreamFrames } from "@/lib/agents/pm-channel/stream-log";

const target = {
  kind: "direct" as const,
  agentSlug: "proto-agent",
  messageId: "proto-message",
};

let state = emptyPmChannelStreamState(target);

function apply(input: Omit<PmChannelStreamInput, "target">) {
  state = applyPmChannelStreamInput(state, { target, ...input });
  return state;
}

assert.equal(state.lifecycleStatus, null, "fresh streams have no guessed lifecycle status");

apply({ event: "status:thinking" });
assert.equal(state.lifecycleStatus, "thinking", "status:thinking sets an explicit thinking lifecycle status");
assert.equal(state.status, "streaming");

apply({ event: "status:reading" });
assert.equal(state.lifecycleStatus, "reading", "status:reading replaces the lifecycle status");

apply({ event: "tool:call", toolName: "memory_search" });
assert.equal(state.lifecycleStatus, "working", "tool calls are active work");
assert.equal(state.toolStatus, "call");
assert.equal(state.toolName, "memory_search");

apply({ event: "tool:result", toolName: "memory_search" });
assert.equal(state.toolStatus, "result");
assert.equal(state.toolName, "memory_search");

apply({ event: "token", delta: "hello" });
assert.equal(state.text, "hello", "token events append text like legacy partial events");
assert.equal(state.runStatus, "streaming");

apply({ event: "final", text: "hello world", replace: true });
assert.equal(state.text, "hello world");
assert.equal(state.status, "done");
assert.equal(state.runStatus, "complete");
assert.equal(state.error, null);

state = emptyPmChannelStreamState(target);
apply({ event: "status", statusKind: "working", runStatus: "accepted" });
assert.equal(state.lifecycleStatus, "working", "legacy status events can carry typed lifecycle status");
assert.equal(state.runStatus, "accepted");

async function assertCallbackProtocolBoundary() {
  const agentSlug = `stream-${Date.now().toString(36)}`;
  const agent = await db.agent.create({
    data: { slug: agentSlug, name: "Stream Protocol Agent", role: "coding" },
  });
  const agentUser = await db.user.create({
    data: {
      username: agentSlug,
      email: `${agentSlug}@stream-test.local`,
      kind: "agent",
      agentId: agent.id,
      status: "active",
    },
  });
  const owner = await db.user.create({
    data: {
      username: `${agentSlug}-owner`,
      email: `${agentSlug}-owner@stream-test.local`,
      kind: "human",
      status: "active",
      isOwner: true,
      mustRotatePassword: false,
    },
  });
  const original = await db.directAgentChatMessage.create({
    data: { agentSlug, senderUserId: owner.id, body: "stream protocol test" },
    select: { id: true },
  });
  const callbackTarget = {
    kind: "direct" as const,
    agentSlug,
    messageId: original.id,
  };
  const forged = await applyPmChannelStreamCallback({
    payload: {
      target: { kind: "direct", agentSlug, messageId: "unissued-stream-turn" },
      event: "status",
    },
    rateLimit: false,
    transportMode: "http",
  });
  assert.equal(forged.status, 403, "stream callback must reject a target without a dispatched run");
  const targetKey = pmChannelRunTargetKey(callbackTarget);
  await db.pmChannelRun.create({
    data: {
      targetKey,
      kind: "direct",
      agentSlug,
      messageId: original.id,
      status: "accepted",
      acceptedAt: new Date(),
      lastEventAt: new Date(),
    },
  });

  const post = (payload: Record<string, unknown>) => applyPmChannelStreamCallback({
    payload: { target: callbackTarget, ...payload },
    rateLimit: false,
    transportMode: "http",
  });

  let result = await post({ event: "status", statusKind: "reading" });
  assert.equal(result.status, 200, "callback accepts legacy status events with statusKind metadata");

  result = await post({ event: "status:working" });
  assert.equal(result.status, 200, "callback accepts typed lifecycle status events");

  result = await post({ event: "tool:call", toolStatus: "call", toolName: "memory_search" });
  assert.equal(result.status, 200, "callback accepts typed tool call events");

  result = await post({ event: "token", delta: "hello" });
  assert.equal(result.status, 200, "callback accepts token events");

  result = await post({ event: "token", delta: PM_SILENT_REPLY_TOKEN });
  assert.equal(result.status, 200, "callback accepts token events before silent-text guard");
  assert.equal(result.body.silent, true, "callback suppresses silent token text without persisting it");

  const run = await db.pmChannelRun.findUniqueOrThrow({
    where: { targetKey },
    select: { id: true },
  });
  const rows = await db.pmChannelStreamEvent.findMany({
    where: { runId: run.id },
    orderBy: { seq: "asc" },
    select: { kind: true, payload: true },
  });
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["status", "status:working", "tool:call", "token"],
    "callback persists the typed protocol events and does not persist silent token text",
  );

  const statusPayload = JSON.parse(rows[0].payload) as Record<string, unknown>;
  assert.equal(statusPayload.statusKind, "reading", "callback preserves statusKind metadata");
  const toolPayload = JSON.parse(rows[2].payload) as Record<string, unknown>;
  assert.equal(toolPayload.toolStatus, "call", "callback preserves toolStatus metadata");
  assert.equal(toolPayload.toolName, "memory_search", "callback preserves toolName metadata");

  const frames = await replayPmChannelStreamFrames({ runId: run.id, target: callbackTarget, afterSeq: 0 });
  const finalState = frames.at(-1)?.state;
  assert.equal(finalState?.lifecycleStatus, "working", "callback-persisted events replay into typed lifecycle state");
  assert.equal(finalState?.toolStatus, "call", "callback-persisted events replay into typed tool state");
  assert.equal(finalState?.toolName, "memory_search", "callback-persisted events replay tool names");
  assert.equal(finalState?.text, "hello", "callback-persisted token events replay as streamed text");

  await db.pmChannelRun.deleteMany({ where: { targetKey } });
  await db.directAgentChatMessage.deleteMany({ where: { agentSlug } });
  await db.user.delete({ where: { id: agentUser.id } });
  await db.user.delete({ where: { id: owner.id } });
  await db.agent.delete({ where: { id: agent.id } });
}

assertCallbackProtocolBoundary()
  .then(async () => {
    await db.$disconnect();
    console.log("pm channel stream typed protocol tests passed");
  })
  .catch(async (err) => {
    await db.$disconnect();
    console.error(err);
    process.exit(1);
  });
