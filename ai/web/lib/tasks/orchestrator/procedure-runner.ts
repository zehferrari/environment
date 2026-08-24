// ORCH-03 — Durable procedure runner.
//
// Finds the first runnable step whose predecessors completed, claims it
// atomically with a lease, executes a named handler from a closed registry,
// persists bounded output, and makes the next step available. On transient
// failure, clears the lease and retries with exponential backoff. On terminal
// failure or exhausted attempts, marks the procedure operational_error,
// alerts the reporter, and creates an activity row. Reclaims expired leases
// after a worker crash.
//
// Invariant 11: ordered procedures — a later step cannot run until all
// required predecessor steps completed.
// Invariant 12: bounded recovery — every retry has a lease, attempt limit,
// backoff, terminal operational-error state, and visible audit record.
//
// Handlers may:
//   - create a durable workflow outbox effect;
//   - call an existing repository spool enqueue function;
//   - wait for a callback identified by job ID (enter waiting_callback);
//   - invoke the orchestration command boundary for a mechanical transition;
//   - publish a PM notification.
// Handlers may NOT directly change task status.

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getProcedureDefinition, getLatestProcedureDefinition } from "@/lib/tasks/orchestrator/procedures";
import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";
import { writeDeduplicatedActivity, computeActivityDedupeKey } from "@/lib/tasks/orchestrator/activity-dedup";

const LEASE_MS = 2 * 60_000;
const DEFAULT_BATCH = 20;
const MAX_BACKOFF_MS = 15 * 60_000;

export type StepHandlerResult =
  | { status: "completed"; output?: Record<string, unknown> }
  | { status: "waiting_callback"; jobId: string; output?: Record<string, unknown> }
  | { status: "failed"; error: string; retryable: boolean };

export type StepHandlerContext = {
  procedureRunId: string;
  stepId: string;
  taskId: string;
  workflowCycleId: string | null;
  input: Record<string, unknown> | null;
  // The procedure run's trigger transition id, for handlers that need to
  // reference the originating decision.
  triggerTransitionId: string;
};

export type StepHandler = (ctx: StepHandlerContext) => Promise<StepHandlerResult>;

// Closed registry of step handlers. Handlers are registered at module load
// time by the procedure implementations (ORCH-04..07). A handler that is not
// registered causes the step to fail terminally — procedure definitions are
// static code, and a missing handler is a bug, not a transient failure.
//
// PHASEE-06: The registry is now versioned — keyed by
// `${procedureType}:${version}:${stepName}`. getStepHandler resolves by exact
// version match ONLY. A run stamped definitionVersion=N with no registered vN
// handler must fail to operational_error with alertReporter, never execute a
// different version's handler. Silent cross-version fallback is prohibited —
// it would defeat the purpose of versioning. If a compatibility window is
// genuinely wanted later, it needs an explicit per-definition `compatibleWith`
// declaration, not an implicit latest-wins lookup.
const handlerRegistry = new Map<string, StepHandler>();

export function registerStepHandler(
  procedureType: TaskProcedureType,
  version: number,
  stepName: string,
  handler: StepHandler,
): void {
  handlerRegistry.set(`${procedureType}:${version}:${stepName}`, handler);
}

export function clearStepHandlerRegistry(): void {
  handlerRegistry.clear();
}

/**
 * Resolve a step handler by exact (procedureType, version, stepName) match.
 * No cross-version fallback — a missing exact match returns undefined and
 * the runner must fail the step to operational_error with alertReporter.
 */
export function getStepHandler(
  procedureType: TaskProcedureType,
  version: number,
  stepName: string,
): StepHandler | undefined {
  return handlerRegistry.get(`${procedureType}:${version}:${stepName}`);
}

