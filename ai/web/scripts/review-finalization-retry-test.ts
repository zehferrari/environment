import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "review-finalization-retry-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const spool = path.join(sandbox, "spool");
  process.env.DATABASE_URL = dbUrl;
  process.env.PM_EPIC_MERGE_DIR = spool;
  process.env.AUTH_SECRET = "review-finalization-retry-test-secret";

  try {
    await execFileP("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
    });

    const { db } = await import("@/lib/db");
    const { completeReviewedTaskAndAssignNext } = await import("@/lib/tasks/review-automation");
    const { recordTaskReviewOperationalError } = await import("@/lib/tasks/review-handoff");

    const project = await db.project.create({
      data: {
        slug: "finalization-retry",
        name: "Finalization retry",
        repositoryPath: "/tmp/finalization-retry-repository",
      },
    });
    const reviewerAgent = await db.agent.create({
      data: { slug: "reviewer", name: "Reviewer", role: "coding" },
    });
    const reviewer = await db.user.create({
      data: {
        username: "reviewer",
        email: "reviewer@example.test",
        kind: "agent",
        agentId: reviewerAgent.id,
      },
    });
    const monitorAgent = await db.agent.create({
      data: { slug: "monitor", name: "Monitor", role: "monitor" },
    });
    const monitor = await db.user.create({
      data: {
        username: "monitor",
        email: "monitor@example.test",
        kind: "agent",
        agentId: monitorAgent.id,
      },
    });
    const candidateSha = "a".repeat(40);
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Retry accepted cleanup",
        status: "Review",
        actingManagerId: reviewer.id,
      },
    });
    await db.taskRepositoryRun.create({
      data: {
        taskId: task.id,
        phase: "finalizing",
        repoTouched: true,
        baseSha: "b".repeat(40),
        candidateSha,
        reviewedSha: candidateSha,
        validationOutcome: "valid_with_warning",
      },
    });
    const review = await db.reviewRun.create({
      data: {
        taskId: task.id,
        candidateSha,
        repoTouched: true,
        validationOutcome: "valid_with_warning",
        status: "accepted",
        reviewerId: reviewer.id,
        reviewedAt: new Date(),
      },
    });

    await recordTaskReviewOperationalError({
      taskId: task.id,
      actor: { id: reviewer.id, username: reviewer.username, kind: "agent" },
      error: "worktree cleanup permission denied",
      preserveValidationOutcome: true,
    });
    const failed = await db.taskRepositoryRun.findUniqueOrThrow({ where: { taskId: task.id } });
    assert.equal(failed.phase, "operational_error");
    assert.equal(
      failed.validationOutcome,
      "valid_with_warning",
      "cleanup trouble must not erase the accepted candidate's validation outcome",
    );

    const unauthorized = await completeReviewedTaskAndAssignNext({
      taskId: task.id,
      actor: { id: monitor.id, username: monitor.username, kind: "agent" },
      via: "unauthorized-monitor-test",
    });
    assert.equal(unauthorized.completed, false);
    assert.equal(unauthorized.reason, "not_reviewer", "a monitor cannot directly accept Review");

    const first = await completeReviewedTaskAndAssignNext({
      taskId: task.id,
      actor: { id: reviewer.id, username: reviewer.username, kind: "agent" },
      via: "retry-test",
      requireReviewerUserId: reviewer.id,
    });
    assert.equal(first.completed, true);
    assert.equal(first.finalizing, true);
    assert.equal(first.status, "Review");

    const retried = await db.taskRepositoryRun.findUniqueOrThrow({ where: { taskId: task.id } });
    assert.equal(retried.phase, "finalizing");
    assert.equal(retried.validationOutcome, "valid_with_warning");
    assert.equal(retried.lastError, null);
    assert.equal(
      (await db.reviewRun.findUniqueOrThrow({ where: { id: review.id } })).status,
      "accepted",
      "retrying cleanup must retain the immutable accepted review lease",
    );
    assert.equal(
      await db.activityLog.count({ where: { taskId: task.id, kind: "task.review.finalization_retry" } }),
      1,
    );
    assert.equal(
      await db.workflowOutbox.count({ where: { taskId: task.id, effectType: "review_finalize" } }),
      1,
    );
    assert.equal((await readdir(spool)).filter((name) => name.endsWith(".json")).length, 1);

    const replay = await completeReviewedTaskAndAssignNext({
      taskId: task.id,
      actor: { id: reviewer.id, username: reviewer.username, kind: "agent" },
      via: "retry-test-replay",
      requireReviewerUserId: reviewer.id,
    });
    assert.equal(replay.completed, true);
    assert.equal(replay.finalizing, true);
    assert.equal(
      await db.activityLog.count({ where: { taskId: task.id, kind: "task.review.finalization_retry" } }),
      1,
      "an idempotent retry must not enqueue another finalization attempt",
    );

    await db.taskRepositoryRun.update({
      where: { taskId: task.id },
      data: { phase: "completed" },
    });
    const finalized = await completeReviewedTaskAndAssignNext({
      taskId: task.id,
      actor: { id: monitor.id, username: monitor.username, kind: "agent" },
      via: "repository-finalization-test",
      repositoryFinalized: true,
    });
    assert.equal(finalized.completed, true);
    assert.equal(finalized.finalizing, false);
    const transition = await db.workflowTransition.findFirstOrThrow({
      where: { taskId: task.id, intent: "accept_review" },
    });
    assert.equal(
      transition.actorUserId,
      reviewer.id,
      "mechanical monitor cleanup must attribute Done to the accepted reviewer",
    );
    assert.equal(
      (JSON.parse(transition.evidence ?? "{}") as { finalizedByUserId?: string }).finalizedByUserId,
      monitor.id,
      "the operational finalizer remains explicit audit evidence",
    );

    await db.$disconnect();
    console.log("[review-finalization-retry] PASS");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
