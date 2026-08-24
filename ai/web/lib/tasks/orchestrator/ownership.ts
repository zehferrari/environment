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
import { computeActivityDedupeKey, writeDeduplicatedActivity } from "@/lib/tasks/orchestrator/activity-dedup";
import { isV2MutationAdmissionEnabledForProject } from "@/lib/tasks/orchestrator/flags";

type OwnershipDbClient = Prisma.TransactionClient | typeof import("@/lib/db").db;

// --- Engine constants ----------------------------------------------------

export const ENGINE_LEGACY = "legacy" as const;
export const ENGINE_ORCHESTRATOR_V2 = "orchestrator_v2" as const;

export type WorkflowEngine = typeof ENGINE_LEGACY | typeof ENGINE_ORCHESTRATOR_V2;

export const ALLOWED_ENGINES: ReadonlySet<string> = new Set([
  ENGINE_LEGACY,
  ENGINE_ORCHESTRATOR_V2,
]);

// Statuses approved for the initial V2 migration (quiescent tasks only).
export const MUTATION_ADMISSION_STATUSES: ReadonlySet<string> = new Set([
  "Backlog",
  "To Do",
  "Done",
]);

const ACTIVE_REPOSITORY_PHASES = [
  "reserved",
  "provisioning",
  "validating",
  "review_ready",
  "finalizing",
  "operational_error",
] as const;

const TERMINAL_PM_RUN_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "superseded",
] as const;

// --- Types ---------------------------------------------------------------

export type OwnershipResolution =
  | { ok: true; engine: WorkflowEngine; taskEngine: WorkflowEngine; cycleEngine: WorkflowEngine | null }
  | { ok: false; reason: string; code: "engine_mismatch" | "invalid_engine" | "task_not_found" };

export type PinResult =
  | { ok: true; code: "pinned" | "already_pinned" }
  | { ok: false; reason: string; code: string };

export type UnpinResult =
  | { ok: true; code: "unpinned" }
  | { ok: false; reason: string; code: string };

export type AdmissionInspection =
  | { eligible: true; code: "eligible" | "already_pinned"; engine: WorkflowEngine; status: string }
  | { eligible: false; code: string; reason: string; engine: WorkflowEngine; status: string };

type AdmissionTaskSnapshot = {
  id: string;
  status: string;
  workflowEngine: string;
  workflowVersion: number;
  activeWorkflowCycleId: string | null;
  workflowEnginePinnedAt: Date | null;
  projectId: string;
  updatedAt: Date;
};

async function findQuiescenceBlocker(
  tx: Prisma.TransactionClient,
  task: AdmissionTaskSnapshot,
): Promise<{ code: string; reason: string } | null> {
  if (!MUTATION_ADMISSION_STATUSES.has(task.status)) {
    return {
      code: "status_not_approved",
      reason: `Task status "${task.status}" is not quiescent (Backlog, To Do, or Done).`,
    };
  }

  if (task.activeWorkflowCycleId) {
    return {
      code: "active_cycle",
      reason: "Task has an active workflow cycle.",
    };
  }

  const [activeRepositoryRun, activeProcedure, activePmRun, activeContinuation, activeOutbox, unsettledReceipt] =
    await Promise.all([
      tx.taskRepositoryRun.findFirst({
        where: { taskId: task.id, phase: { in: [...ACTIVE_REPOSITORY_PHASES] } },
        select: { id: true, phase: true },
      }),
      tx.taskProcedureRun.findFirst({
        where: { taskId: task.id, status: { not: "completed" } },
        select: { id: true, status: true },
      }),
      tx.pmChannelRun.findFirst({
        where: { taskId: task.id, status: { notIn: [...TERMINAL_PM_RUN_STATUSES] } },
        select: { id: true, status: true },
      }),
      tx.pmChannelContinuation.findFirst({
        where: { taskId: task.id, status: { in: ["armed", "queued"] } },
        select: { id: true, status: true },
      }),
      tx.workflowOutbox.findFirst({
        where: { taskId: task.id, status: { not: "completed" } },
        select: { id: true, status: true },
      }),
      tx.taskWorkflowCommandReceipt.findFirst({
        where: { taskId: task.id, status: "accepted" },
        select: { id: true },
      }),
    ]);

  if (activeRepositoryRun) {
    return {
      code: "active_repository_work",
      reason: `Task has repository work in phase "${activeRepositoryRun.phase}".`,
    };
  }
  if (activeProcedure) {
    return {
      code: "active_procedure",
      reason: `Task has a procedure in status "${activeProcedure.status}".`,
    };
  }
  if (activePmRun) {
    return {
      code: "active_execution_run",
      reason: `Task has a PM execution run in status "${activePmRun.status}".`,
    };
  }
  if (activeContinuation) {
    return {
      code: "active_continuation",
      reason: `Task has a continuation in status "${activeContinuation.status}".`,
    };
  }
  if (activeOutbox) {
    return {
      code: "active_recovery_work",
      reason: `Task has a workflow effect in status "${activeOutbox.status}".`,
    };
  }
  if (unsettledReceipt) {
    return {
      code: "unsettled_receipt",
      reason: "Task has an accepted command whose mechanical work is not settled.",
    };
  }
  return null;
}

