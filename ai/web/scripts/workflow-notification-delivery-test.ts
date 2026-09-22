import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pm-notification-delivery-"));
  process.env.DATABASE_URL = `file:${sandbox}/test.db`;
  process.env.AUTH_SECRET = "isolated-notification-test";
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.PM_TASK_RUNTIME_V2 = "1";
  process.env.PM_AGENT_CONFIG_ROOT = `${sandbox}/agents`;
  await mkdir(`${sandbox}/agents/reviewer`, { recursive: true });
  await writeFile(`${sandbox}/agents/reviewer/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: "openai/test" } } } }));
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { drainWorkflowOutbox } = await import("@/lib/tasks/workflow-outbox-drain");
    const { enqueueWorkflowEffects, applyTaskTransition } = await import("@/lib/tasks/transition-kernel");
    const { supersedeObsoleteTaskNotifications } = await import("@/lib/tasks/notification-reconciliation");
    const { agentDeliveryOutcome, obsoleteTaskNotificationReason } = await import("@/lib/tasks/notification-policy");
    const { executionStateForWorkflowAction } = await import("@/lib/agents/watchdog/transitions");
    const owner = await db.user.create({ data: { username: "owner", email: "owner@notification.invalid", kind: "human", isOwner: true } });
    const agent = await db.agent.create({ data: { slug: "reviewer", name: "Reviewer", role: "coding" } });
    const reviewer = await db.user.create({ data: { username: "reviewer", email: "reviewer@notification.invalid", kind: "agent", agentId: agent.id } });
    const inactive = await db.user.create({ data: { username: "inactive", email: "inactive@notification.invalid", kind: "agent", status: "inactive" } });
    const project = await db.project.create({ data: { slug: "notifications", name: "Notifications" } });
    const task = await db.task.create({ data: { projectId: project.id, title: "Review request", status: "Review", reporterId: owner.id, actingManagerId: reviewer.id } });
    const actor = { id: owner.id, kind: "human", username: owner.username };
    const enqueue = async (key: string, targetUserId: string, reason = "review_requested") => {
      await enqueueWorkflowEffects(db, { taskId: task.id, projectId: project.id, aggregateVersion: 0, effects: [{
        type: "task_notification", key, payload: { taskId: task.id, targetUserId, actor, reason, body: "Review this task." },
      }] });
      return db.workflowOutbox.findUniqueOrThrow({ where: { dedupeKey: `${task.id}:v0:${key}` } });
    };
    const humanRow = await enqueue("human", owner.id);
    assert.deepEqual(await drainWorkflowOutbox(), { completed: 1, retried: 0, failed: 0 });
    assert.equal(await db.agentChatMessage.count(), 0, "human delivery must not create an agent turn");
    assert.equal(await db.activityLog.count({ where: { kind: "task.workflow.human_notification" } }), 1);
    await enqueue("human", owner.id);
    assert.equal((await drainWorkflowOutbox()).completed, 0);
    await db.workflowOutbox.update({ where: { id: humanRow.id }, data: { status: "queued" } });
    await drainWorkflowOutbox();
    assert.equal(await db.activityLog.count({ where: { kind: "task.workflow.human_notification" } }), 1, "lost settlement replay is deduplicated");
    console.log("PASS human delivery, no agent wake, durable replay deduplication");

    await enqueue("agent", reviewer.id);
    assert.deepEqual(await drainWorkflowOutbox(), { completed: 1, retried: 0, failed: 0 });
    assert.equal(await db.agentChatMessage.count(), 1, "agent reviewer gets a normal queued turn");
    const bad = await enqueue("inactive", inactive.id);
    assert.deepEqual(await drainWorkflowOutbox(), { completed: 0, retried: 0, failed: 1 });
    assert.equal((await db.workflowOutbox.findUniqueOrThrow({ where: { id: bad.id } })).attempts, 1);
    assert.equal(agentDeliveryOutcome({ ok: false, status: 503 }).status, "retryable_failure");
    assert.equal(agentDeliveryOutcome({ ok: false, status: 429 }).status, "retryable_failure");
    assert.equal(agentDeliveryOutcome({ ok: false, error: "timeout" }).status, "retryable_failure");
    assert.equal(agentDeliveryOutcome({ ok: false, status: 403 }).status, "permanent_failure");
    assert.equal(agentDeliveryOutcome({ ok: true, status: 202 }).status, "delivered");
    console.log("PASS agent reviewer, inactive recipient, transient and permanent outcomes");

    const obsolete = await enqueue("historical", owner.id);
    await db.workflowOutbox.update({ where: { id: obsolete.id }, data: { status: "failed", attempts: 8, lastError: "original failure" } });
    const failure = await db.activityLog.create({ data: { taskId: task.id, projectId: project.id, kind: "task.workflow.effect_failed", payload: JSON.stringify({ outboxId: obsolete.id, error: "original failure" }) } });
    await db.task.update({ where: { id: task.id }, data: { alertReporter: true } });
    await db.taskExecutionState.create({ data: { taskId: task.id, state: "stalled", reasonCode: "outbox_delivery_failed", escalatedAt: new Date(), recoveryCount: 3 } });
    const transition = { taskId: task.id, projectId: project.id, actorUserId: owner.id, from: "Review" as const, to: "Done" as const, intent: "accept_review" as const, source: "test", idempotencyKey: "completion", expectedVersion: 0 };
    await db.$transaction((tx) => applyTaskTransition(tx, transition));
    assert.equal((await db.$transaction((tx) => applyTaskTransition(tx, transition))).replayed, true);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).alertReporter, false);
    const state = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: task.id } });
    assert.equal(state.reasonCode, "task_done");
    assert.equal(state.escalatedAt, null);
    assert.equal(state.recoveryCount, 0);
    assert.equal((await db.workflowOutbox.findUniqueOrThrow({ where: { id: obsolete.id } })).status, "superseded");
    const historical = JSON.parse((await db.activityLog.findUniqueOrThrow({ where: { id: failure.id } })).payload!);
    assert.equal(historical.error, "original failure");
    assert.equal(historical.resolution.status, "superseded");
    assert.equal(await db.$transaction((tx) => supersedeObsoleteTaskNotifications(tx, task.id)), 0);
    await enqueue("late-review", reviewer.id);
    assert.deepEqual(await drainWorkflowOutbox(), { completed: 1, retried: 0, failed: 0 });
    assert.equal(await db.agentChatMessage.count(), 1, "stale review wake cannot dispatch after Done");
    assert.equal(obsoleteTaskNotificationReason("review_requested", "Review", "old-cycle", "new-cycle"), "workflow_cycle_superseded");
    assert.equal(executionStateForWorkflowAction({ action: "flag_blocker", status: "Done", blockedExternally: true }).state, "idle");
    console.log("PASS Done cleanup, duplicate transition, historical errors and obsolete notification suppression");

    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { runProcedureRunner } = await import("@/lib/tasks/orchestrator/procedure-runner");
    const { registerFinalizeAcceptedReviewHandlers } = await import("@/lib/tasks/orchestrator/handlers/review-decisions");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");
    registerFinalizeAcceptedReviewHandlers();
    const epic = await db.epic.create({ data: { projectId: project.id, title: "Ranked queue", status: "In Progress", actingManagerId: owner.id } });
    await db.epicWorker.create({ data: { epicId: epic.id, userId: reviewer.id } });
    const previous = await db.task.create({ data: { projectId: project.id, epicId: epic.id, title: "Prerequisite", status: "Review", assigneeId: reviewer.id, actingManagerId: owner.id, reporterId: owner.id } });
    const dependent = await db.task.create({ data: { projectId: project.id, epicId: epic.id, title: "Next by rank", status: "To Do", rank: 1, reporterId: owner.id } });
    const later = await db.task.create({ data: { projectId: project.id, epicId: epic.id, title: "Later independent task", status: "To Do", rank: 7, reporterId: owner.id } });
    await db.taskDependency.create({ data: { taskId: dependent.id, prerequisiteTaskId: previous.id } });
    await db.$transaction(async (tx) => {
      const cycle = await openTaskWorkflowCycle(tx, { taskId: previous.id, openedWorkflowVersion: 0 });
      await tx.reviewRun.create({ data: { taskId: previous.id, workflowCycleId: cycle.id, status: "awaiting_review", candidateSha: "candidate", baseSha: "base", repoTouched: false, validationOutcome: "valid" } });
    });
    const command = { taskId: previous.id, intent: "accept_review" as const, actor: { ...actor, kind: "human" as const }, expectedWorkflowVersion: 0, idempotencyKey: "accept-epic-child", source: "browser" as const, payload: { reviewRunId: (await db.reviewRun.findFirstOrThrow({ where: { taskId: previous.id } })).id, candidateSha: "candidate" } };
    const accepted = await submitWorkflowCommand(command);
    assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
    assert.equal((await submitWorkflowCommand(command)).status, "replayed");
    for (let i = 0; i < 15; i++) if ((await runProcedureRunner({ limit: 5 })).claimed === 0) break;
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: previous.id } })).status, "Done");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: dependent.id } })).assigneeId, reviewer.id);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: later.id } })).assigneeId, null);
    const effects = await db.workflowOutbox.findMany({ where: { taskId: previous.id, effectType: "task_notification" } });
    assert.equal(effects.filter((row) => JSON.parse(row.payload).reason === "review_done").length, 0,
      "a next-task assignment replaces the redundant completion-only wake");
    console.log("PASS completion replay and newly unblocked Epic task chosen in rank order");
  } finally {
    await db.$disconnect();
    await rm(sandbox, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
