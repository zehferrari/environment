// PHASEE-10 — Cohort and legacy-invocation dashboard data endpoints.
//
// Read-only functions that return cohort summary and legacy-invocation counts
// for dashboard consumption. Built on the boundary-registry counter contract
// (task.workflow.legacy_boundary.invoked ActivityLog rows) and the expanded
// workflow projection. These are accessible from the PM internal API surface,
// not public-facing.

import { db } from "@/lib/db";
import { LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND } from "@/lib/tasks/legacy-workflow-boundary";

export type CohortSummary = {
  projectSlug: string;
  projectName: string;
  engineDistribution: Record<string, number>;
  taskCountByStatus: Record<string, number>;
  activeCycleCount: number;
  activeProcedureCount: number;
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
};

/**
 * Return a cohort summary across all projects (or a single project if specified).
 * Read-only — uses groupBy/count for bounded cost, never loads the full task
 * table into JS.
 */
export async function getCohortSummary(projectId?: string): Promise<CohortSummary[]> {
  const projectFilter = projectId ? { id: projectId } : undefined;

  const projects = await db.project.findMany({
    where: projectFilter,
    select: { id: true, slug: true, name: true },
  });

  if (projects.length === 0) return [];

  const projectIds = projects.map((p) => p.id);
  const taskWhere = {
    deletedAt: null,
    projectId: { in: projectIds },
  };

  const [engineGroups, statusGroups, activeCycleCounts, procedureGroups] = await Promise.all([
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
        status: { in: ["queued", "running", "operational_error"] },
        task: { projectId: { in: projectIds }, deletedAt: null },
      },
      _count: true,
    }),
  ]);

  // Build per-project summaries from the grouped data
  const engineMap = new Map<string, Record<string, number>>();
  const statusMap = new Map<string, Record<string, number>>();
  const procedureMap = new Map<string, number>();

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
export async function getLegacyInvocationSummary(projectId?: string): Promise<LegacyInvocationSummary> {
  // Single groupBy on payload with _count and _max(createdAt) — one query,
  // complete, no truncation. The payload is a deterministic JSON string
  // ({legacyBoundary, entryPoint}) so groupBy(["payload"]) returns exactly
  // one row per boundary+entryPoint pair.
  const groups = await db.activityLog.groupBy({
    by: ["payload"],
    where: {
      kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
      ...(projectId ? { projectId } : {}),
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
  };
}