// --- Callback matching (§6.4) --------------------------------------------
// Repository callbacks must match all identifiers: procedure id, step id,
// task id, cycle id, job id, and expected candidate/base SHA where applicable.
// A duplicate callback replays the already-completed step. A callback for an
// older cycle is rejected.
export type ProcedureCallback = {
  procedureRunId: string;
  stepId: string;
  taskId: string;
  workflowCycleId: string | null;
  jobId: string;
  candidateSha?: string | null;
  baseSha?: string | null;
  // PHASEE-07: V2 identity fields for exact callback correlation.
  schemaVersion?: number;
  commandReceiptId?: string | null;
  repositoryRunId?: string | null;
  repositoryRunVersion?: number | null;
  // Additional callback data (e.g. validationOutcome, error) stored in the
  // step output for the next handler to consume.
  data?: Record<string, unknown>;
};

// PHASEE-07: Compute a stable dedupe fingerprint for a callback mismatch or
// replay activity. Repeated identical mismatches increment a counter or are
// suppressed — never spam.
function callbackMismatchFingerprint(callback: ProcedureCallback, reason: string): string {
  const parts = [
    callback.procedureRunId,
    callback.stepId,
    callback.taskId,
    callback.workflowCycleId ?? "null",
    callback.jobId,
    callback.candidateSha ?? "null",
    callback.baseSha ?? "null",
    reason,
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

// PHASEE-07: Record a callback mismatch or replay as a deduplicated ActivityLog
// row. Repeated identical mismatches/replays suppress — never create user
// comments.
async function recordCallbackActivity(args: {
  projectId: string;
  taskId: string;
  kind: string;
  fingerprint: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  // Check for an existing activity with the same fingerprint in the last 24h.
  // If found, suppress (deduplicate). Otherwise create a new row.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await db.activityLog.findFirst({
    where: {
      taskId: args.taskId,
      kind: args.kind,
      createdAt: { gte: since },
      payload: { contains: args.fingerprint },
    },
    select: { id: true },
  });
  if (existing) return; // suppress — deduplicated
  await db.activityLog.create({
    data: {
      projectId: args.projectId,
      taskId: args.taskId,
      kind: args.kind,
      payload: JSON.stringify({ ...args.payload, fingerprint: args.fingerprint }),
    },
  });
}

export async function applyProcedureCallback(callback: ProcedureCallback): Promise<{ applied: boolean; reason: string }> {
  const step = await db.taskProcedureStep.findUnique({
    where: { id: callback.stepId },
    include: {
      procedureRun: {
        select: {
          id: true,
          taskId: true,
          workflowCycleId: true,
          type: true,
          status: true,
        },
      },
    },
  });
  // PHASEE-07 Fix #1: Use step.procedureRun.taskId (the trusted owner) for
  // ActivityLog FK, not callback.taskId (untrusted/stale in a mismatch).
  // The offending callback.taskId is preserved inside the payload.
  const trustedTaskId = step?.procedureRun?.taskId ?? null;
  // PHASEE-07 Fix #3: When the step is not found, fall back to callback.taskId
  // to look up the task so we can still record the mismatch activity.
  const taskIdForLookup = trustedTaskId ?? callback.taskId;
  const taskRow = taskIdForLookup
    ? await db.task.findUnique({
        where: { id: taskIdForLookup },
        select: { projectId: true, activeWorkflowCycleId: true },
      })
    : null;
  const projectId = taskRow?.projectId ?? null;

  if (!step || !step.procedureRun) {
    // PHASEE-07 Fix #3: Record the step_not_found mismatch using callback.taskId
    // so the mismatch is visible in activity logs, not silently dropped.
    if (projectId && callback.taskId) {
      await recordCallbackActivity({
        projectId,
        taskId: callback.taskId,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, "step_not_found"),
        payload: { reason: "Step not found for callback.", callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: "Step not found." };
  }
  if (step.procedureRun.id !== callback.procedureRunId) {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, "procedure_id_mismatch"),
        payload: { reason: "Procedure id mismatch.", callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: "Procedure id mismatch." };
  }
  if (step.procedureRun.taskId !== callback.taskId) {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, "task_id_mismatch"),
        payload: { reason: "Task id mismatch.", callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: "Task id mismatch." };
  }
  if (step.procedureRun.workflowCycleId !== callback.workflowCycleId) {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, "cycle_id_mismatch"),
        payload: { reason: "Cycle id mismatch.", callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: "Cycle id mismatch — callback is from an older or different cycle." };
  }
  if (taskRow?.activeWorkflowCycleId !== callback.workflowCycleId) {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, `active_cycle_mismatch:${taskRow?.activeWorkflowCycleId ?? "null"}`),
        payload: {
          reason: "Task active cycle does not match callback cycle.",
          activeWorkflowCycleId: taskRow?.activeWorkflowCycleId ?? null,
          callbackTaskId: callback.taskId,
          callback,
        },
      });
    }
    return { applied: false, reason: "Task active cycle does not match callback cycle." };
  }
  // Verify the job id matches the one stored in step output when the step
  // entered waiting_callback.
  let storedJobId: string | null = null;
  if (step.output) {
    try {
      const parsed = JSON.parse(step.output) as Record<string, unknown>;
      storedJobId = typeof parsed.jobId === "string" ? parsed.jobId : null;
    } catch {
      // ignore
    }
  }
  if (storedJobId && storedJobId !== callback.jobId) {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, "job_id_mismatch"),
        payload: { reason: "Job id mismatch.", storedJobId, callbackJobId: callback.jobId, callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: "Job id mismatch." };
  }
  // P1-6: verify the callback's candidate/base SHA match the expected values
  // stored in step output, if the step recorded them.
  let expectedCandidateSha: string | null = null;
  let expectedBaseSha: string | null = null;
  if (step.output) {
    try {
      const parsed = JSON.parse(step.output) as Record<string, unknown>;
      if (typeof parsed.candidateSha === "string") expectedCandidateSha = parsed.candidateSha;
      if (typeof parsed.baseSha === "string") expectedBaseSha = parsed.baseSha;
    } catch { /* ignore */ }
  }
  if (callback.candidateSha !== undefined && callback.candidateSha !== null
    && expectedCandidateSha && callback.candidateSha !== expectedCandidateSha) {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, `candidate_sha_mismatch:${callback.candidateSha}:${expectedCandidateSha}`),
        payload: { reason: `Candidate SHA mismatch: callback has ${callback.candidateSha}, expected ${expectedCandidateSha}.`, callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: `Candidate SHA mismatch: callback has ${callback.candidateSha}, expected ${expectedCandidateSha}.` };
  }
  // A3: also check baseSha if both expected and callback values are present.
  if (callback.baseSha !== undefined && callback.baseSha !== null
    && expectedBaseSha && callback.baseSha !== expectedBaseSha) {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, `base_sha_mismatch:${callback.baseSha}:${expectedBaseSha}`),
        payload: { reason: `Base SHA mismatch: callback has ${callback.baseSha}, expected ${expectedBaseSha}.`, callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: `Base SHA mismatch: callback has ${callback.baseSha}, expected ${expectedBaseSha}.` };
  }
  // Idempotent: a duplicate callback for an already-completed step is a no-op.
  // PHASEE-07: record it as a deduplicated replay activity.
  // PHASEE-07 Fix #2a: Move publicationState/replayCount logic HERE — before the
  // completed-step return — so that a duplicate callback (replay) actually
  // reaches the counter. Previously this block sat after the return and was
  // dead code. Also write "pending" when a replay is detected so the state
  // lifecycle is complete: publishing -> published -> pending (on replay).
  if (step.status === "completed") {
    // Update publication state: this is a replay of a previously-published job.
    // The row should already be in "published" state from the first callback.
    try {
      const existingRun = await db.taskRepositoryRun.findUnique({
        where: { taskId: trustedTaskId! },
        select: { id: true, publicationState: true, replayCount: true },
      });
      if (existingRun) {
        await db.taskRepositoryRun.update({
          where: { id: existingRun.id },
          data: {
            publicationState: "pending",
            replayCount: existingRun.replayCount + 1,
          },
        });
      }
    } catch (e) {
      // Narrow catch: only tolerate a missing TaskRepositoryRun row (P2025).
      // Other errors (e.g. unknown field) should surface, not be swallowed.
      if (!(e instanceof Error && 'code' in e && (e as { code: string }).code === 'P2025')) {
        throw e;
      }
    }
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.replayed",
        fingerprint: callbackMismatchFingerprint(callback, "replay"),
        payload: { reason: "Step already completed (duplicate callback replayed).", callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: true, reason: "Step already completed (duplicate callback replayed)." };
  }
  if (step.status !== "waiting_callback") {
    if (projectId) {
      await recordCallbackActivity({
        projectId,
        taskId: trustedTaskId!,
        kind: "task.workflow.callback.mismatch",
        fingerprint: callbackMismatchFingerprint(callback, `wrong_status:${step.status}`),
        payload: { reason: `Step is in ${step.status}, not waiting_callback.`, callbackTaskId: callback.taskId, callback },
      });
    }
    return { applied: false, reason: `Step is in ${step.status}, not waiting_callback.` };
  }
  // PHASEE-07 Fix #2a: On first successful callback, transition publicationState
  // from "publishing" to "published". The replayCount increment happens in the
  // completed-step branch above (since a replay is a duplicate callback for an
  // already-completed step). Narrow catch: only tolerate a missing
  // TaskRepositoryRun row (P2025), not all errors.
  try {
    const existingRun = await db.taskRepositoryRun.findUnique({
      where: { taskId: trustedTaskId! },
      select: { id: true, publicationState: true, replayCount: true },
    });
    if (existingRun) {
      await db.taskRepositoryRun.update({
        where: { id: existingRun.id },
        data: {
          publicationState: "published",
        },
      });
    }
  } catch (e) {
    // Narrow catch: only tolerate a missing TaskRepositoryRun row (P2025).
    // Other errors should surface, not be swallowed.
    if (!(e instanceof Error && 'code' in e && (e as { code: string }).code === 'P2025')) {
      throw e;
    }
  }

  // Mark the step completed; the runner picks up the next step on the next
  // poll. The callback's evidence (candidateSha, baseSha, validationOutcome,
  // error) is stored in step output for the next step's handler to consume.
  const output: Record<string, unknown> = { jobId: callback.jobId };
  if (callback.candidateSha !== undefined) output.candidateSha = callback.candidateSha;
  if (callback.baseSha !== undefined) output.baseSha = callback.baseSha;
  // PHASEE-07: persist V2 identity fields in step output for crash-replay.
  if (callback.schemaVersion !== undefined) output.schemaVersion = callback.schemaVersion;
  if (callback.commandReceiptId !== undefined) output.commandReceiptId = callback.commandReceiptId;
  if (callback.repositoryRunId !== undefined) output.repositoryRunId = callback.repositoryRunId;
  if (callback.repositoryRunVersion !== undefined) output.repositoryRunVersion = callback.repositoryRunVersion;
  if (callback.data) Object.assign(output, callback.data);
  await db.taskProcedureStep.update({
    where: { id: step.id },
    data: {
      status: "completed",
      completedAt: new Date(),
      output: JSON.stringify(output),
      lastError: null,
    },
  });
  // Make the next step available (the runner's predecessor check handles this
  // on the next poll, but we also wake the procedure run).
  await db.taskProcedureRun.update({
    where: { id: step.procedureRun.id },
    data: { status: "queued", currentStep: null },
  });
  if (projectId) {
    await recordCallbackActivity({
      projectId,
      taskId: trustedTaskId!,
      kind: "task.workflow.callback.applied",
      fingerprint: callbackMismatchFingerprint(callback, "applied"),
      payload: {
        reason: "Exact schema-v2 callback applied.",
        activeWorkflowCycleId: taskRow?.activeWorkflowCycleId ?? null,
        callback,
      },
    });
  }
  return { applied: true, reason: "Callback applied; step completed." };
}

