import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "workflow-reconciler-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  process.env.PM_WORKFLOW_RECONCILE_STALE_MS = "60000";
  try {
    await execFileP("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    const { db } = await import("@/lib/db");
    const { runWorkflowReconciliation } = await import("@/lib/tasks/workflow-reconciler");
    const project = await db.project.create({ data: { slug: "reconcile", name: "Reconcile" } });
    const stale = new Date(Date.now() - 5 * 60_000);
    const now = new Date();

    const validating = await db.task.create({
      data: { projectId: project.id, title: "Lost verification projection", status: "In Progress" },
    });
    await db.taskRepositoryRun.create({
      data: { taskId: validating.id, phase: "validating", updatedAt: stale },
    });
    const verifyEffect = await db.workflowOutbox.create({
      data: {
        taskId: validating.id,
        projectId: project.id,
        aggregateVersion: 0,
        effectType: "branch_verify",
        payload: JSON.stringify({ job: { jobId: "verify-test" } }),
        dedupeKey: "verify-test",
        status: "completed",
        completedAt: stale,
        updatedAt: stale,
      },
    });

    const missingLease = await db.task.create({
      data: { projectId: project.id, title: "Review without candidate lease", status: "Review" },
    });
    await db.taskRepositoryRun.create({
      data: { taskId: missingLease.id, phase: "review_ready" },
    });

    const incompleteDone = await db.task.create({
      data: { projectId: project.id, title: "Prematurely done", status: "Done" },
    });
    await db.taskRepositoryRun.create({
      data: { taskId: incompleteDone.id, phase: "finalizing" },
    });

    const dry = await runWorkflowReconciliation({ projectId: project.id, now, dryRun: true });
    assert(dry.findings.some((row) => row.kind === "repository_projection_stale" && row.taskId === validating.id));
    assert(dry.findings.some((row) => row.kind === "review_lease_missing" && row.taskId === missingLease.id));
    assert(dry.findings.some((row) => row.kind === "done_repository_incomplete" && row.taskId === incompleteDone.id));
    assert.equal((await db.workflowOutbox.findUniqueOrThrow({ where: { id: verifyEffect.id } })).status, "completed");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: missingLease.id } })).alertReporter, false);

    const applied = await runWorkflowReconciliation({ projectId: project.id, now, dryRun: false });
    assert(applied.repaired >= 3);
    assert.equal((await db.workflowOutbox.findUniqueOrThrow({ where: { id: verifyEffect.id } })).status, "queued");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: missingLease.id } })).alertReporter, true);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: incompleteDone.id } })).alertReporter, true);
    assert.equal(
      await db.activityLog.count({ where: { kind: "task.workflow.reconciliation_required" } }),
      2,
    );

    await runWorkflowReconciliation({ projectId: project.id, now, dryRun: false });
    assert.equal(
      await db.activityLog.count({ where: { kind: "task.workflow.reconciliation_required" } }),
      2,
      "a repeated pass must not duplicate escalation audit rows",
    );

    await db.$disconnect();
    console.log("[workflow-reconciler] PASS");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
