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
 * Read-only — uses existing DB indexes.
 */
export async function getCohortSummary(projectId?: string): Promise<CohortSummary[]> {
  const projectFilter = projectId ? { id: projectId } : undefined;

  const projects = await db.project.findMany({
    where: projectFilter,
    select: {
      id: true,
      slug: true,
      name: true,
      tasks: {
        where: { deletedAt: null },
        select: {
          status: true,
          workflowEngine: true,
          activeWorkflowCycleId: true,
          procedureRuns: {
            where: { status: { in: ["queued", "running", "operational_error"] } },
            select: { id: true },
          },
        },
      },
    },
  });

  return projects.map((project) => {
    const engineDistribution: Record<string, number> = {};
    const taskCountByStatus: Record<string, number> = {};
    let activeCycleCount = 0;
    let activeProcedureCount = 0;

    for (const task of project.tasks) {
      engineDistribution[task.workflowEngine] = (engineDistribution[task.workflowEngine] ?? 0) + 1;
      taskCountByStatus[task.status] = (taskCountByStatus[task.status] ?? 0) + 1;
      if (task.activeWorkflowCycleId) activeCycleCount++;
      activeProcedureCount += task.procedureRuns.length;
    }

    return {
      projectSlug: project.slug,
      projectName: project.name,
      engineDistribution,
      taskCountByStatus,
      activeCycleCount,
      activeProcedureCount,
    };
  });
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
  // Use groupBy to count rows by payload boundary+entryPoint, avoiding
  // fetching all rows into JS. We still need to parse payload to group by
  // boundary/entryPoint since those are JSON fields not columns.
  // However, we can use the count + max(createdAt) via groupBy on a computed
  // key. Since Prisma groupBy cannot parse JSON, we fetch the distinct
  // payloads via a targeted query and use count for totals.
  //
  // Optimization: use groupBy on kind to get the total count in one query,
  // then fetch only the distinct payloads (boundary+entryPoint) with their
  // last-seen timestamps. This avoids loading every row when there are
  // thousands of invocations but only ~11 distinct boundary ids.

  const totalCount = await db.activityLog.count({
    where: {
      kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
      ...(projectId ? { projectId } : {}),
    },
  });

  // Fetch only the latest row per boundary+entryPoint to get lastInvokedAt.
  // Then count per group with a separate groupBy query on the payload field.
  // Since payload is a JSON string, we use findMany with distinct on the
  // payload field but limited to the distinct boundaries.
  //
  // For efficiency with the @@index([kind, createdAt]) index, we query
  // ordered by createdAt desc and deduplicate in JS — but only the latest
  // row per boundary key, not every row.
  const latestRows = await db.activityLog.findMany({
    where: {
      kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
      ...(projectId ? { projectId } : {}),
    },
    select: {
      payload: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    // Only need one row per distinct boundary+entryPoint. With ~11 boundary
    // ids and ~20 entry points, take a reasonable upper bound.
    take: 500,
  });

  const seenKeys = new Set<string>();
  const byBoundary: LegacyInvocationEntry[] = [];
  // Count per boundary+entryPoint using a single groupBy query.
  // Since we cannot groupBy JSON payload, we count all rows per payload
  // value — the payload is deterministic for the same boundary+entryPoint.
  const countGroups = await db.activityLog.groupBy({
    by: ["payload"],
    where: {
      kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
      ...(projectId ? { projectId } : {}),
    },
    _count: true,
  });

  // Build a map of payload → count for efficient lookup.
  const countMap = new Map<string, number>();
  for (const group of countGroups) {
    const c = typeof group._count === "number" ? group._count : 0;
    countMap.set(group.payload ?? "", c);
  }

  for (const row of latestRows) {
    let legacyBoundary = "unknown";
    let entryPoint = "unknown";
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      legacyBoundary = String(payload.legacyBoundary ?? "unknown");
      entryPoint = String(payload.entryPoint ?? "unknown");
    } catch {
      // keep defaults
    }

    const key = `${legacyBoundary}:${entryPoint}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const count = countMap.get(row.payload ?? "") ?? 0;
    byBoundary.push({
      legacyBoundary,
      entryPoint,
      count,
      lastInvokedAt: row.createdAt.toISOString(),
    });
  }

  byBoundary.sort((a, b) => b.count - a.count);

  return {
    totalInvocations: totalCount,
    byBoundary,
  };
}