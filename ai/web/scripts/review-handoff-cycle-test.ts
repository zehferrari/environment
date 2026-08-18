import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "review-handoff-cycle-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  process.env.AUTH_SECRET = "review-handoff-cycle-test-secret";

  try {
    await execFileP("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
    });

    const { db } = await import("@/lib/db");
    const { completeTaskReviewHandoffAfterValidation } = await import("@/lib/tasks/review-handoff");

    const project = await db.project.create({
      data: { slug: "review-handoff-cycle", name: "Review handoff cycle" },
    });
    const monitorAgent = await db.agent.create({
      data: { slug: "cycle-monitor", name: "Cycle Monitor", role: "monitor" },
    });
    const monitor = await db.user.create({
      data: {
        username: "cycle-monitor",
        email: "cycle-monitor@example.test",
        kind: "agent",
        agentId: monitorAgent.id,
      },
    });
    const candidateSha = "f".repeat(40);
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Resubmit the same validated candidate",
        status: "In Progress",
        workflowVersion: 3,
      },
    });
    await db.workflowTransition.create({
      data: {
        taskId: task.id,
        workflowVersion: 1,
        intent: "submit_review",
        fromStatus: "In Progress",
        toStatus: "Review",
        actorUserId: monitor.id,
        source: "historical-review-cycle",
        idempotencyKey: `review-ready:${candidateSha}`,
      },
    });
    await db.taskRepositoryRun.create({
      data: {
        taskId: task.id,
        phase: "review_ready",
        repoTouched: true,
        baseSha: "b".repeat(40),
        candidateSha,
        validationOutcome: "valid",
      },
    });
    await db.reviewRun.create({
      data: {
        taskId: task.id,
        candidateSha,
        baseSha: "b".repeat(40),
        repoTouched: true,
        validationOutcome: "valid",
        status: "validating",
      },
    });

    const result = await completeTaskReviewHandoffAfterValidation({
      taskId: task.id,
      actor: { id: monitor.id, username: monitor.username, kind: "agent" },
      candidateSha,
      validationOutcome: "valid",
      repoTouched: true,
    });

    assert.equal(result.status, "Review");
    const moved = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(moved.status, "Review");
    assert.equal(moved.workflowVersion, 4);
    assert.equal(
      (await db.reviewRun.findFirstOrThrow({
        where: { taskId: task.id, candidateSha }, orderBy: { createdAt: "desc" },
      })).status,
      "awaiting_review",
    );
    assert.equal(
      await db.workflowTransition.count({
        where: { taskId: task.id, idempotencyKey: `review-ready:${candidateSha}:v4` },
      }),
      1,
      "the same commit must be allowed into a later workflow review cycle",
    );

    await db.$disconnect();
    console.log("[review-handoff-cycle] PASS");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
