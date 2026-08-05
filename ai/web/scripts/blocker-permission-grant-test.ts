// ENV-120 — one grant, one deterministic outcome.
//
// The invariant this suite defends: clicking "grant" on a permission blocker
// must record the grant, clear exactly the round it answers, supersede every
// competing active run for that task and agent, and reserve exactly ONE
// authorization-linked continuation — atomically, and idempotently under a
// double click. A publish_checkpoint round is the deliberate exception: it
// stays resolvable from the active blocker until its authorized attempt
// settles, because that attempt consumes the single-use authorization.

import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function databaseSlice() {
  const { db } = await import("../lib/db");
  const {
    applyBlockerPermissionGrant,
    BLOCKER_PERMISSION_SUPERSEDE_REASON,
    blockerPermissionContinuationActivityId,
  } = await import("../lib/tasks/blocker-permission-grant");
  const {
    activeFormalBlockerStatesByTask,
    activeCheckpointBlockerUsesAuthorization,
    formalBlockerNeedsExternalInput,
  } = await import("../lib/tasks/formal-blocker");

  const LIFECYCLE_KINDS = [
    "task.blocker",
    "task.extra_work.blocker",
    "task.blocker.cleared",
    "task.blocker.permission.granted",
  ];

  try {
    const reporter = await db.user.create({
      data: {
        username: "grant-reporter",
        email: "grant-reporter@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const agent = await db.agent.create({
      data: { slug: "grant-assignee", name: "Grant Assignee", role: "coding" },
    });
    const assignee = await db.user.create({
      data: {
        username: "grant-assignee",
        email: "grant-assignee@example.test",
        kind: "agent",
        agentId: agent.id,
        mustRotatePassword: false,
      },
    });
    const project = await db.project.create({ data: { slug: "grant-rounds", name: "Grant Rounds" } });

    async function seedTask(title: string) {
      return db.task.create({
        data: {
          projectId: project.id,
          title,
          status: "In Progress",
          assigneeId: assignee.id,
          reporterId: reporter.id,
          approvedOn: new Date(),
          alertReporter: true,
        },
      });
    }

    async function seedBlocker(taskId: string, kind: "reporter_approval" | "publish_checkpoint", scope: string) {
      const comment = await db.comment.create({
        data: { taskId, userId: assignee.id, body: `${kind} blocker` },
      });
      await db.activityLog.create({
        data: {
          projectId: project.id,
          taskId,
          userId: assignee.id,
          kind: "task.blocker",
          payload: JSON.stringify({
            action: "flag_blocker",
            commentId: comment.id,
            permissionRequest: { kind, scope },
            blockerReport: {
              blockedOn: "permission",
              requestedActor: "the task reporter",
              requestedAction: scope,
              evidence: "The scoped action is owner-authorized by design.",
              diagnosticsAttempted: ["No agent-side retry can grant this permission."],
              resumeCondition: `The task reporter grants "${scope}".`,
              reporterCanResolve: true,
            },
          }),
        },
      });
      return comment.id;
    }

    async function seedRun(taskId: string, messageId: string, status: string, disposition: string | null) {
      return db.pmChannelRun.create({
        data: {
          targetKey: `${taskId}:${messageId}`,
          kind: "task-comment",
          agentSlug: agent.slug,
          messageId,
          projectId: project.id,
          taskId,
          status,
          disposition,
        },
      });
    }

    const lifecycle = (taskId: string) => db.activityLog.findMany({
      where: { taskId, kind: { in: LIFECYCLE_KINDS } },
      orderBy: { createdAt: "desc" },
      select: { taskId: true, kind: true, payload: true, createdAt: true },
    });

    // ---------------- reporter_approval: the grant IS the dependency ----------------

    const approvalTask = await seedTask("Reporter approval round");
    const approvalBlocker = await seedBlocker(approvalTask.id, "reporter_approval", "Delete the stale staging bucket.");
    const staleRun = await seedRun(approvalTask.id, "msg-stale", "accepted", null);
    const streamingRun = await seedRun(approvalTask.id, "msg-streaming", "streaming", "continue");
    const finishedRun = await seedRun(approvalTask.id, "msg-finished", "completed", "completed");
    await db.pmChannelContinuation.create({
      data: {
        runId: staleRun.id,
        agentSlug: agent.slug,
        projectId: project.id,
        taskId: approvalTask.id,
        messageId: "msg-stale",
        action: "start",
        status: "armed",
      },
    });

    const granted = await applyBlockerPermissionGrant({
      taskId: approvalTask.id,
      projectId: project.id,
      actorUserId: reporter.id,
      assigneeSlug: agent.slug,
      blockerCommentId: approvalBlocker,
      permissionKind: "reporter_approval",
      permissionScope: "Delete the stale staging bucket.",
      authorizationBody: "I authorize deleting the stale staging bucket.",
    });
    assert.equal(granted.granted, true, "the first grant applies");
    assert.equal(granted.granted && granted.blockerCleared, true, "a reporter_approval round closes with its grant");
    assert.deepEqual(
      granted.granted ? [...granted.supersededRunIds].sort() : [],
      [staleRun.id, streamingRun.id].sort(),
      "every competing active run for this task and agent is superseded",
    );

    // 1. recorded
    const grantRows = await db.activityLog.count({
      where: { taskId: approvalTask.id, kind: "task.blocker.permission.granted" },
    });
    assert.equal(grantRows, 1, "the grant is recorded exactly once");

    // 2. cleared
    assert.equal(
      activeFormalBlockerStatesByTask(await lifecycle(approvalTask.id)).has(approvalTask.id),
      false,
      "the granted round leaves no open blocker",
    );
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: approvalTask.id } })).alertReporter,
      false,
      "the human alert the blocker raised is discharged by the grant",
    );

    // 3. superseded
    const afterStale = await db.pmChannelRun.findUniqueOrThrow({ where: { id: staleRun.id } });
    assert.equal(afterStale.status, "superseded", "the stale run is no longer active");
    assert.equal(afterStale.finishedReason, BLOCKER_PERMISSION_SUPERSEDE_REASON, "the supersede reason is auditable");
    assert.equal(afterStale.disposition, "waiting_external", "a run with no disposition gets one (WFI-005)");
    const afterStreaming = await db.pmChannelRun.findUniqueOrThrow({ where: { id: streamingRun.id } });
    assert.equal(afterStreaming.status, "superseded", "the streaming run is superseded too");
    assert.equal(afterStreaming.disposition, "continue", "an already-declared disposition is never overwritten");
    const afterFinished = await db.pmChannelRun.findUniqueOrThrow({ where: { id: finishedRun.id } });
    assert.equal(afterFinished.status, "completed", "an already-terminal run is left alone");
    const continuationRow = await db.pmChannelContinuation.findFirstOrThrow({ where: { runId: staleRun.id } });
    assert.equal(continuationRow.status, "superseded", "the superseded run's open continuation cannot fire a turn");

    // 4. exactly one authorization-linked continuation
    const reservation = await db.activityLog.findUniqueOrThrow({
      where: { id: blockerPermissionContinuationActivityId(approvalBlocker) },
    });
    assert.equal(reservation.kind, "task.blocker.permission.continuation", "the continuation reservation exists");
    assert.equal(
      JSON.parse(reservation.payload ?? "{}").authorizationCommentId,
      granted.granted ? granted.authorizationCommentId : null,
      "the reserved continuation is linked to this exact authorization",
    );

    // ---------------- idempotency: a double click grants once ----------------

    const second = await applyBlockerPermissionGrant({
      taskId: approvalTask.id,
      projectId: project.id,
      actorUserId: reporter.id,
      assigneeSlug: agent.slug,
      blockerCommentId: approvalBlocker,
      permissionKind: "reporter_approval",
      permissionScope: "Delete the stale staging bucket.",
      authorizationBody: "I authorize deleting the stale staging bucket.",
    });
    assert.equal(second.granted, false, "the second click does not grant again");
    assert.equal(
      await db.activityLog.count({ where: { taskId: approvalTask.id, kind: "task.blocker.permission.granted" } }),
      1,
      "still exactly one grant",
    );
    assert.equal(
      await db.activityLog.count({ where: { taskId: approvalTask.id, kind: "task.blocker.permission.continuation" } }),
      1,
      "still exactly one continuation reservation",
    );
    assert.equal(
      await db.comment.count({ where: { taskId: approvalTask.id, userId: reporter.id } }),
      1,
      "the rolled-back second transaction leaves no orphan authorization comment",
    );

    // ---------------- publish_checkpoint: the round survives its grant ----------------

    const checkpointTask = await seedTask("Checkpoint round");
    const checkpointBlocker = await seedBlocker(
      checkpointTask.id,
      "publish_checkpoint",
      "Publish the ENV-120 checkpoint to pm-workflow.",
    );
    const checkpointGrant = await applyBlockerPermissionGrant({
      taskId: checkpointTask.id,
      projectId: project.id,
      actorUserId: reporter.id,
      assigneeSlug: agent.slug,
      blockerCommentId: checkpointBlocker,
      permissionKind: "publish_checkpoint",
      permissionScope: "Publish the ENV-120 checkpoint to pm-workflow.",
      authorizationBody: "I authorize publishing the ENV-120 checkpoint.",
    });
    assert.equal(checkpointGrant.granted, true, "the checkpoint grant applies");
    assert.equal(
      checkpointGrant.granted && checkpointGrant.blockerCleared,
      false,
      "a checkpoint round is closed by its consumed attempt, not by the grant",
    );
    const checkpointState = activeFormalBlockerStatesByTask(await lifecycle(checkpointTask.id)).get(checkpointTask.id);
    assert(checkpointState, "the checkpoint blocker is still the active round");
    assert.equal(
      activeCheckpointBlockerUsesAuthorization(
        checkpointState,
        checkpointGrant.granted ? checkpointGrant.authorizationCommentId : "",
      ),
      true,
      "the single-use authorization stays resolvable from the active blocker",
    );
    assert.equal(
      formalBlockerNeedsExternalInput(checkpointState),
      false,
      "a granted checkpoint round is agent-actionable, not human-blocked",
    );
    assert.equal(
      await db.activityLog.count({ where: { taskId: checkpointTask.id, kind: "task.blocker.permission.continuation" } }),
      1,
      "the checkpoint grant also reserves exactly one continuation",
    );
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  if (process.env.BLOCKER_PERMISSION_GRANT_DB_SLICE === "1") {
    await databaseSlice();
    return;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), "blocker-permission-grant-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const env = { ...process.env, DATABASE_URL: dbUrl, BLOCKER_PERMISSION_GRANT_DB_SLICE: "1" };
  try {
    await execFileP("pnpm", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env,
    });
    await execFileP("pnpm", ["exec", "tsx", "scripts/blocker-permission-grant-test.ts"], {
      cwd: process.cwd(),
      env,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log("blocker permission grant tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
