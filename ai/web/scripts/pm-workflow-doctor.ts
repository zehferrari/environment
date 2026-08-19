// Read-only by default. --apply performs only the reconciler's bounded safe
// repairs: reclaim/requeue an existing durable effect or retry an existing
// process-cancellation fence. It never invents a transition from comments.
//
// PHASEE-10 — Expanded with Phase E readiness checks:
//   - Engine ownership distribution
//   - Receipt replay/conflict counts
//   - Procedure status summary
//   - Legacy invocation count (from task.workflow.legacy_boundary.invoked)
//   - Cohort coverage
//   - --json output includes a phaseE section with all Phase E-specific metrics
//   - --strict exits non-zero if any Phase E invariant violation is detected

import { runWorkflowReconciliation } from "@/lib/tasks/workflow-reconciler";
import { getCohortSummary, getLegacyInvocationSummary } from "@/lib/tasks/orchestrator/dashboard-data";
import { db } from "@/lib/db";

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const apply = flag("apply");
  const projectId = option("project") ?? undefined;
  const report = await runWorkflowReconciliation({
    projectId: projectId,
    dryRun: !apply,
  });

  // PHASEE-10 — Gather Phase E specific metrics.
  const [cohortSummary, legacyInvocationSummary, engineDistribution, receiptStats, procedureStats] = await Promise.all([
    getCohortSummary(projectId),
    getLegacyInvocationSummary(projectId),
    db.task.groupBy({
      by: ["workflowEngine"],
      where: { deletedAt: null, ...(projectId ? { projectId } : {}) },
      _count: { _all: true },
    }),
    db.taskWorkflowCommandReceipt.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    db.taskProcedureRun.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  const phaseEFindings = report.findings.filter((f) =>
    f.kind === "engine_ownership_mismatch" ||
    f.kind === "stale_receipt_without_transition" ||
    f.kind === "procedure_run_without_cycle" ||
    f.kind === "dual_engine_active",
  );

  const phaseE = {
    engineOwnershipDistribution: Object.fromEntries(
      engineDistribution.map((row) => [row.workflowEngine, row._count._all]),
    ),
    receiptStats: Object.fromEntries(
      receiptStats.map((row) => [row.status, row._count._all]),
    ),
    procedureStatusSummary: Object.fromEntries(
      procedureStats.map((row) => [row.status, row._count._all]),
    ),
    legacyInvocationCount: legacyInvocationSummary.totalInvocations,
    legacyInvocationByBoundary: legacyInvocationSummary.byBoundary,
    cohortCoverage: cohortSummary,
    invariantViolations: phaseEFindings.length,
    invariantFindings: phaseEFindings.map((f) => ({
      kind: f.kind,
      taskId: f.taskId,
      detail: f.detail,
      repair: f.repair,
    })),
  };

  if (flag("json")) {
    const fullReport = {
      ...report,
      phaseE,
    };
    console.log(JSON.stringify(fullReport, null, 2));
  } else {
    console.log(
      `[pm-workflow-doctor]${apply ? "" : " (read only)"} inspected ${report.inspectedTasks} task(s): ` +
      `${report.findings.length} finding(s), ${report.repaired} repaired, ${report.escalated} escalated`,
    );
    console.log(
      `  metrics: outbox=${JSON.stringify(report.metrics.outboxByStatus)} ` +
      `repository=${JSON.stringify(report.metrics.repositoryByPhase)} ` +
      `execution=${JSON.stringify(report.metrics.executionByState)} ` +
      `cancellationPending=${report.metrics.cancellationPending} ` +
      `cycles=${JSON.stringify(report.metrics.cyclesByStatus)} ` +
      `procedures=${JSON.stringify(report.metrics.proceduresByStatus)} ` +
      `procedureSteps=${JSON.stringify(report.metrics.procedureStepsByStatus)}`,
    );
    // PHASEE-10 — Phase E section
    console.log(
      `  phaseE: engineOwnership=${JSON.stringify(phaseE.engineOwnershipDistribution)} ` +
      `receipts=${JSON.stringify(phaseE.receiptStats)} ` +
      `procedures=${JSON.stringify(phaseE.procedureStatusSummary)} ` +
      `legacyInvocations=${phaseE.legacyInvocationCount} ` +
      `invariantViolations=${phaseE.invariantViolations}`,
    );
    for (const finding of report.findings) {
      console.log(
        `  ${finding.kind} ${finding.taskId ?? finding.rowId}: ${finding.detail} ` +
        `→ ${finding.repair}${finding.repaired ? " [done]" : ""}${finding.error ? ` [${finding.error}]` : ""}`,
      );
    }
    for (const error of report.errors) console.log(`  error: ${error}`);
  }

  // --strict exits non-zero if any finding (including Phase E invariants) exists.
  if (flag("strict") && report.findings.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error("[pm-workflow-doctor] failed", error);
  process.exit(1);
});