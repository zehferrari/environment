/**
 * Ghost-run reconciliation script (ENV-117).
 *
 * One-time migration to find existing non-terminal PmChannelRuns
 * (queued/accepted/streaming) older than a threshold and mark them
 * timed_out or superseded as appropriate.
 *
 * Usage:
 *   npx tsx scripts/reconcile-ghost-runs.ts [--dry-run] [--max-age-hours=6]
 *
 * In dry-run mode, prints the runs that would be reconciled without
 * modifying them. Exit 0 always (non-fatal by design).
 */

import { db } from "@/lib/db";

const DEFAULT_MAX_AGE_HOURS = 6;
const TERMINAL_STATUSES = ["completed", "failed", "timed_out", "cancelled", "superseded"];

function parseMaxAgeHours(): number {
  const arg = process.argv.find((a) => a.startsWith("--max-age-hours="));
  if (!arg) return DEFAULT_MAX_AGE_HOURS;
  const value = Number.parseFloat(arg.split("=")[1]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_AGE_HOURS;
}

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

async function main(): Promise<void> {
  const dryRun = isDryRun();
  const maxAgeHours = parseMaxAgeHours();
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

  console.log(`[ghost-reconcile] ${dryRun ? "DRY RUN: " : ""}Finding non-terminal runs older than ${maxAgeHours}h (before ${cutoff.toISOString()})`);

  // Find all non-terminal runs older than the cutoff.
  // These are "ghost runs" — runs that never reached a terminal state.
  const ghostRuns = await db.pmChannelRun.findMany({
    where: {
      status: { in: ["queued", "accepted", "streaming"] },
      lastEventAt: { lt: cutoff },
    },
    select: {
      id: true,
      targetKey: true,
      status: true,
      agentSlug: true,
      taskId: true,
      lastEventAt: true,
      createdAt: true,
      admittedAt: true,
      acceptedAt: true, // ENV-159: legacy compatibility read
      streamingAt: true,
    },
    orderBy: { lastEventAt: "asc" },
  });

  console.log(`[ghost-reconcile] Found ${ghostRuns.length} ghost run(s)`);

  if (ghostRuns.length === 0) {
    console.log("[ghost-reconcile] No ghost runs to reconcile.");
    return;
  }

  if (dryRun) {
    for (const run of ghostRuns) {
      console.log(
        `[ghost-reconcile] Would reconcile: id=${run.id} status=${run.status} agent=${run.agentSlug} ` +
        `lastEventAt=${run.lastEventAt?.toISOString() ?? "null"} targetKey=${run.targetKey}`,
      );
    }
    console.log(`[ghost-reconcile] DRY RUN: ${ghostRuns.length} run(s) would be marked timed_out.`);
    return;
  }

  const now = new Date();
  let reconciled = 0;
  let errors = 0;

  for (const run of ghostRuns) {
    try {
      // Check if there's a newer non-terminal run for the same (taskId, agentSlug).
      // If so, this run was effectively superseded (even if the supersede logic
      // wasn't in place when it was created). Mark it superseded.
      let supersededByNewer = false;
      if (run.taskId) {
        const newerRun = await db.pmChannelRun.findFirst({
          where: {
            taskId: run.taskId,
            agentSlug: run.agentSlug,
            status: { in: ["queued", "accepted", "streaming", "completed"] },
            createdAt: { gt: run.createdAt },
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });
        if (newerRun) {
          await db.pmChannelRun.update({
            where: { id: run.id },
            data: {
              status: "superseded",
              finishedAt: now,
              finishedReason: "ghost_reconcile_superseded",
              supersededByRunId: newerRun.id,
              lastEventAt: now,
            },
          });
          // Also settle the job if one exists
          await db.pmChannelJob.updateMany({
            where: { runId: run.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
            data: { status: "failed", completedAt: now, lastError: "ghost_reconcile: superseded by newer run" },
          });
          reconciled++;
          supersededByNewer = true;
          console.log(
            `[ghost-reconcile] Superseded: id=${run.id} status=${run.status} ` +
            `supersededBy=${newerRun.id}`,
          );
        }
      }

      if (!supersededByNewer) {
        // No newer run found — this is a genuine ghost that timed out.
        await db.pmChannelRun.update({
          where: { id: run.id },
          data: {
            status: "timed_out",
            error: "Ghost run reconciled: lease expired without terminal event.",
            failedAt: now,
            finishedAt: now,
            finishedReason: "ghost_reconcile_lease_expired",
            lastEventAt: now,
          },
        });
        // Also settle the job
        await db.pmChannelJob.updateMany({
          where: { runId: run.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
          data: { status: "failed", completedAt: now, lastError: "ghost_reconcile: lease expired" },
        });
        reconciled++;
        console.log(
          `[ghost-reconcile] Timed out: id=${run.id} status=${run.status} ` +
          `lastEventAt=${run.lastEventAt?.toISOString() ?? "null"}`,
        );
      }
    } catch (err) {
      errors++;
      console.error(
        `[ghost-reconcile] Error reconciling run id=${run.id}:`,
        err,
      );
    }
  }

  console.log(`[ghost-reconcile] Done: ${reconciled} reconciled, ${errors} error(s).`);
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[ghost-reconcile] Fatal error:", err);
    await db.$disconnect();
    process.exit(1);
  });