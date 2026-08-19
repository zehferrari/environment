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
 * Read-only — uses the ActivityLog index on `kind`.
 */
export async function getLegacyInvocationSummary(projectId?: string): Promise<LegacyInvocationSummary> {
  const rows = await db.activityLog.findMany({
    where: {
      kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
      ...(projectId ? { projectId } : {}),
    },
    select: {
      payload: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const byBoundaryMap = new Map<string, LegacyInvocationEntry>();

  for (const row of rows) {
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
    const existing = byBoundaryMap.get(key);
    if (existing) {
      existing.count++;
      // Rows are ordered desc, so the first seen is the most recent.
      // Only update lastInvokedAt if it's null (first row seen = most recent).
    } else {
      byBoundaryMap.set(key, {
        legacyBoundary,
        entryPoint,
        count: 1,
        lastInvokedAt: row.createdAt.toISOString(),
      });
    }
  }

  const byBoundary = Array.from(byBoundaryMap.values()).sort((a, b) => b.count - a.count);
  const totalInvocations = byBoundary.reduce((sum, entry) => sum + entry.count, 0);

  return {
    totalInvocations,
    byBoundary,
  };
}