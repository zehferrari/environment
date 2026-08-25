// PHASEE-05 — authoritative command + PM execution bookkeeping atomicity.
//
// Disposable SQLite coverage for the six crash/recovery boundaries in §14:
// before transaction; after transition/procedure but before continuation;
// after execution bookkeeping but before receipt; after commit before response;
// continuation publication; and successor dispatch/retry.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { TaskWorkflowCommand } from "@/lib/tasks/orchestrator/types";
import type { WorkflowCommandCrashBoundary } from "@/lib/agents/workflow/transactional-action";

const execFileP = promisify(execFile);

async function freshDb() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "phasee05-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  return { dbUrl, cleanup: () => rm(sandbox, { recursive: true, force: true }) };
}

async function main() {
  const { dbUrl, cleanup } = await freshDb();
  process.env.DATABASE_URL = dbUrl;
  process.env.PM_EPISODE_MAX_CYCLES = "1";
  process.env.PM_EPISODE_MAX_TOOL_CYCLES = "10";
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.AUTH_SECRET = "phasee05-test-secret";

  try {
    const { db } = await import("@/lib/db");
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { __setWorkflowCommandCrashHook } = await import(
      "@/lib/agents/workflow/transactional-action"
    );
    const { pmChannelRunTargetKey } = await import("@/lib/agents/pm-channel/runs");
    const { queuePmChannelContinuationsForRun } = await import(
      "@/lib/agents/pm-channel/continuations"
    );
    const { drainPmChannelContinuations } = await import(
      "@/lib/agents/pm-channel/continuation-drain"
    );

    const owner = await db.user.create({
      data: {
        username: "owner",
        email: "owner@phasee05.invalid",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const agent = await db.agent.create({
      data: { slug: "episode-agent", name: "Episode Agent", role: "coding" },
    });
    const assignee = await db.user.create({
      data: {
        username: "episode-agent",
        email: "episode-agent@phasee05.invalid",
        kind: "agent",
        agentId: agent.id,
      },
    });
    const project = await db.project.create({
      data: { slug: "phasee05", name: "PHASEE-05" },
    });

    const messageId = "phasee05-source-message";
    const target = {
      kind: "task-comment" as const,
      agentSlug: agent.slug,
      taskId: "",
      messageId,
    };
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Atomic episode command",
        status: "To Do",
        workflowVersion: 1,
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: assignee.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        approvedById: owner.id,
      },
    });
    target.taskId = task.id;
    const plan = await db.actionPlan.create({
      data: {
        taskId: task.id,
        summary: "Atomic plan",
        version: 1,
        status: "approved",
        authorId: assignee.id,
        contentHash: "phasee05-plan",
        approvedOn: new Date(),
        approvedById: owner.id,
      },
    });
    await db.actionPlanStep.create({
      data: {
        actionPlanId: plan.id,
        stepId: "atomic-step",
        title: "Apply atomically",
        acceptanceCriteria: "[]",
        kind: "sequential",
        rank: 0,
      },
    });
    const run = await db.pmChannelRun.create({
      data: {
        targetKey: pmChannelRunTargetKey(target),
        kind: target.kind,
        agentSlug: agent.slug,
        messageId,
        projectId: project.id,
        taskId: task.id,
        status: "admitted",
        admittedAt: new Date(),
      },
    });
    await db.pmChannelJob.create({
      data: {
        runId: run.id,
        agentSlug: agent.slug,
        kind: target.kind,
        payload: "{}",
        status: "accepted",
      },
    });

    const startCommand: TaskWorkflowCommand = {
      taskId: task.id,
      intent: "start_implementation",
      actor: {
        id: assignee.id,
        kind: "agent",
        username: agent.slug,
        role: "assignee",
        codingCapability: true,
      },
      expectedWorkflowVersion: 1,
      idempotencyKey: "phasee05:start",
      source: "agent",
      messageId,
      executionContext: {
        agentSlug: agent.slug,
        pmChannelRunId: run.id,
        sourceMessageId: messageId,
        publicAction: "start",
        expectedEpisodeId: null,
      },
      payload: {},
    };

    async function assertNoAcceptedStart(label: string) {
      const [taskRow, cycles, transitions, procedures, receipts, episodes, continuations] =
        await Promise.all([
          db.task.findUniqueOrThrow({ where: { id: task.id } }),
          db.taskWorkflowCycle.count({ where: { taskId: task.id } }),
          db.workflowTransition.count({ where: { taskId: task.id } }),
          db.taskProcedureRun.count({ where: { taskId: task.id } }),
          db.taskWorkflowCommandReceipt.count({ where: { taskId: task.id } }),
          db.taskExecutionEpisode.count({ where: { taskId: task.id } }),
          db.pmChannelContinuation.count({ where: { taskId: task.id } }),
        ]);
      assert.equal(taskRow.status, "To Do", `${label}: task transition rolled back`);
      assert.equal(taskRow.workflowVersion, 1, `${label}: workflow version rolled back`);
      assert.equal(cycles, 0, `${label}: no cycle`);
      assert.equal(transitions, 0, `${label}: no transition`);
      assert.equal(procedures, 0, `${label}: no procedure`);
      assert.equal(receipts, 0, `${label}: no receipt`);
      assert.equal(episodes, 0, `${label}: no episode`);
      assert.equal(continuations, 0, `${label}: no continuation fragment`);
    }

    async function crashAt(boundary: WorkflowCommandCrashBoundary) {
      __setWorkflowCommandCrashHook((seen) => {
        if (seen === boundary) throw new Error(`injected:${boundary}`);
      });
      const result = await submitWorkflowCommand(startCommand);
      __setWorkflowCommandCrashHook(null);
      assert.equal(
        result.status,
        "operational",
        `${boundary}: injected crash surfaced; got ${JSON.stringify(result)}`,
      );
      await assertNoAcceptedStart(boundary);
    }

    await crashAt("before_command_transaction");
    await crashAt("after_domain_writes_before_execution_bookkeeping");
    await crashAt("after_execution_bookkeeping_before_receipt_projection");

    // Every authenticated identity component is fenced by the command
    // transaction. Each failed variant must leave the same empty baseline.
    const mismatches: TaskWorkflowCommand[] = [
      {
        ...startCommand,
        idempotencyKey: "phasee05:wrong-run",
        executionContext: {
          ...startCommand.executionContext!,
          pmChannelRunId: "missing-run",
        },
      },
      {
        ...startCommand,
        idempotencyKey: "phasee05:wrong-message",
        messageId: "wrong-message",
        executionContext: {
          ...startCommand.executionContext!,
          sourceMessageId: "wrong-message",
        },
      },
      {
        ...startCommand,
        idempotencyKey: "phasee05:wrong-agent",
        actor: { ...startCommand.actor, username: "different-agent" },
      },
      {
        ...startCommand,
        idempotencyKey: "phasee05:wrong-action",
        executionContext: {
          ...startCommand.executionContext!,
          publicAction: "checkpoint",
        },
      },
      {
        ...startCommand,
        idempotencyKey: "phasee05:wrong-episode",
        executionContext: {
          ...startCommand.executionContext!,
          expectedEpisodeId: "missing-episode",
        },
      },
    ];
    for (const command of mismatches) {
      const result = await submitWorkflowCommand(command);
      assert.ok(
        result.status === "invalid" || result.status === "stale",
        `mismatched context rejected; got ${JSON.stringify(result)}`,
      );
      await assertNoAcceptedStart(command.idempotencyKey);
    }

    // Crash immediately after commit: the caller sees an operational failure,
    // but replay returns the stored projection and performs no second write.
    __setWorkflowCommandCrashHook((seen) => {
      if (seen === "after_commit_before_response") throw new Error("injected:post-commit");
    });
    const lostResponse = await submitWorkflowCommand(startCommand);
    __setWorkflowCommandCrashHook(null);
    assert.equal(lostResponse.status, "operational", "post-commit response was lost");

    const [startedTask, episodes, receipt, runAfterStart] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: task.id } }),
      db.taskExecutionEpisode.findMany({
        where: { taskId: task.id, agentSlug: agent.slug },
        orderBy: { episodeNo: "asc" },
      }),
      db.taskWorkflowCommandReceipt.findUniqueOrThrow({
        where: {
          taskId_idempotencyKey: {
            taskId: task.id,
            idempotencyKey: startCommand.idempotencyKey,
          },
        },
      }),
      db.pmChannelRun.findUniqueOrThrow({ where: { id: run.id } }),
    ]);
    assert.equal(startedTask.status, "In Progress", "post-commit transition survived");
    assert.equal(episodes.length, 2, "rollover closed N and opened exactly one N+1");
    assert.equal(episodes[0].status, "closed", "episode N closed");
    assert.equal(episodes[1].status, "open", "episode N+1 opened");
    assert.equal(episodes[0].barrierReleasedAt, null, "successor remains checkpoint-gated");
    assert.equal(runAfterStart.disposition, "continue", "run disposition committed");
    assert.equal(
      await db.pmChannelContinuation.count({
        where: { taskId: task.id, status: { in: ["armed", "queued", "dispatching"] } },
      }),
      0,
      "rollover did not publish a successor before its final checkpoint",
    );
    const storedStart = JSON.parse(receipt.result) as Record<string, unknown>;
    assert.equal(storedStart.disposition, "continue", "receipt stores disposition");
    assert.equal(
      (storedStart.episode as { rolledOver?: boolean }).rolledOver,
      true,
      "receipt stores rollover projection",
    );

    const replayedStart = await submitWorkflowCommand(startCommand);
    assert.equal(replayedStart.status, "replayed", "post-commit retry replays receipt");
    assert.equal(
      (replayedStart as unknown as { disposition: string }).disposition,
      "continue",
      "replay preserves stored disposition",
    );
    assert.equal(
      (replayedStart as unknown as { episode: { episodeNo: number } }).episode.episodeNo,
      episodes[0].episodeNo,
      "replay preserves stored episode projection",
    );
    assert.equal(
      await db.workflowTransition.count({ where: { taskId: task.id } }),
      1,
      "replay did not create a second transition",
    );

    // The fenced turn's one remaining command is its final checkpoint. It
    // seals episode N and arms exactly one successor continuation in the same
    // transaction as the no-status command receipt.
    const checkpointCommand: TaskWorkflowCommand = {
      taskId: task.id,
      intent: "checkpoint",
      actor: startCommand.actor,
      expectedWorkflowVersion: startedTask.workflowVersion,
      workflowCycleId: startedTask.activeWorkflowCycleId,
      idempotencyKey: "phasee05:final-checkpoint",
      source: "agent",
      messageId,
      executionContext: {
        ...startCommand.executionContext!,
        publicAction: "checkpoint",
        expectedEpisodeId: episodes[0].id,
      },
      payload: {
        completedWork: ["atomic start committed"],
        evidence: ["receipt and episode share one transaction"],
        openChecklist: ["dispatch successor"],
        nextAction: "resume in episode 2",
        risks: [],
      },
    };
    __setWorkflowCommandCrashHook((seen) => {
      if (seen === "after_commit_before_response") {
        throw new Error("injected:checkpoint-post-commit");
      }
    });
    const lostCheckpointResponse = await submitWorkflowCommand(checkpointCommand);
    __setWorkflowCommandCrashHook(null);
    assert.equal(
      lostCheckpointResponse.status,
      "operational",
      "final-checkpoint response loss surfaced",
    );
    const sealed = await db.taskExecutionEpisode.findUniqueOrThrow({
      where: { id: episodes[0].id },
    });
    assert.ok(sealed.barrierReleasedAt, "final checkpoint consumed the barrier");
    assert.equal(sealed.nextAction, "resume in episode 2", "agent checkpoint was not overwritten");
    const successorRows = await db.pmChannelContinuation.findMany({
      where: { taskId: task.id, action: "episode_rollover" },
    });
    assert.equal(successorRows.length, 1, "exactly one successor continuation armed");
    assert.equal(successorRows[0].status, "armed", "successor waits for source turn settle");

    const checkpointReplay = await submitWorkflowCommand(checkpointCommand);
    assert.equal(checkpointReplay.status, "replayed", "final checkpoint replayed");
    assert.equal(
      (checkpointReplay as unknown as { episode: { episodeNo: number } }).episode.episodeNo,
      episodes[0].episodeNo,
      "final checkpoint replay names fenced episode N",
    );
    assert.equal(
      await db.pmChannelContinuation.count({
        where: { taskId: task.id, action: "episode_rollover" },
      }),
      1,
      "checkpoint replay did not arm a duplicate successor",
    );

    // Outbox publication crash: queueing is durable on its own, and receipt
    // replay while the worker is down cannot duplicate it.
    assert.equal(
      await queuePmChannelContinuationsForRun({ runId: run.id }),
      1,
      "source turn settlement published the successor outbox row",
    );
    await db.pmChannelRun.update({
      where: { id: run.id },
      data: { status: "completed", completedAt: new Date(), finishedAt: new Date() },
    });
    await submitWorkflowCommand(checkpointCommand);
    assert.equal(
      await db.pmChannelContinuation.count({
        where: { taskId: task.id, action: "episode_rollover" },
      }),
      1,
      "publication/replay crash window retained one outbox row",
    );

    // Successor dispatch failure: a temporarily deactivated agent makes the
    // real drain requeue the claimed row. Restoring the agent and retrying
    // dispatches one successor turn, never two.
    await db.agent.update({ where: { id: agent.id }, data: { deactivatedAt: new Date() } });
    const failedDispatch = await drainPmChannelContinuations({
      limit: 1,
      now: new Date(Date.now() + 120_000),
    });
    assert.equal(failedDispatch.failed, 1, "dispatch failure was observed");
    const retryable = await db.pmChannelContinuation.findUniqueOrThrow({
      where: { id: successorRows[0].id },
    });
    assert.equal(retryable.status, "queued", "failed successor dispatch remained retryable");
    await db.agent.update({ where: { id: agent.id }, data: { deactivatedAt: null } });
    const recoveredDispatch = await drainPmChannelContinuations({
      limit: 1,
      now: new Date(Date.now() + 10 * 60_000),
    });
    assert.equal(recoveredDispatch.dispatched, 1, "successor dispatch recovered");
    const dispatched = await db.pmChannelContinuation.findUniqueOrThrow({
      where: { id: successorRows[0].id },
    });
    assert.equal(dispatched.status, "dispatched", "successor outbox settled dispatched");
    assert.ok(dispatched.dispatchedMessageId, "successor turn has one message id");
    assert.equal(
      await db.activityLog.count({
        where: { taskId: task.id, kind: "task.workflow.continuation" },
      }),
      1,
      "successor dispatch produced one durable continuation activity",
    );

    console.log("[orch-phasee-05] PASS — atomic command/run/episode recovery held");
  } finally {
    const { __setWorkflowCommandCrashHook } = await import(
      "@/lib/agents/workflow/transactional-action"
    );
    __setWorkflowCommandCrashHook(null);
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[orch-phasee-05] FAIL:", error);
  process.exit(1);
});