// --- Runner ---------------------------------------------------------------

export async function runProcedureRunner(args: {
  limit?: number;
  now?: Date;
  workerId?: string;
} = {}): Promise<{ claimed: number; completed: number; retried: number; failed: number; waiting: number }> {
  const now = args.now ?? new Date();
  const limit = Math.max(1, Math.min(100, args.limit ?? DEFAULT_BATCH));
  const workerId = args.workerId ?? `procedure-runner:${process.pid}`;
  let claimed = 0;
  let completed = 0;
  let retried = 0;
  let failed = 0;
  let waiting = 0;

  for (let index = 0; index < limit; index += 1) {
    // Find the first runnable step whose predecessors all completed.
    const candidate = await findRunnableStep(now);
    if (!candidate) break;

    // Claim it atomically with a lease.
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const claimedRow = await db.taskProcedureStep.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["pending", "failed"] },
        availableAt: { lte: now },
      },
      data: {
        status: "running",
        leaseOwner: workerId,
        leaseExpiresAt,
        attempts: { increment: 1 },
        startedAt: now,
        lastError: null,
      },
    });
    if (claimedRow.count !== 1) continue;
    claimed += 1;

    const step = await db.taskProcedureStep.findUnique({
      where: { id: candidate.id },
      include: {
        procedureRun: {
          select: {
            id: true,
            taskId: true,
            workflowCycleId: true,
            type: true,
            triggerTransitionId: true,
            status: true,
            input: true,
            definitionVersion: true,
          },
        },
      },
    });
    if (!step || !step.procedureRun) continue;

    // Mark the procedure run as running.
    await db.taskProcedureRun.update({
      where: { id: step.procedureRun.id },
      data: { status: "running", currentStep: step.name },
    });

    // PHASEE-06: Resolve handler by exact (type, definitionVersion, stepName).
    // No cross-version fallback — a missing handler for the run's stamped
    // version is a terminal operational_error with alertReporter.
    const runDefVersion = step.procedureRun.definitionVersion ?? 1;
    const handler = getStepHandler(step.procedureRun.type as TaskProcedureType, runDefVersion, step.name);
    if (!handler) {
      // No handler registered for this exact version — terminal failure.
      // This is precisely the failure versioning exists to prevent: never
      // execute a different version's handler silently.
      const maxAttempts = getLatestProcedureDefinition(step.procedureRun.type as TaskProcedureType).maxAttemptsPerStep;
      await markStepTerminal({
        stepId: step.id,
        procedureRunId: step.procedureRun.id,
        error: `No handler registered for ${step.procedureRun.type}:v${runDefVersion}:${step.name} — version mismatch is a terminal error`,
        retryable: false,
        attempts: step.attempts,
        maxAttempts,
        workerId,
      });
      failed += 1;
      continue;
    }

    let input: Record<string, unknown> | null = null;
    if (step.input) {
      try { input = JSON.parse(step.input) as Record<string, unknown>; } catch { /* ignore */ }
    }
    const ctx: StepHandlerContext = {
      procedureRunId: step.procedureRun.id,
      stepId: step.id,
      taskId: step.procedureRun.taskId,
      workflowCycleId: step.procedureRun.workflowCycleId,
      input,
      triggerTransitionId: step.procedureRun.triggerTransitionId,
    };

    try {
      const result = await handler(ctx);
      if (result.status === "completed") {
        await db.taskProcedureStep.update({
          where: { id: step.id },
          data: {
            status: "completed",
            completedAt: new Date(),
            output: result.output ? JSON.stringify(result.output) : step.output,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
          },
        });
        completed += 1;
        // Make the next step available; check if the procedure is complete.
        await advanceProcedure(step.procedureRun.id);
      } else if (result.status === "waiting_callback") {
        await db.taskProcedureStep.update({
          where: { id: step.id },
          data: {
            status: "waiting_callback",
            output: JSON.stringify({ ...result.output ?? {}, jobId: result.jobId }),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        waiting += 1;
      } else if (result.status === "failed") {
        const maxAttempts = (getProcedureDefinition(step.procedureRun.type as TaskProcedureType, step.procedureRun.definitionVersion ?? 1) ?? getLatestProcedureDefinition(step.procedureRun.type as TaskProcedureType)).maxAttemptsPerStep;
        if (result.retryable && step.attempts < maxAttempts) {
          // Transient failure: clear lease, retry with backoff.
          const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(step.attempts, 6));
          await db.taskProcedureStep.update({
            where: { id: step.id },
            data: {
              status: "failed",
              availableAt: new Date(now.getTime() + backoff),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: result.error.slice(0, 2000),
            },
          });
          retried += 1;
        } else {
          // Terminal failure or exhausted attempts.
          await markStepTerminal({
            stepId: step.id,
            procedureRunId: step.procedureRun.id,
            error: result.error,
            retryable: result.retryable,
            attempts: step.attempts,
            maxAttempts,
            workerId,
          });
          failed += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = (getProcedureDefinition(step.procedureRun.type as TaskProcedureType, step.procedureRun.definitionVersion ?? 1) ?? getLatestProcedureDefinition(step.procedureRun.type as TaskProcedureType)).maxAttemptsPerStep;
      if (step.attempts < maxAttempts) {
        const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(step.attempts, 6));
        await db.taskProcedureStep.update({
          where: { id: step.id },
          data: {
            status: "failed",
            availableAt: new Date(now.getTime() + backoff),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: message.slice(0, 2000),
          },
        });
        retried += 1;
      } else {
        await markStepTerminal({
          stepId: step.id,
          procedureRunId: step.procedureRun.id,
          error: message,
          retryable: true,
          attempts: step.attempts,
          maxAttempts,
          workerId,
        });
        failed += 1;
      }
    }
  }
  // Reclaim expired leases from worker crashes.
  await reclaimExpiredLeases(now, workerId);
  return { claimed, completed, retried, failed, waiting };
}

// --- Find the first runnable step whose predecessors completed ------------
async function findRunnableStep(now: Date) {
  // A step is runnable if:
  //   - its status is pending or failed-with-backoff-elapsed;
  //   - its availableAt <= now;
  //   - all predecessor steps (lower ordinal in the same run) are completed.
  // We query candidate steps then filter by predecessor completion in JS to
  // avoid a complex SQL join on SQLite.
  const candidates = await db.taskProcedureStep.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      availableAt: { lte: now },
      procedureRun: { status: { in: ["queued", "running", "operational_error"] } },
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: 50,
    select: { id: true, procedureRunId: true, ordinal: true, name: true },
  });
  for (const candidate of candidates) {
    const predecessors = await db.taskProcedureStep.count({
      where: {
        procedureRunId: candidate.procedureRunId,
        ordinal: { lt: candidate.ordinal },
        status: { not: "completed" },
      },
    });
    if (predecessors === 0) return candidate;
  }
  return null;
}

