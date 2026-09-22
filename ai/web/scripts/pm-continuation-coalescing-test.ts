import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";

async function main() {
  const dir = await mkdtemp("/tmp/pm-continuation-coalescing-");
  process.env.DATABASE_URL = `file:${dir}/test.db`;
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { claimPmChannelContinuation, drainPmChannelContinuations } = await import("@/lib/agents/pm-channel/continuation-drain");
    const { checkpointGuidance, readCheckpointGuidance } = await import("@/lib/agents/pm-channel/checkpoint-guidance");
    await db.pmChannelRun.create({ data: { id: "source", targetKey: "source", agentSlug: "worker", messageId: "m", kind: "task-comment", status: "completed" } });
    for (const action of ["checkpoint", "episode_rollover", "complete_subtask"]) {
      await db.pmChannelContinuation.create({ data: { id: action, runId: "source", agentSlug: "worker", messageId: "m", action, status: "queued" } });
    }
    const claims = await Promise.all(["checkpoint", "episode_rollover"].map(claimPmChannelContinuation));
    assert.equal(claims.filter(Boolean).length, 1, "concurrent actions claim only one successor");
    const owner = await db.pmChannelContinuation.findFirstOrThrow({ where: { status: "dispatching" } });
    assert.equal(await db.pmChannelContinuation.count({ where: { status: "superseded" } }), 2);
    await db.pmChannelContinuation.update({ where: { id: owner.id }, data: { status: "queued" } });
    assert.equal(await claimPmChannelContinuation(owner.id), true, "transport retry retains the sole obligation");
    await db.pmChannelContinuation.update({ where: { id: owner.id }, data: { status: "dispatched" } });
    await db.pmChannelContinuation.create({ data: { id: "late", runId: "source", agentSlug: "worker", messageId: "m", action: "start", status: "queued" } });
    assert.equal(await claimPmChannelContinuation("late"), false, "late callbacks cannot dispatch a second successor");
    assert.equal((await db.pmChannelContinuation.findUniqueOrThrow({ where: { id: "late" } })).status, "superseded");
    const episode = { episodeNo: 1, status: "open", toolCycleCount: 16, toolCycleBudget: 24 };
    assert.equal(checkpointGuidance(episode)?.checkpointDue, true);
    assert.equal(checkpointGuidance(episode)?.toolCallsRemaining, 8);
    assert.equal(checkpointGuidance({ ...episode, toolCycleCount: 5 })?.checkpointDue, false);
    assert.equal(checkpointGuidance({ ...episode, status: "closed" }), null);
    const project = await db.project.create({ data: { name: "Test", slug: "test" } });
    const task = await db.task.create({ data: { title: "Scoped guidance", projectId: project.id } });
    await db.taskExecutionEpisode.create({ data: { ...episode, taskId: task.id, agentSlug: "worker", messageId: "current", cycleBudget: 8 } });
    assert.equal((await readCheckpointGuidance(task.id, "worker", "current"))?.checkpointDue, true);
    assert.equal(await readCheckpointGuidance(task.id, "worker", "old"), null, "old turns cannot read a successor's guidance");
    assert.equal(await readCheckpointGuidance(task.id, "other", "current"), null);
    process.env.PM_OPENCLAW_CHANNEL_TOKEN_WORKER = "isolated-test-token";
    const { steerGatewaySession } = await import("@/lib/agents/pm-channel/supersession");
    const steer = (body: object) => steerGatewaySession({ agentSlug: "worker", gatewayPort: 1, sessionKey: "s", text: "checkpoint", fetchImpl: async () => Response.json(body) });
    assert.deepEqual(await steer({ queued: true }), { ok: true, queued: true, delivery: "live" });
    assert.deepEqual(await steer({ queued: false, delivery: "workflow_response" }), { ok: true, queued: false, delivery: "workflow_response" });
    assert.equal((await steer({ ok: true })).ok, false, "HTTP success alone is not proof of steering");
    const agent = await db.agent.create({ data: { slug: "worker", name: "Worker", role: "coding" } });
    const user = await db.user.create({ data: { username: "worker", email: "worker@coalescing.invalid", kind: "agent", agentId: agent.id } });
    await db.task.update({ where: { id: task.id }, data: { assigneeId: user.id, status: "In Progress" } });
    for (const status of ["queued", "claimed", "delivered", "waiting_capacity", "accepted", "admitted", "streaming"]) {
      const sourceId = `source-${status}`;
      await db.pmChannelRun.create({ data: { id: sourceId, targetKey: sourceId, agentSlug: "worker", messageId: sourceId, kind: "task-comment", taskId: task.id, status: "completed" } });
      await db.pmChannelRun.create({ data: { id: status, targetKey: status, agentSlug: "worker", messageId: status, kind: "task-comment", taskId: task.id, status } });
      const row = await db.pmChannelContinuation.create({ data: { runId: sourceId, taskId: task.id, agentSlug: "worker", messageId: sourceId, action: "checkpoint", status: "queued", availableAt: new Date(0) } });
      await drainPmChannelContinuations({ limit: 1 });
      assert.equal((await db.pmChannelContinuation.findUniqueOrThrow({ where: { id: row.id } })).status, "superseded", `${status} owns the continuation already`);
      await db.pmChannelRun.update({ where: { id: status }, data: { status: "completed" } });
    }
    console.log("PASS continuation concurrency, retry, late duplicate and scoped checkpoint guidance");
  } finally { await db.$disconnect(); await rm(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });
