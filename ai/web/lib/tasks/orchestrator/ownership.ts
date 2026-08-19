// Phase E §5 — Durable engine ownership resolver.
//
// Engine ownership is durable state, not a per-request environment-variable
// decision. A task or workflow cycle must never be mutated once by V2 and
// then continued by legacy because a flag changed, a route retried, or an
// operator rolled back.
//
// Invariants (§3.2):
//   - Task.workflowEngine owns planning-state commands where no cycle exists.
//   - TaskWorkflowCycle.workflowEngine freezes the implementation/review
//     attempt. When a V2 start_implementation command opens a cycle, copy
//     the task engine to the cycle. All later cycle-scoped commands route
//     by the cycle value.
//   - If task and active-cycle ownership disagree, reject the command and
//     report a reconciler invariant; never choose one heuristically.
//   - Rollback stops admission of new V2 owners while allowing already-owned
//     V2 procedures and callbacks to finish.

import type { Prisma } from "@prisma/client";
import type { Task, TaskWorkflowCycle } from "@prisma/client";

// --- Engine constants ----------------------------------------------------

export const ENGINE_LEGACY = "legacy" as const;
export const ENGINE_ORCHESTRATOR_V2 = "orchestrator_v2" as const;

export type WorkflowEngine = typeof ENGINE_LEGACY | typeof ENGINE_ORCHESTRATOR_V2;

export const ALLOWED_ENGINES: ReadonlySet<string> = new Set([
  ENGINE_LEGACY,
  ENGINE_ORCHESTRATOR_V2,
]);

// Statuses approved for the initial V2 migration (quiescent tasks only).
const MIGRATION_APPROVED_STATUSES: ReadonlySet<string> = new Set([
  "Backlog",
  "To Do",
  "Done",
]);

// --- Types ---------------------------------------------------------------

export type OwnershipResolution =
  | { ok: true; engine: WorkflowEngine; taskEngine: WorkflowEngine; cycleEngine: WorkflowEngine | null }
  | { ok: false; reason: string; code: "engine_mismatch" | "invalid_engine" | "task_not_found" };

export type PinResult =
  | { ok: true }
  | { ok: false; reason: string; code: string };

export type UnpinResult =
  | { ok: true }
  | { ok: false; reason: string; code: string };

// --- Read ----------------------------------------------------------------

/**
 * Resolve the durable engine ownership for a task. Falls through to the
 * active cycle's engine when a cycle is open. If task and active-cycle
 * ownership disagree, returns an invariant error — never heuristically
 * resolves.
 */
