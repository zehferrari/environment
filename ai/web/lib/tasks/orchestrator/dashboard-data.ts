// PHASEE-10 — Cohort and legacy-invocation dashboard data endpoints.
//
// Read-only functions that return cohort summary and legacy-invocation counts
// for dashboard consumption. Built on the boundary-registry counter contract
// (task.workflow.legacy_boundary.invoked ActivityLog rows) and the expanded
// workflow projection. These are accessible from the PM internal API surface,
// not public-facing.

import { db } from "@/lib/db";
import { LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND } from "@/lib/tasks/legacy-workflow-boundary";
import { isV2MutationAdmissionEnabledForProject } from "@/lib/tasks/orchestrator/flags";

export type CohortSummary = {
  projectSlug: string;
  projectName: string;
  engineDistribution: Record<string, number>;
  taskCountByStatus: Record<string, number>;
  activeCycleCount: number;
  activeProcedureCount: number;
  configuredEffectful: boolean;
  eligibleTaskCount: number;
  admittedTaskCount: number;
  skippedTaskCount: number;
  skippedReasons: Record<string, number>;
  commandHealth: Record<string, number>;
  callbackHealth: { applied: number; rejected: number };
  windowStartedAt: string | null;
  legacyDrainCount: number;
};

export type LegacyInvocationEntry = {
  legacyBoundary: string;
  entryPoint: string;
  count: number;
  lastInvokedAt: string | null;
};

export type LegacyInvocationSummary = {
  totalInvocations: number;
  byBoundary: LegacyInvocationEntry[];
  windowStartedAt: string | null;
};

export type LegacyDrainEntry = {
  taskId: string;
  workItemKey: string | null;
  projectId: string;
  status: string;
  activeWorkflowCycleId: string | null;
  repositoryPhase: string | null;
  procedureStatuses: string[];
  pmRunStatuses: string[];
  continuationStatuses: string[];
  outboxStatuses: string[];
  acceptedReceiptCount: number;
};

export async function getLegacyDrainInventory(projectId?: string): Promise<LegacyDrainEntry[]> {
  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      archivedAt: null,
      workflowEngine: "legacy",
      ...(projectId ? { projectId } : {}),
    },
    select: { id: true, workItemKey: true, projectId: true, status: true, activeWorkflowCycleId: true },
  });
  if (tasks.length === 0) return [];
  const taskIds = tasks.map((task) => task.id);
  const [repositoryRuns, procedures, pmRuns, continuations, outbox, receipts] = await Promise.all([
    db.taskRepositoryRun.findMany({
      where: {
        taskId: { in: taskIds },
        phase: { in: ["reserved", "provisioning", "validating", "review_ready", "finalizing", "operational_error"] },
      },
      select: { taskId: true, phase: true },
    }),
    db.taskProcedureRun.findMany({
      where: { taskId: { in: taskIds }, status: { not: "completed" } },
      select: { taskId: true, status: true },
    }),
    db.pmChannelRun.findMany({
      where: {
        taskId: { in: taskIds },
        status: { notIn: ["completed", "failed", "timed_out", "cancelled", "superseded"] },
      },
      select: { taskId: true, status: true },
    }),
    db.pmChannelContinuation.findMany({
      where: { taskId: { in: taskIds }, status: { in: ["armed", "queued"] } },
      select: { taskId: true, status: true },
    }),
    db.workflowOutbox.findMany({
      where: { taskId: { in: taskIds }, status: { not: "completed" } },
      select: { taskId: true, status: true },
    }),
    db.taskWorkflowCommandReceipt.groupBy({
      by: ["taskId"],
      where: { taskId: { in: taskIds }, status: "accepted" },
      _count: true,
    }),
  ]);
  const groupedStatuses = (rows: Array<{ taskId: string | null; status: string }>) => {
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.taskId) continue;
      const values = grouped.get(row.taskId) ?? [];
      if (!values.includes(row.status)) values.push(row.status);
      grouped.set(row.taskId, values.sort());
    }
    return grouped;
  };
  const repositoryMap = new Map(repositoryRuns.map((row) => [row.taskId, row.phase]));
  const procedureMap = groupedStatuses(procedures);
  const pmRunMap = groupedStatuses(pmRuns);
  const continuationMap = groupedStatuses(continuations);
  const outboxMap = groupedStatuses(outbox);
  const receiptMap = new Map(receipts.map((row) => [
    row.taskId,
    typeof row._count === "number" ? row._count : 0,
  ]));
  return tasks.map((task) => ({
    taskId: task.id,
    workItemKey: task.workItemKey,
    projectId: task.projectId,
    status: task.status,
    activeWorkflowCycleId: task.activeWorkflowCycleId,
    repositoryPhase: repositoryMap.get(task.id) ?? null,
    procedureStatuses: procedureMap.get(task.id) ?? [],
    pmRunStatuses: pmRunMap.get(task.id) ?? [],
    continuationStatuses: continuationMap.get(task.id) ?? [],
    outboxStatuses: outboxMap.get(task.id) ?? [],
    acceptedReceiptCount: receiptMap.get(task.id) ?? 0,
  })).filter((task) =>
    task.status === "In Progress" ||
    task.status === "Review" ||
    Boolean(task.activeWorkflowCycleId) ||
    Boolean(task.repositoryPhase) ||
    task.procedureStatuses.length > 0 ||
    task.pmRunStatuses.length > 0 ||
    task.continuationStatuses.length > 0 ||
    task.outboxStatuses.length > 0 ||
    task.acceptedReceiptCount > 0);
}