/** Read-only admission inspection used by dry-run/reporting surfaces. */
export async function inspectTaskAdmission(
  tx: Prisma.TransactionClient,
  taskId: string,
  opts: { projectInCohort: boolean },
): Promise<AdmissionInspection | null> {
  const task = await tx.task.findUnique({
    where: { id: taskId, deletedAt: null },
    select: {
      id: true,
      status: true,
      workflowEngine: true,
      workflowVersion: true,
      activeWorkflowCycleId: true,
      workflowEnginePinnedAt: true,
      projectId: true,
      updatedAt: true,
    },
  });
  if (!task) return null;

  const engine = ALLOWED_ENGINES.has(task.workflowEngine)
    ? task.workflowEngine as WorkflowEngine
    : ENGINE_LEGACY;
  if (!ALLOWED_ENGINES.has(task.workflowEngine)) {
    return {
      eligible: false,
      code: "invalid_engine",
      reason: `Task has unknown engine value: ${task.workflowEngine}`,
      engine,
      status: task.status,
    };
  }
  if (engine === ENGINE_ORCHESTRATOR_V2) {
    return { eligible: true, code: "already_pinned", engine, status: task.status };
  }
  if (!opts.projectInCohort) {
    return {
      eligible: false,
      code: "project_not_in_cohort",
      reason: "Project is not in the Phase E effectful mutation cohort.",
      engine,
      status: task.status,
    };
  }
  const blocker = await findQuiescenceBlocker(tx, task);
  if (blocker) return { eligible: false, ...blocker, engine, status: task.status };
  return { eligible: true, code: "eligible", engine, status: task.status };
}

// --- Read ----------------------------------------------------------------

/**
 * Resolve the durable engine ownership for a task. Falls through to the
 * active cycle's engine when a cycle is open. If task and active-cycle
 * ownership disagree, returns an invariant error — never heuristically
 * resolves.
 */
