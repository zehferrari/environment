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
    activeFormalBlockerStatesByTask,
    formalBlockerNeedsExternalInput,
  } = await import("../lib/tasks/formal-blocker");
  const { settleConsumedCheckpointBlocker } = await import("../lib/tasks/checkpoint-blocker");

  try {
    const owner = await db.user.create({
      data: {
        username: "checkpoint-owner",
        email: "checkpoint-owner@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const codingAgent = await db.agent.create({
      data: { slug: "checkpoint-assignee", name: "Checkpoint Assignee", role: "coding" },
    });
    const assignee = await db.user.create({
      data: {
        username: "checkpoint-assignee",
        email: "checkpoint-assignee@example.test",
        kind: "agent",
        agentId: codingAgent.id,
        mustRotatePassword: false,
      },
    });
    const monitorAgent = await db.agent.create({
      data: { slug: "checkpoint-monitor", name: "Checkpoint Monitor", role: "monitor" },
    });
    const monitor = await db.user.create({
      data: {
        username: "checkpoint-monitor",
        email: "checkpoint-monitor@example.test",
        kind: "agent",
        agentId: monitorAgent.id,
        mustRotatePassword: false,
      },
    });
    const project = await db.project.create({ data: { slug: "checkpoint-rounds", name: "Checkpoint Rounds" } });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Repeated checkpoint lifecycle",
        status: "In Progress",
        assigneeId: assignee.id,
        reporterId: owner.id,
        approvedOn: new Date(),
      },
    });

    const raiseAndGrant = async (round: number) => {
      const blockerComment = await db.comment.create({
        data: { taskId: task.id, userId: assignee.id, body: `round ${round} blocker` },
      });
      await db.activityLog.create({
        data: {
          projectId: project.id,
          taskId: task.id,
          userId: assignee.id,
          kind: "task.blocker",
          payload: JSON.stringify({
            commentId: blockerComment.id,
            permissionRequest: {
              kind: "publish_checkpoint",
              scope: `Publish checkpoint round ${round}.`,
            },
          }),
        },
      });
      await db.task.update({ where: { id: task.id }, data: { alertReporter: true } });
      const authorization = await db.comment.create({
        data: { taskId: task.id, userId: owner.id, body: `authorization ${round}` },
      });
      await db.activityLog.create({
        data: {
          projectId: project.id,
          taskId: task.id,
          userId: owner.id,
          kind: "task.blocker.permission.granted",
          payload: JSON.stringify({
            blockerCommentId: blockerComment.id,
            permissionKind: "publish_checkpoint",
            authorizationCommentId: authorization.id,
          }),
        },
      });
      return { blockerComment, authorization };
    };

    const lifecycle = async () => db.activityLog.findMany({
      where: {
        taskId: task.id,
        kind: { in: ["task.blocker", "task.blocker.cleared", "task.blocker.permission.granted"] },
      },
      orderBy: { createdAt: "desc" },
      select: { taskId: true, kind: true, payload: true, createdAt: true },
    });

    const first = await raiseAndGrant(1);
    const firstActive = activeFormalBlockerStatesByTask(await lifecycle()).get(task.id)!;
    assert.equal(firstActive.commentId, first.blockerComment.id);
    assert.equal(formalBlockerNeedsExternalInput(firstActive), false, "a grant makes round one actionable");

    const firstSettlement = await settleConsumedCheckpointBlocker({
      taskId: task.id,
      projectId: project.id,
      authorizationCommentId: first.authorization.id,
      requestedByUsername: assignee.username,
      actor: { id: monitor.id, username: monitor.username },
      outcome: "checkpoint_published",
      evidence: "published sha first",
    });
    assert.equal(firstSettlement.cleared, true);
    assert.equal(activeFormalBlockerStatesByTask(await lifecycle()).has(task.id), false, "success closes round one");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).alertReporter, false);

    const duplicate = await settleConsumedCheckpointBlocker({
      taskId: task.id,
      projectId: project.id,
      authorizationCommentId: first.authorization.id,
      requestedByUsername: assignee.username,
      actor: { id: monitor.id, username: monitor.username },
      outcome: "checkpoint_published",
      evidence: "duplicate runner callback",
    });
    assert.equal(duplicate.cleared, false, "settlement is idempotent after the round closes");

    const second = await raiseAndGrant(2);
    const secondSettlement = await settleConsumedCheckpointBlocker({
      taskId: task.id,
      projectId: project.id,
      authorizationCommentId: second.authorization.id,
      requestedByUsername: assignee.username,
      actor: { id: monitor.id, username: monitor.username },
      outcome: "checkpoint_failed",
      evidence: "remote push failed",
    });
    assert.equal(secondSettlement.cleared, true, "failure also consumes and closes round two");
    assert.equal(activeFormalBlockerStatesByTask(await lifecycle()).has(task.id), false);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).alertReporter, true, "failure remains visible without pausing execution ownership");

    const thirdBlocker = await db.comment.create({
      data: { taskId: task.id, userId: assignee.id, body: "round 3 blocker" },
    });
    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: task.id,
        userId: assignee.id,
        kind: "task.blocker",
        payload: JSON.stringify({
          commentId: thirdBlocker.id,
          permissionRequest: { kind: "publish_checkpoint", scope: "Publish checkpoint round 3." },
        }),
      },
    });
    const thirdActive = activeFormalBlockerStatesByTask(await lifecycle()).get(task.id)!;
    assert.equal(thirdActive.commentId, thirdBlocker.id);
    assert.equal(thirdActive.permissionGrant, null, "round three cannot inherit either spent grant");
    assert.equal(formalBlockerNeedsExternalInput(thirdActive), true, "round three renders a fresh grant action");

    const clears = await db.activityLog.count({ where: { taskId: task.id, kind: "task.blocker.cleared" } });
    assert.equal(clears, 2, "exactly one close event is recorded per consumed round");
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  if (process.env.CHECKPOINT_BLOCKER_DB_SLICE === "1") {
    await databaseSlice();
    return;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), "checkpoint-blocker-lifecycle-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const env = { ...process.env, DATABASE_URL: dbUrl, CHECKPOINT_BLOCKER_DB_SLICE: "1" };
  try {
    await execFileP("pnpm", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env,
    });
    await execFileP("pnpm", ["exec", "tsx", "scripts/checkpoint-blocker-lifecycle-test.ts"], {
      cwd: process.cwd(),
      env,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log("checkpoint blocker lifecycle tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