export async function resolveEngineOwnership(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<OwnershipResolution> {
  const task = await tx.task.findUnique({
    where: { id: taskId, deletedAt: null },
    select: {
      workflowEngine: true,
      activeWorkflowCycleId: true,
    },
  });

  if (!task) {
    return { ok: false, reason: "Task not found.", code: "task_not_found" };
  }

  const taskEngine = task.workflowEngine;
  if (!ALLOWED_ENGINES.has(taskEngine)) {
    return {
      ok: false,
      reason: `Task has unknown engine value: ${taskEngine}`,
      code: "invalid_engine",
    };
  }

  let cycleEngine: WorkflowEngine | null = null;
  if (task.activeWorkflowCycleId) {
    const cycle = await tx.taskWorkflowCycle.findUnique({
      where: { id: task.activeWorkflowCycleId },
      select: { workflowEngine: true },
    });
    if (!cycle) {
      return {
        ok: false,
        reason: `Task points to missing active cycle ${task.activeWorkflowCycleId} — reconciler invariant violation.`,
        code: "engine_mismatch",
      };
    }
    if (!ALLOWED_ENGINES.has(cycle.workflowEngine)) {
      return {
        ok: false,
        reason: `Cycle has unknown engine value: ${cycle.workflowEngine}`,
        code: "invalid_engine",
      };
    }
    cycleEngine = cycle.workflowEngine as WorkflowEngine;

    // Invariant: task and active-cycle ownership must agree.
    if (cycleEngine !== (taskEngine as WorkflowEngine)) {
      return {
        ok: false,
        reason: `Task engine "${taskEngine}" disagrees with active cycle engine "${cycleEngine}" — reconciler invariant violation.`,
        code: "engine_mismatch",
      };
    }
  }

  return {
    ok: true,
    engine: (taskEngine as WorkflowEngine),
    taskEngine: (taskEngine as WorkflowEngine),
    cycleEngine,
  };
}

// --- Pin / Unpin ---------------------------------------------------------

/**
 * Pin a task to the V2 orchestrator engine. Enforces the safe-pinning
 * preconditions from Phase E §5.2:
 *   - project is in the effectful Phase E cohort
 *   - no active legacy repository validation/finalization job exists
 *   - no open legacy cycle
 *   - no queued/running legacy-only recovery operation
 *   - current status is in an approved migration set (Backlog/To Do/Done)
 *
 * For the initial rollout, only quiescent tasks are migrated. In Progress
 * and Review tasks must drain their legacy cycle first.
 */
export async function pinToV2(
  tx: Prisma.TransactionClient,
  taskId: string,
  opts: {
    projectInCohort: boolean;
  },
): Promise<PinResult> {
  const task = await tx.task.findUnique({
    where: { id: taskId, deletedAt: null },
    select: {
      id: true,
      status: true,
      workflowEngine: true,
      activeWorkflowCycleId: true,
      projectId: true,
    },
  });

  if (!task) {
    return { ok: false, reason: "Task not found.", code: "task_not_found" };
  }

  // Already pinned — idempotent success.
  if (task.workflowEngine === ENGINE_ORCHESTRATOR_V2) {
    return { ok: true };
  }

  // Precondition: project must be in the effectful Phase E cohort.
  if (!opts.projectInCohort) {
    return {
      ok: false,
      reason: "Project is not in the Phase E effectful mutation cohort.",
      code: "project_not_in_cohort",
    };
  }

  // Precondition: status must be in the approved migration set.
  if (!MIGRATION_APPROVED_STATUSES.has(task.status)) {
    return {
      ok: false,
      reason: `Task status "${task.status}" is not in the approved migration set (Backlog, To Do, Done). In Progress and Review tasks must drain their legacy cycle first.`,
      code: "status_not_approved",
    };
  }

  // Precondition: no open legacy cycle.
  if (task.activeWorkflowCycleId) {
    const cycle = await tx.taskWorkflowCycle.findUnique({
      where: { id: task.activeWorkflowCycleId },
      select: { status: true, workflowEngine: true },
    });
    if (cycle && cycle.status === "open") {
      return {
        ok: false,
        reason: "Task has an open workflow cycle. The cycle must close before pinning to V2.",
        code: "open_cycle_exists",
      };
    }
  }

  // Precondition: no active legacy repository job.
  const activeRepoJob = await tx.taskRepositoryRun.findFirst({
    where: {
      taskId: task.id,
      phase: { in: ["reserved", "validating", "finalizing"] },
    },
    select: { id: true },
  });
  if (activeRepoJob) {
    return {
      ok: false,
      reason: "Task has an active repository validation/finalization job.",
      code: "active_repo_job",
    };
  }

  // Precondition: no queued/running legacy procedure.
  const activeProcedure = await tx.taskProcedureRun.findFirst({
    where: {
      taskId: task.id,
      status: { in: ["queued", "running"] },
    },
    select: { id: true },
  });
  if (activeProcedure) {
    return {
      ok: false,
      reason: "Task has a queued or running procedure.",
      code: "active_procedure",
    };
  }

  // All preconditions met — pin to V2.
  await tx.task.update({
    where: { id: task.id },
    data: {
      workflowEngine: ENGINE_ORCHESTRATOR_V2,
      workflowEnginePinnedAt: new Date(),
    },
  });

  return { ok: true };
}

/**
 * Unpin a task from V2 back to legacy. Operator-only, audited.
 * Rejects when any active cycle, procedure, repository job, or unsettled
 * command receipt exists — rollback admission never reroutes an
 * already-pinned task or open cycle to legacy.
 */
export async function unpinFromV2(
  tx: Prisma.TransactionClient,
  taskId: string,
  opts: {
    operatorUserId: string;
  },
): Promise<UnpinResult> {
  const task = await tx.task.findUnique({
    where: { id: taskId, deletedAt: null },
    select: {
      id: true,
      workflowEngine: true,
      activeWorkflowCycleId: true,
      projectId: true,
    },
  });

  if (!task) {
    return { ok: false, reason: "Task not found.", code: "task_not_found" };
  }

  if (task.workflowEngine !== ENGINE_ORCHESTRATOR_V2) {
    return {
      ok: false,
      reason: "Task is not pinned to V2.",
      code: "not_pinned",
    };
  }

  // Reject if any active cycle exists.
  if (task.activeWorkflowCycleId) {
    const cycle = await tx.taskWorkflowCycle.findUnique({
      where: { id: task.activeWorkflowCycleId },
      select: { status: true },
    });
    if (cycle && cycle.status === "open") {
      return {
        ok: false,
        reason: "Cannot unpin: task has an open workflow cycle. Rollback admission never reroutes an open cycle to legacy.",
        code: "active_cycle",
      };
    }
  }

  // Reject if any active procedure exists.
  const activeProcedure = await tx.taskProcedureRun.findFirst({
    where: {
      taskId: task.id,
      status: { in: ["queued", "running"] },
    },
    select: { id: true },
  });
  if (activeProcedure) {
    return {
      ok: false,
      reason: "Cannot unpin: task has an active procedure.",
      code: "active_procedure",
    };
  }

  // Reject if any active repository job exists.
  const activeRepoJob = await tx.taskRepositoryRun.findFirst({
    where: {
      taskId: task.id,
      phase: { in: ["reserved", "validating", "finalizing"] },
    },
    select: { id: true },
  });
  if (activeRepoJob) {
    return {
      ok: false,
      reason: "Cannot unpin: task has an active repository job.",
      code: "active_repo_job",
    };
  }

  // Reject if any unsettled command receipt exists (accepted but not completed).
  const unsettledReceipt = await tx.taskWorkflowCommandReceipt.findFirst({
    where: {
      taskId: task.id,
      status: "accepted",
    },
    select: { id: true },
  });
  if (unsettledReceipt) {
    return {
      ok: false,
      reason: "Cannot unpin: task has an unsettled command receipt.",
      code: "unsettled_receipt",
    };
  }

  // All preconditions met — unpin to legacy.
  await tx.task.update({
    where: { id: task.id },
    data: {
      workflowEngine: ENGINE_LEGACY,
      workflowEnginePinnedAt: null,
    },
  });

  // Audit the unpin.
  await tx.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      userId: opts.operatorUserId,
      kind: "task.workflow.engine_unpin",
      payload: JSON.stringify({
        from: ENGINE_ORCHESTRATOR_V2,
        to: ENGINE_LEGACY,
        operatorUserId: opts.operatorUserId,
      }),
    },
  });

  return { ok: true };
}