export async function resolveEngineOwnership(
  tx: OwnershipDbClient,
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
    operatorUserId?: string | null;
    evidenceId?: string | null;
    cohortStage?: string | null;
    authorizationCommentId?: string | null;
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
      workflowVersion: true,
      workflowEnginePinnedAt: true,
      updatedAt: true,
    },
  });

  if (!task) {
    return { ok: false, reason: "Task not found.", code: "task_not_found" };
  }

  // Already pinned — idempotent success.
  if (task.workflowEngine === ENGINE_ORCHESTRATOR_V2) {
    return { ok: true, code: "already_pinned" };
  }

  // Precondition: project must be in the effectful Phase E cohort.
  if (!opts.projectInCohort) {
    return {
      ok: false,
      reason: "Project is not in the Phase E effectful mutation cohort.",
      code: "project_not_in_cohort",
    };
  }

  const blocker = await findQuiescenceBlocker(tx, task);
  if (blocker) {
    if (blocker.code === "active_cycle") return { ok: false, ...blocker, code: "open_cycle_exists" };
    if (blocker.code === "active_repository_work") return { ok: false, ...blocker, code: "active_repo_job" };
    return { ok: false, ...blocker };
  }

  // Compare-and-set across the admission fence. A concurrent task transition,
  // preparation run, or ownership job changes at least one predicate and the
  // pin is rejected instead of producing mixed task/cycle ownership.
  const pinnedAt = new Date();
  const updated = await tx.task.updateMany({
    where: {
      id: task.id,
      workflowEngine: ENGINE_LEGACY,
      workflowVersion: task.workflowVersion,
      status: task.status,
      activeWorkflowCycleId: null,
      updatedAt: task.updatedAt,
    },
    data: {
      workflowEngine: ENGINE_ORCHESTRATOR_V2,
      workflowEnginePinnedAt: pinnedAt,
    },
  });
  if (updated.count !== 1) {
    return {
      ok: false,
      code: "admission_fence_changed",
      reason: "Task state changed while admission was being evaluated; retry from a fresh report.",
    };
  }

  const payload = {
    from: ENGINE_LEGACY,
    to: ENGINE_ORCHESTRATOR_V2,
    pinnedAt: pinnedAt.toISOString(),
    ...(opts.evidenceId ? { evidenceId: opts.evidenceId } : {}),
    ...(opts.cohortStage ? { cohortStage: opts.cohortStage } : {}),
    ...(opts.authorizationCommentId ? { authorizationCommentId: opts.authorizationCommentId } : {}),
  };
  await writeDeduplicatedActivity({
    client: tx,
    projectId: task.projectId,
    taskId: task.id,
    userId: opts.operatorUserId ?? null,
    kind: "task.workflow.engine_pinned",
    payload,
    dedupeKey: computeActivityDedupeKey("task.workflow.engine_pinned", task.id, payload),
  });

  return { ok: true, code: "pinned" };
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
      status: true,
      workflowVersion: true,
      workflowEnginePinnedAt: true,
      updatedAt: true,
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

  const blocker = await findQuiescenceBlocker(tx, task);
  if (blocker) return { ok: false, ...blocker };

  const updated = await tx.task.updateMany({
    where: {
      id: task.id,
      workflowEngine: ENGINE_ORCHESTRATOR_V2,
      workflowVersion: task.workflowVersion,
      status: task.status,
      activeWorkflowCycleId: null,
      workflowEnginePinnedAt: task.workflowEnginePinnedAt,
      updatedAt: task.updatedAt,
    },
    data: {
      workflowEngine: ENGINE_LEGACY,
      workflowEnginePinnedAt: null,
    },
  });
  if (updated.count !== 1) {
    return {
      ok: false,
      code: "admission_fence_changed",
      reason: "Task state changed while unpinning was being evaluated; retry from a fresh report.",
    };
  }

  // Audit the unpin.
  const payload = {
    from: ENGINE_ORCHESTRATOR_V2,
    to: ENGINE_LEGACY,
    pinnedAt: task.workflowEnginePinnedAt?.toISOString() ?? null,
  };
  await writeDeduplicatedActivity({
    client: tx,
    projectId: task.projectId,
    taskId: task.id,
    userId: opts.operatorUserId,
    kind: "task.workflow.engine_unpinned",
    payload,
    dedupeKey: computeActivityDedupeKey("task.workflow.engine_unpinned", task.id, payload),
  });

  return { ok: true, code: "unpinned" };
}

// --- Rollback admission --------------------------------------------------

/**
 * Check whether a project is in the effectful Phase E mutation cohort.
 * This is separate from the compute-only comparison flags (§5.3).
 * Removing a project from this allowlist stops new pins but never reroutes
 * an already-pinned task or open cycle to legacy.
 */
export function isProjectInMutationCohort(projectSlug: string): boolean {
  return isV2MutationAdmissionEnabledForProject(projectSlug);
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