/**
 * Return a cohort summary across all projects (or a single project if specified).
 * Read-only — uses groupBy/count for bounded cost, never loads the full task
 * table into JS.
 */
export async function getCohortSummary(
  projectId?: string,
  opts: { since?: Date } = {},
): Promise<CohortSummary[]> {
  const projectFilter = projectId ? { id: projectId } : undefined;

  const projects = await db.project.findMany({
    where: projectFilter,
    select: { id: true, slug: true, name: true },
  });

  if (projects.length === 0) return [];

  const projectIds = projects.map((p) => p.id);
  const legacyDrainInventory = await getLegacyDrainInventory(projectId);
  const legacyDrainCountMap = new Map<string, number>();
  for (const entry of legacyDrainInventory) {
    legacyDrainCountMap.set(entry.projectId, (legacyDrainCountMap.get(entry.projectId) ?? 0) + 1);
  }
  const taskWhere = {
    deletedAt: null,
    archivedAt: null,
    projectId: { in: projectIds },
  };

  const [engineGroups, statusGroups, activeCycleCounts, procedureGroups, candidateTasks, receiptGroups, callbackGroups] = await Promise.all([
    // Engine distribution: groupBy projectId + workflowEngine.
    db.task.groupBy({
      by: ["projectId", "workflowEngine"],
      where: taskWhere,
      _count: true,
    }),
    // Task count by status: groupBy projectId + status.
    db.task.groupBy({
      by: ["projectId", "status"],
      where: taskWhere,
      _count: true,
    }),
    // A filtered single-project read can use count directly. The all-project
    // view must group by projectId to preserve one total per response row.
    projectId
      ? db.task.count({
          where: { ...taskWhere, activeWorkflowCycleId: { not: null } },
        }).then((count) => [{ projectId, count }])
      : db.task.groupBy({
          by: ["projectId"],
          where: { ...taskWhere, activeWorkflowCycleId: { not: null } },
          _count: true,
        }).then((groups) => groups.map((group) => ({
          projectId: group.projectId,
          count: typeof group._count === "number" ? group._count : 0,
        }))),
    // TaskProcedureRun has no projectId column. Group only active runs by
    // taskId, then resolve that bounded task-id set to project ids below.
    db.taskProcedureRun.groupBy({
      by: ["taskId"],
      where: {
        status: { not: "completed" },
        task: { projectId: { in: projectIds }, archivedAt: null, deletedAt: null },
      },
      _count: true,
    }),
    db.task.findMany({
      where: {
        ...taskWhere,
        workflowEngine: "legacy",
        status: { in: ["Backlog", "To Do"] },
      },
      select: { id: true, projectId: true, activeWorkflowCycleId: true },
    }),
    db.taskWorkflowCommandReceipt.groupBy({
      by: ["taskId", "status"],
      where: {
        task: { projectId: { in: projectIds }, archivedAt: null, deletedAt: null },
        ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
      },
      _count: true,
    }),
    db.activityLog.groupBy({
      by: ["projectId", "kind"],
      where: {
        projectId: { in: projectIds },
        kind: { in: ["task.workflow.callback.applied", "task.workflow.callback.mismatch"] },
        ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
      },
      _count: true,
    }),
  ]);

  // Build per-project summaries from the grouped data
  const engineMap = new Map<string, Record<string, number>>();
  const statusMap = new Map<string, Record<string, number>>();
  const procedureMap = new Map<string, number>();
  const candidateTaskIds = candidateTasks.map((task) => task.id);
  const [repositoryBlockers, pmRunBlockers, continuationBlockers, outboxBlockers] = candidateTaskIds.length > 0
    ? await Promise.all([
        db.taskRepositoryRun.findMany({
          where: {
            taskId: { in: candidateTaskIds },
            phase: { in: ["reserved", "provisioning", "validating", "review_ready", "finalizing", "operational_error"] },
          },
          select: { taskId: true },
        }),
        db.pmChannelRun.findMany({
          where: {
            taskId: { in: candidateTaskIds },
            status: { notIn: ["completed", "failed", "timed_out", "cancelled", "superseded"] },
          },
          select: { taskId: true },
        }),
        db.pmChannelContinuation.findMany({
          where: { taskId: { in: candidateTaskIds }, status: { in: ["armed", "queued"] } },
          select: { taskId: true },
        }),
        db.workflowOutbox.findMany({
          where: { taskId: { in: candidateTaskIds }, status: { not: "completed" } },
          select: { taskId: true },
        }),
      ])
    : [[], [], [], []];
  const repositoryBlockerIds = new Set(repositoryBlockers.map((row) => row.taskId));
  const procedureBlockerIds = new Set(procedureGroups.map((row) => row.taskId));
  const pmRunBlockerIds = new Set(pmRunBlockers.map((row) => row.taskId).filter((id): id is string => Boolean(id)));
  const continuationBlockerIds = new Set(continuationBlockers.map((row) => row.taskId).filter((id): id is string => Boolean(id)));
  const outboxBlockerIds = new Set(outboxBlockers.map((row) => row.taskId));
  // Observation-window filtering applies to command-health counters, not to
  // current admission safety. An accepted receipt from before the window is
  // still unsettled work and must continue to block a new ownership pin.
  const acceptedReceiptBlockers = candidateTaskIds.length > 0
    ? await db.taskWorkflowCommandReceipt.findMany({
        where: { taskId: { in: candidateTaskIds }, status: "accepted" },
        select: { taskId: true },
      })
    : [];
  const receiptBlockerIds = new Set(acceptedReceiptBlockers.map((row) => row.taskId));
  const eligibleMap = new Map<string, number>();
  const skippedReasonMap = new Map<string, Record<string, number>>();
  for (const task of candidateTasks) {
    let reasonCode: string | null = null;
    if (task.activeWorkflowCycleId) reasonCode = "active_cycle";
    else if (repositoryBlockerIds.has(task.id)) reasonCode = "active_repository_work";
    else if (procedureBlockerIds.has(task.id)) reasonCode = "active_procedure";
    else if (pmRunBlockerIds.has(task.id)) reasonCode = "active_execution_run";
    else if (continuationBlockerIds.has(task.id)) reasonCode = "active_continuation";
    else if (outboxBlockerIds.has(task.id)) reasonCode = "active_recovery_work";
    else if (receiptBlockerIds.has(task.id)) reasonCode = "unsettled_receipt";
    if (!reasonCode) {
      eligibleMap.set(task.projectId, (eligibleMap.get(task.projectId) ?? 0) + 1);
      continue;
    }
    const reasons = skippedReasonMap.get(task.projectId) ?? {};
    reasons[reasonCode] = (reasons[reasonCode] ?? 0) + 1;
    skippedReasonMap.set(task.projectId, reasons);
  }
  const receiptTaskProjects = receiptGroups.length > 0
    ? await db.task.findMany({
        where: { id: { in: receiptGroups.map((group) => group.taskId) } },
        select: { id: true, projectId: true },
      })
    : [];
  const receiptTaskProjectMap = new Map(receiptTaskProjects.map((task) => [task.id, task.projectId]));
  const commandHealthMap = new Map<string, Record<string, number>>();
  for (const group of receiptGroups) {
    const pid = receiptTaskProjectMap.get(group.taskId);
    if (!pid) continue;
    const health = commandHealthMap.get(pid) ?? {};
    health[group.status] = (health[group.status] ?? 0) + (typeof group._count === "number" ? group._count : 0);
    commandHealthMap.set(pid, health);
  }
  const callbackMap = new Map<string, { applied: number; rejected: number }>();
  for (const group of callbackGroups) {
    if (!group.projectId) continue;
    const health = callbackMap.get(group.projectId) ?? { applied: 0, rejected: 0 };
    const count = typeof group._count === "number" ? group._count : 0;
    if (group.kind.endsWith(".applied")) health.applied += count;
    else health.rejected += count;
    callbackMap.set(group.projectId, health);
  }
  for (const g of engineGroups) {
    const m = engineMap.get(g.projectId) ?? {};
    m[g.workflowEngine] = (m[g.workflowEngine] ?? 0) + (typeof g._count === "number" ? g._count : 0);
    engineMap.set(g.projectId, m);
  }

  for (const g of statusGroups) {
    const m = statusMap.get(g.projectId) ?? {};
    m[g.status] = (m[g.status] ?? 0) + (typeof g._count === "number" ? g._count : 0);
    statusMap.set(g.projectId, m);
  }

  // Map taskId → projectId so we can aggregate procedure counts per project.
  // We need the task's projectId; fetch a minimal lookup for the taskIds involved.
  const procedureTaskIds = procedureGroups.map((g) => g.taskId);
  const procedureTaskProjects = procedureTaskIds.length > 0
    ? await db.task.findMany({
        where: { id: { in: procedureTaskIds } },
        select: { id: true, projectId: true },
      })
    : [];
  const taskProjectMap = new Map(procedureTaskProjects.map((t) => [t.id, t.projectId]));

  for (const g of procedureGroups) {
    const pid = taskProjectMap.get(g.taskId);
    if (!pid) continue;
    const c = typeof g._count === "number" ? g._count : 0;
    procedureMap.set(pid, (procedureMap.get(pid) ?? 0) + c);
  }

  const activeCycleMap = new Map(
    activeCycleCounts.map(({ projectId: activeProjectId, count }) => [activeProjectId, count]),
  );

  return projects.map((project) => ({
    projectSlug: project.slug,
    projectName: project.name,
    engineDistribution: engineMap.get(project.id) ?? {},
    taskCountByStatus: statusMap.get(project.id) ?? {},
    activeCycleCount: activeCycleMap.get(project.id) ?? 0,
    activeProcedureCount: procedureMap.get(project.id) ?? 0,
    configuredEffectful: isV2MutationAdmissionEnabledForProject(project.slug),
    eligibleTaskCount: eligibleMap.get(project.id) ?? 0,
    admittedTaskCount: engineMap.get(project.id)?.orchestrator_v2 ?? 0,
    skippedTaskCount: Object.values(skippedReasonMap.get(project.id) ?? {}).reduce((sum, count) => sum + count, 0),
    skippedReasons: skippedReasonMap.get(project.id) ?? {},
    commandHealth: commandHealthMap.get(project.id) ?? {},
    callbackHealth: callbackMap.get(project.id) ?? { applied: 0, rejected: 0 },
    windowStartedAt: opts.since?.toISOString() ?? null,
    legacyDrainCount: legacyDrainCountMap.get(project.id) ?? 0,
  }));
}

