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
//   - --since=<ISO> windows the counters, stop evidence, and reconciler
//     findings. Use it for rollout gates: findings on tasks untouched since
//     the window opened are reported as historical residue, not failures.

import { runWorkflowReconciliation } from "@/lib/tasks/workflow-reconciler";
import {
  getCohortSummary,
  getLegacyDrainInventory,
  getLegacyInvocationSummary,
} from "@/lib/tasks/orchestrator/dashboard-data";
import { orchestratorV2MutationProjects } from "@/lib/tasks/orchestrator/flags";
import { PHASE_E_STOP_CONDITIONS } from "@/lib/tasks/orchestrator/rollout-gates";
import { LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND } from "@/lib/tasks/legacy-workflow-boundary";
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
  const sinceValue = option("since");
  const since = sinceValue ? new Date(sinceValue) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error("--since must be a valid ISO timestamp.");
  }
  const report = await runWorkflowReconciliation({
    projectId: projectId,
    dryRun: !apply,
  });

  // Reconciler findings are assertions about *current* aggregate state, not
  // events, so they carry no createdAt to window by. Date each finding by the
  // most recent state change on its task: a finding counts as pre-window
  // residue only when its task has not moved at all since the window opened.
  // Erring toward "in window" is deliberate — it can never file a genuinely
  // new regression as historical residue.
  const findingTaskIds = [...new Set(
    report.findings.map((finding) => finding.taskId).filter((id): id is string => Boolean(id)),
  )];
  const findingTaskActivity = findingTaskIds.length
    ? await db.task.findMany({
        where: { id: { in: findingTaskIds } },
        select: { id: true, statusChangedAt: true, updatedAt: true },
      })
    : [];
  const lastMovedAt = new Map(findingTaskActivity.map((task) => [
    task.id,
    Math.max(task.statusChangedAt?.getTime() ?? 0, task.updatedAt?.getTime() ?? 0),
  ]));
  const isPreWindowResidue = (finding: (typeof report.findings)[number]) => {
    if (!since) return false;
    // A finding with no task anchor cannot be proven stale — gate on it.
    if (!finding.taskId) return false;
    const moved = lastMovedAt.get(finding.taskId);
    if (moved === undefined) return false;
    return moved < since.getTime();
  };
  const gatingFindings = report.findings.filter((finding) => !isPreWindowResidue(finding));
  const residueFindings = report.findings.filter(isPreWindowResidue);

  // PHASEE-10 — Gather Phase E specific metrics.
  const [cohortSummary, legacyInvocationSummary, allTimeLegacyInvocationSummary, legacyDrainInventory, engineDistribution, receiptStats, allTimeReceiptStats, procedureStats, diagnosticActivities, allTimeDiagnosticActivities, v2LegacyInvocations, mechanicalDecisionActors] = await Promise.all([
    getCohortSummary(projectId, { since }),
    getLegacyInvocationSummary(projectId, { since }),
    getLegacyInvocationSummary(projectId),
    getLegacyDrainInventory(projectId),
    db.task.groupBy({
      by: ["workflowEngine"],
      where: { deletedAt: null, ...(projectId ? { projectId } : {}) },
      _count: { _all: true },
    }),
    db.taskWorkflowCommandReceipt.groupBy({
      by: ["status"],
      where: {
        ...(projectId ? { task: { projectId, deletedAt: null } } : {}),
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      _count: { _all: true },
    }),
    db.taskWorkflowCommandReceipt.groupBy({
      by: ["status"],
      where: projectId ? { task: { projectId, deletedAt: null } } : undefined,
      _count: { _all: true },
    }),
    db.taskProcedureRun.groupBy({
      by: ["status"],
      where: projectId ? { task: { projectId, deletedAt: null } } : undefined,
      _count: { _all: true },
    }),
    db.activityLog.groupBy({
      by: ["kind"],
      where: {
        ...(projectId ? { projectId } : {}),
        kind: { in: [
          "task.workflow.idempotency_conflict",
          "task.workflow.engine_invariant",
          "task.workflow.legacy_bypass_attempt",
          "task.workflow.callback.mismatch",
          "task.workflow.callback.replayed",
          "task.workflow.callback.stale_mutation",
          "task.workflow.procedure_operational_error",
        ] },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      _count: { _all: true },
    }),
    db.activityLog.groupBy({
      by: ["kind"],
      where: {
        ...(projectId ? { projectId } : {}),
        kind: { in: [
          "task.workflow.idempotency_conflict",
          "task.workflow.engine_invariant",
          "task.workflow.legacy_bypass_attempt",
          "task.workflow.callback.mismatch",
          "task.workflow.callback.replayed",
          "task.workflow.callback.stale_mutation",
          "task.workflow.procedure_operational_error",
        ] },
      },
      _count: { _all: true },
    }),
    db.activityLog.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
        task: { workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: { not: null } },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      select: {
        createdAt: true,
        taskId: true,
        task: { select: { workflowEnginePinnedAt: true } },
      },
    }),
    db.workflowTransition.count({
      where: {
        ...(projectId ? { task: { projectId } } : {}),
        intent: { in: ["submit_plan", "approve_plan", "accept_review", "repository_finalization_succeeded"] },
        actor: { agent: { role: "monitor" } },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
    }),
  ]);

  const phaseEFindings = report.findings.filter((f) =>
    f.kind === "engine_ownership_mismatch" ||
    f.kind === "stale_receipt_without_transition" ||
    f.kind === "procedure_run_without_cycle" ||
    f.kind === "dual_engine_active",
  );
  const diagnosticCounts = Object.fromEntries(
    diagnosticActivities.map((row) => [row.kind, row._count._all]),
  );
  const allTimeDiagnosticCounts = Object.fromEntries(
    allTimeDiagnosticActivities.map((row) => [row.kind, row._count._all]),
  );
  const receiptStatsMap = Object.fromEntries(
    receiptStats.map((row) => [row.status, row._count._all]),
  );
  const allTimeReceiptStatsMap = Object.fromEntries(
    allTimeReceiptStats.map((row) => [row.status, row._count._all]),
  );
  const subtractCounts = (allTime: Record<string, number>, window: Record<string, number>) =>
    Object.fromEntries(Object.entries(allTime)
      .map(([key, count]) => [key, count - (window[key] ?? 0)] as const)
      .filter(([, count]) => count > 0));
  const legacyAfterV2Pin = v2LegacyInvocations.filter((row) =>
    row.task?.workflowEnginePinnedAt && row.createdAt >= row.task.workflowEnginePinnedAt,
  ).length;
  const findingKinds = new Set(report.findings.map((finding) => finding.kind));
  const stopConditionDiagnostics = PHASE_E_STOP_CONDITIONS.map((id) => {
    let triggered = false;
    let evidenceCount = 0;
    switch (id) {
      case "decision_actor_is_mechanical_executor":
        evidenceCount = mechanicalDecisionActors;
        triggered = evidenceCount > 0;
        break;
      case "dual_authoritative_mutation":
      case "rollback_routed_active_v2_to_legacy":
        evidenceCount = legacyAfterV2Pin + (diagnosticCounts["task.workflow.legacy_bypass_attempt"] ?? 0);
        triggered = evidenceCount > 0;
        break;
      case "command_missing_procedure_or_continuation":
        triggered = findingKinds.has("in_progress_no_open_cycle") || findingKinds.has("accepted_review_no_finalization_procedure");
        evidenceCount = triggered ? 1 : 0;
        break;
      case "idempotency_evidence_conflict":
        evidenceCount = diagnosticCounts["task.workflow.idempotency_conflict"] ?? 0;
        triggered = evidenceCount > 0;
        break;
      case "accepted_review_evidence_reused_or_reset":
        triggered = findingKinds.has("review_lease_missing") || findingKinds.has("review_no_lease");
        evidenceCount = triggered ? 1 : 0;
        break;
      case "duplicate_mechanical_effect":
        triggered = findingKinds.has("multiple_open_cycles");
        evidenceCount = triggered ? 1 : 0;
        break;
      case "lost_execution_continuation":
        triggered = findingKinds.has("in_progress_no_open_cycle");
        evidenceCount = triggered ? 1 : 0;
        break;
      case "doctor_engine_cycle_receipt_contradiction":
        evidenceCount = phaseEFindings.length;
        triggered = evidenceCount > 0;
        break;
      case "stale_callback_mutated_active_cycle":
        // Mismatch/replay activities prove healthy fencing and are not stops.
        // Only this dedicated invariant activity represents an observed
        // stale callback mutation.
        evidenceCount = diagnosticCounts["task.workflow.callback.stale_mutation"] ?? 0;
        triggered = evidenceCount > 0;
        break;
    }
    return { id, triggered, evidenceCount };
  });

  const phaseE = {
    observationWindow: {
      startedAt: since?.toISOString() ?? null,
      semantics: since
        ? "event counters, stop evidence, and reconciler findings are windowed; findings are dated by their task's last state change"
        : "all-time event counters and reconciler findings; current aggregate invariants are live",
    },
    engineOwnershipDistribution: Object.fromEntries(
      engineDistribution.map((row) => [row.workflowEngine, row._count._all]),
    ),
    receiptStats: receiptStatsMap,
    procedureStatusSummary: Object.fromEntries(
      procedureStats.map((row) => [row.status, row._count._all]),
    ),
    legacyInvocationCount: legacyInvocationSummary.totalInvocations,
    legacyInvocationByBoundary: legacyInvocationSummary.byBoundary,
    legacyDrainInventory,
    legacyDrainCount: legacyDrainInventory.length,
    cohortCoverage: cohortSummary,
    configuredMutationProjects: [...orchestratorV2MutationProjects()].sort(),
    commandCallbackHealth: {
      diagnosticCounts,
      rejectedCallbacks: diagnosticCounts["task.workflow.callback.mismatch"] ?? 0,
      replayedCallbacks: diagnosticCounts["task.workflow.callback.replayed"] ?? 0,
    },
    stopConditionGatePassed: stopConditionDiagnostics.every((diagnostic) => !diagnostic.triggered),
    stopConditionDiagnostics,
    historicalResidueBeforeWindow: since ? {
      receiptStats: subtractCounts(allTimeReceiptStatsMap, receiptStatsMap),
      diagnosticCounts: subtractCounts(allTimeDiagnosticCounts, diagnosticCounts),
      legacyInvocationCount: Math.max(
        0,
        allTimeLegacyInvocationSummary.totalInvocations - legacyInvocationSummary.totalInvocations,
      ),
      reconcilerFindingCount: residueFindings.length,
      reconcilerFindingsByKind: residueFindings.reduce<Record<string, number>>((acc, finding) => {
        acc[finding.kind] = (acc[finding.kind] ?? 0) + 1;
        return acc;
      }, {}),
    } : null,
    // The findings --strict actually gates on. Without --since this is every
    // finding; with --since it excludes tasks untouched since the window opened.
    gatingFindingCount: gatingFindings.length,
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
      `window=${phaseE.observationWindow.startedAt ?? "all-time"} ` +
      `receipts=${JSON.stringify(phaseE.receiptStats)} ` +
      `procedures=${JSON.stringify(phaseE.procedureStatusSummary)} ` +
      `legacyInvocations=${phaseE.legacyInvocationCount} ` +
      `legacyDrain=${phaseE.legacyDrainCount} ` +
      `invariantViolations=${phaseE.invariantViolations} ` +
      `stopConditionGate=${phaseE.stopConditionGatePassed ? "pass" : "FAIL"}`,
    );
    for (const finding of gatingFindings) {
      console.log(
        `  ${finding.kind} ${finding.taskId ?? finding.rowId}: ${finding.detail} ` +
        `→ ${finding.repair}${finding.repaired ? " [done]" : ""}${finding.error ? ` [${finding.error}]` : ""}`,
      );
    }
    if (residueFindings.length > 0) {
      console.log(
        `  historical residue (untouched since ${since?.toISOString()}): ` +
        `${residueFindings.length} finding(s) not gating this window`,
      );
    }
    for (const error of report.errors) console.log(`  error: ${error}`);
  }

  // --strict exits non-zero if any in-window finding (including Phase E
  // invariants) exists, or a stop condition fired. Pre-window residue is
  // reported under historicalResidueBeforeWindow but never gates a rollout:
  // an unwindowed strict run on a database with history could otherwise never
  // pass, which made the documented rollout gate unreachable in production.
  if (flag("strict") && (gatingFindings.length > 0 || !phaseE.stopConditionGatePassed)) process.exit(1);
}

main().catch((error) => {
  console.error("[pm-workflow-doctor] failed", error);
  process.exit(1);
});