// --- Rollback admission --------------------------------------------------

/**
 * Check whether a project is in the effectful Phase E mutation cohort.
 * This is separate from the compute-only comparison flags (§5.3).
 * Removing a project from this allowlist stops new pins but never reroutes
 * an already-pinned task or open cycle to legacy.
 */
export function isProjectInMutationCohort(projectSlug: string): boolean {
  const raw = process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS ?? "";
  if (!raw.trim()) return false;
  if (raw.trim() === "*") return true;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(projectSlug);
}

/**
 * Check whether a task is durably owned by the V2 orchestrator.
 * Uses the durable workflowEngine field, not a fresh flag evaluation.
 */
export async function isV2Owned(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<boolean> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { workflowEngine: true },
  });
  return task?.workflowEngine === ENGINE_ORCHESTRATOR_V2;
}

/**
 * Copy the task's engine to a newly opened cycle. Called by execute.ts
 * when opening a new workflow cycle to ensure the cycle is permanently
 * pinned to the same engine as the task.
 */
export async function stampCycleEngine(
  tx: Prisma.TransactionClient,
  cycleId: string,
  engine: WorkflowEngine,
): Promise<void> {
  await tx.taskWorkflowCycle.update({
    where: { id: cycleId },
    data: { workflowEngine: engine },
  });
}