/**
 * Return legacy-invocation counts by boundary id + entry point, sourced from
 * the boundary-registry counter contract (task.workflow.legacy_boundary.invoked
 * ActivityLog rows). The counter is already live and wired via
 * recordLegacyWorkflowBoundaryInvocation in lib/tasks/legacy-workflow-boundary.ts.
 *
 * Read-only — uses groupBy/count on the ActivityLog @@index([kind, createdAt])
 * for efficient legacy boundary queries instead of fetching all rows and
 * aggregating in JS.
 */
export async function getLegacyInvocationSummary(
  projectId?: string,
  opts: { since?: Date } = {},
): Promise<LegacyInvocationSummary> {
  // Single groupBy on payload with _count and _max(createdAt) — one query,
  // complete, no truncation. The payload is a deterministic JSON string
  // ({legacyBoundary, entryPoint}) so groupBy(["payload"]) returns exactly
  // one row per boundary+entryPoint pair.
  const groups = await db.activityLog.groupBy({
    by: ["payload"],
    where: {
      kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
      ...(projectId ? { projectId } : {}),
      ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
    },
    _count: true,
    _max: { createdAt: true },
  });

  let totalInvocations = 0;
  const byBoundary: LegacyInvocationEntry[] = [];

  for (const group of groups) {
    const count = typeof group._count === "number" ? group._count : 0;
    totalInvocations += count;

    let legacyBoundary = "unknown";
    let entryPoint = "unknown";
    try {
      const payload = JSON.parse(group.payload ?? "{}") as Record<string, unknown>;
      legacyBoundary = String(payload.legacyBoundary ?? "unknown");
      entryPoint = String(payload.entryPoint ?? "unknown");
    } catch {
      // keep defaults
    }

    const maxCreatedAt = group._max?.createdAt;
    byBoundary.push({
      legacyBoundary,
      entryPoint,
      count,
      lastInvokedAt: maxCreatedAt ? maxCreatedAt.toISOString() : null,
    });
  }

  byBoundary.sort((a, b) => b.count - a.count);

  return {
    totalInvocations,
    byBoundary,
    windowStartedAt: opts.since?.toISOString() ?? null,
  };
}