async function advanceProcedure(procedureRunId: string): Promise<void> {
  const steps = await db.taskProcedureStep.findMany({
    where: { procedureRunId },
    orderBy: { ordinal: "asc" },
    select: { id: true, name: true, ordinal: true, status: true },
  });
  const allCompleted = steps.length > 0 && steps.every((s) => s.status === "completed");
  if (allCompleted) {
    const completedAt = new Date();
    await db.$transaction([
      db.taskProcedureRun.update({
        where: { id: procedureRunId },
        data: { status: "completed", currentStep: null, completedAt },
      }),
      db.taskWorkflowCommandReceipt.updateMany({
        where: { procedureRunId, status: "accepted" },
        data: { status: "completed" },
      }),
    ]);
  } else {
    // Wake the procedure so the next runnable step is picked up.
    await db.taskProcedureRun.update({
      where: { id: procedureRunId },
      data: { status: "queued" },
    });
  }
}

async function markStepTerminal(args: {
  stepId: string;
  procedureRunId: string;
  error: string;
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
  workerId: string;
}): Promise<void> {
  await db.taskProcedureStep.update({
    where: { id: args.stepId },
    data: {
      status: "terminal_error",
      lastError: args.error.slice(0, 2000),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await db.taskProcedureRun.update({
    where: { id: args.procedureRunId },
    data: {
      status: "operational_error",
      currentStep: null,
      lastError: `Step ${args.stepId} failed terminally after ${args.attempts} attempts: ${args.error.slice(0, 500)}`,
    },
  });
  // Alert the reporter via task.alertReporter + an activity row (§6.2 rule 7).
  const run = await db.taskProcedureRun.findUnique({
    where: { id: args.procedureRunId },
    select: { taskId: true, type: true },
  });
  if (run) {
    const task = await db.task.findUnique({ where: { id: run.taskId }, select: { projectId: true, reporterId: true } });
    if (task) {
      await db.task.updateMany({
        where: { id: run.taskId, deletedAt: null },
        data: { alertReporter: true },
      });
      await writeDeduplicatedActivity({
        projectId: task.projectId,
        taskId: run.taskId,
        kind: "task.workflow.procedure_operational_error",
        payload: {
          procedureRunId: args.procedureRunId,
          procedureType: run.type,
          stepId: args.stepId,
          error: args.error.slice(0, 1000),
          attempts: args.attempts,
          retryable: args.retryable,
          workerId: args.workerId,
        },
        dedupeKey: computeActivityDedupeKey(
          "task.workflow.procedure_operational_error",
          run.taskId,
          {
            procedureRunId: args.procedureRunId,
            stepId: args.stepId,
            error: args.error.slice(0, 1000),
          },
        ),
      });
    }
  }
}

async function reclaimExpiredLeases(now: Date, workerId: string): Promise<void> {
  // Steps with expired leases are returned to pending/failed so a worker
  // crash doesn't strand a procedure. The predecessor check still applies.
  const expired = await db.taskProcedureStep.updateMany({
    where: {
      status: "running",
      leaseExpiresAt: { lte: now },
    },
    data: {
      status: "failed",
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "Lease expired (worker crash or timeout).",
    },
  });
  if (expired.count > 0) {
    console.log(`[procedure-runner] reclaimed ${expired.count} expired lease(s) (worker ${workerId})`);
  }
}

// --- Procedure creation (called by execute.ts) ----------------------------
// Creates a TaskProcedureRun + its ordered TaskProcedureStep rows in one
// transaction. Called by the orchestrator's execute path when a decision
// names a procedureType.
export async function createProcedureRun(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    workflowCycleId: string | null;
    triggerTransitionId: string;
    type: TaskProcedureType;
    input?: Record<string, unknown> | null;
  },
): Promise<{ procedureRunId: string; stepIds: string[] }> {
  const def = getLatestProcedureDefinition(args.type);
  const run = await tx.taskProcedureRun.create({
    data: {
      taskId: args.taskId,
      workflowCycleId: args.workflowCycleId,
      triggerTransitionId: args.triggerTransitionId,
      type: args.type,
      definitionVersion: def.version,
      inputSchemaVersion: def.inputSchemaVersion,
      status: "queued",
      input: args.input ? JSON.stringify(args.input) : null,
    },
  });
  const stepIds: string[] = [];
  for (let i = 0; i < def.steps.length; i += 1) {
    const step = await tx.taskProcedureStep.create({
      data: {
        procedureRunId: run.id,
        name: def.steps[i],
        ordinal: i,
        status: "pending",
        availableAt: new Date(),
      },
    });
    stepIds.push(step.id);
  }
  return { procedureRunId: run.id, stepIds };
}
