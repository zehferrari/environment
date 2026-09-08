// ORCH-05 — start_implementation_cycle procedure handlers.
//
// Trigger: authorized assignee intent start_implementation from To Do.
//
// §17 side-effect ownership audit (PHASEE-06):
//   Row: implementation started — command owns: cycle, lane reservations,
//   In Progress transition, procedure, continuation. This procedure owns:
//   worktree recheck, episode/open turn dispatch. Compensation for terminal
//   worktree failure now goes through submitWorkflowCommand (command boundary)
//   instead of calling applyTaskTransition directly — no dual ownership.
//
// The transactional decision (executed by execute.ts) opens the next workflow
// cycle, moves To Do -> In Progress through the transition kernel, and creates
// this procedure. The procedure then:
//   1. revalidate_worktree — ensure the registered path, branch, base,
//      cleanliness, and Git identity still match the prepared snapshot.
//   2. open_execution_episode — bind a fresh execution episode to the new
//      cycle and assignee.
//   3. dispatch_implementation_turn — send a cycle-scoped notification
//      containing the prepared worktree path and the exact approved plan
//      revision.
//
// Failure behavior (§8):
//   - A failed revalidation must not leave the task silently In Progress. The
//     procedure records an operational error; the reconciler (ORCH-08) handles
//     the compensating transition back to To Do with explicit evidence.
//   - Never tell the agent to repair a PM-owned worktree registration failure
//     manually.

import { db } from "@/lib/db";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";
import { updateTaskRepositoryState } from "@/lib/tasks/repository-state";
import { openTaskExecutionEpisode } from "@/lib/agents/episodes/lifecycle";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";
import { registerStepHandler } from "@/lib/tasks/orchestrator/procedure-runner";
import type { StepHandlerResult, StepHandlerContext } from "@/lib/tasks/orchestrator/procedure-runner";
import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";
import { projectUsesRepository } from "@/lib/projects/work-mode";

const PROCEDURE_TYPE: TaskProcedureType = "start_implementation_cycle";

// --- Step 1: revalidate_worktree -----------------------------------------
// Ensure the registered path, branch, base, cleanliness, and Git identity
// still match the prepared snapshot from the prepare_todo_task procedure.
// A failed revalidation sets an operational error — the reconciler handles
// the compensating transition back to To Do.
async function revalidateWorktree(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      status: true,
      workflowVersion: true,
      approvedOn: true,
      approvedById: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true, agent: { select: { slug: true } } } },
      project: { select: { workMode: true, repositoryPath: true } },
      repositoryRun: { select: { phase: true, worktreePath: true, branchName: true, baseSha: true } },
    },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  if (task.status !== "In Progress") {
    // Task moved away from In Progress — supersede.
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  // Non-code tasks skip worktree revalidation.
  if (!projectUsesRepository(task.project)) {
    return { status: "completed", output: { skipped: true, reason: "non_code_task" } };
  }
  // Re-run the worktree claim helper which revalidates the existing worktree.
  try {
    const worktree = await ensureTaskCodeWorktree(ctx.taskId, task.assigneeId, { reconcile: false });
    if (!worktree.required) {
      return { status: "completed", output: { skipped: true, reason: "no_repository" } };
    }
    // Verify the base SHA hasn't changed since preparation.
    if (task.repositoryRun?.baseSha && task.repositoryRun.baseSha !== worktree.headSha) {
      // The worktree head moved since preparation — re-record it.
      await updateTaskRepositoryState(ctx.taskId, {
        phase: "active",
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        baseSha: worktree.headSha,
      });
    }
    return {
      status: "completed",
      output: {
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        baseSha: worktree.headSha,
        mode: worktree.mode,
      },
    };
  } catch (error) {
    const message = error instanceof TaskWorktreeError
      ? error.message
      : error instanceof Error ? error.message : String(error);
    const retryable = !(error instanceof TaskWorktreeError);
    // P1-8: record the operational error on the repository state. If the
    // failure is terminal (non-retryable), compensate by moving the task
    // back to To Do with explicit evidence — never leave the task silently
    // In Progress with a broken worktree.
    await updateTaskRepositoryState(ctx.taskId, {
      phase: "operational_error",
      lastError: `Worktree revalidation failed: ${message}`,
    });
    if (!retryable) {
      // Terminal worktree failure — compensate back to To Do through the
      // command boundary (§17: implementation_started row — command owns
      // the In Progress transition; procedure owns worktree recheck only).
      // The procedure must not call applyTaskTransition directly; it submits
      // a mechanical compensation intent through submitWorkflowCommand.
      try {
        const task = await db.task.findUniqueOrThrow({ where: { id: ctx.taskId }, select: { status: true, workflowVersion: true, activeWorkflowCycleId: true, assigneeId: true } });
        if (task.status === "In Progress") {
          const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
          await submitWorkflowCommand({
            taskId: ctx.taskId,
            intent: "worktree_revalidation_failed",
            actor: { id: task.assigneeId ?? "procedure-engine", kind: "agent", username: "procedure-engine", role: "monitor" },
            expectedWorkflowVersion: task.workflowVersion,
            workflowCycleId: task.activeWorkflowCycleId,
            idempotencyKey: `start-compensation:${ctx.procedureRunId}`,
            source: "callback",
            evidence: { worktreeRevalidationFailed: true, error: message, procedureRunId: ctx.procedureRunId, mechanical: true },
            payload: {
              procedureRunId: ctx.procedureRunId,
              procedureStepId: ctx.stepId,
              failureReason: `Worktree revalidation failed: ${message}`,
              outcome: "failed",
            },
          });
        }
      } catch (compensationError) {
        console.error("[pm] start compensation failed:", ctx.taskId, compensationError);
      }
    }
    return { status: "failed", error: `Worktree revalidation failed: ${message}`, retryable };
  }
}

// --- Step 2: open_execution_episode --------------------------------------
// Bind a fresh execution episode to the new cycle and assignee.
async function openExecutionEpisode(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  // Check if revalidation superseded the procedure. A "skipped" revalidation
  // (non-code task) does NOT skip the episode — non-code tasks still need an
  // execution episode.
  const revalStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "revalidate_worktree" },
    select: { output: true },
  });
  let revalOutput: Record<string, unknown> | null = null;
  if (revalStep?.output) {
    try { revalOutput = JSON.parse(revalStep.output); } catch { /* ignore */ }
  }
  if (revalOutput?.superseded === true) {
    return { status: "completed", output: { skipped: true, reason: revalOutput.reason } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      projectId: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true, agent: { select: { slug: true } } } },
    },
  });
  if (!task || !task.assigneeId || !task.assignee?.agent) {
    return { status: "failed", error: "Task has no assignee agent.", retryable: false };
  }
  // Authenticated start already committed episode + continuation ownership
  // with the command. Its receipt is durable even if the source turn has
  // finished, yielded, or been superseded before this procedure runs. Do not
  // open another episode or dispatch a turn that cancels that continuation.
  const receipt = await db.taskWorkflowCommandReceipt.findFirst({
    where: {
      taskId: ctx.taskId,
      procedureRunId: ctx.procedureRunId,
      intent: "start_implementation",
    },
    select: { result: true },
  });
  if (receipt?.result) {
    const result = JSON.parse(receipt.result) as { episode?: { episodeNo?: number } | null };
    if (result.episode) {
      return {
        status: "completed",
        output: {
          skipped: true,
          reason: "command_owns_execution_continuation",
          episodeNo: result.episode.episodeNo,
          agentSlug: task.assignee.agent.slug,
        },
      };
    }
  }
  const episode = await db.$transaction((tx) =>
    openTaskExecutionEpisode(tx, {
      taskId: task.id,
      projectId: task.projectId,
      agentSlug: task.assignee!.agent!.slug,
    }),
  );
  return {
    status: "completed",
    output: {
      episodeId: episode.episodeNo,
      episodeNo: episode.episodeNo,
      agentSlug: task.assignee.agent.slug,
    },
  };
}

// --- Step 3: dispatch_implementation_turn -------------------------------
// Send a cycle-scoped notification containing the prepared worktree path and
// the exact approved plan revision. The notification is an outbox effect —
// the drain handles PM-channel dispatch.
async function dispatchImplementationTurn(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  // Check if the episode step superseded the procedure.
  const episodeStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "open_execution_episode" },
    select: { output: true },
  });
  let episodeOutput: Record<string, unknown> | null = null;
  if (episodeStep?.output) {
    try { episodeOutput = JSON.parse(episodeStep.output); } catch { /* ignore */ }
  }
  if (episodeOutput?.skipped === true) {
    return { status: "completed", output: { skipped: true, reason: episodeOutput.reason } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true, agent: { select: { slug: true } } } },
      approvedOn: true,
      repositoryRun: { select: { worktreePath: true, branchName: true, baseSha: true } },
    },
  });
  if (!task || !task.assigneeId || !task.assignee) {
    return { status: "completed", output: { skipped: true, reason: "no_assignee" } };
  }
  const worktreePath = task.repositoryRun?.worktreePath ?? null;
  const branchName = task.repositoryRun?.branchName ?? null;
  const body = [
    `Start working on "${task.title}".`,
    worktreePath ? `Worktree: ${worktreePath}` : "No worktree required (non-code task).",
    branchName ? `Branch: ${branchName}` : null,
    "Implement the approved Action Plan. Use action=checkpoint to record progress, action=ready_for_review to submit for review.",
    "Do not create a branch or worktree — PM has already prepared it.",
  ].filter(Boolean).join("\n");
  await enqueueWorkflowEffects(db, {
    taskId: task.id,
    projectId: task.projectId,
    aggregateVersion: 0,
    effects: [{
      type: "task_notification",
      key: `start_implementation_cycle:dispatch:${task.id}:${ctx.procedureRunId}`,
      payload: {
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor: { id: task.assignee.id, kind: "agent", username: task.assignee.username },
        reason: "todo_start_required",
        body,
      },
    }],
  });
  return { status: "completed", output: { dispatched: true, targetUserId: task.assigneeId } };
}

// --- Register handlers ----------------------------------------------------
export function registerStartImplementationCycleHandlers(): void {
  registerStepHandler(PROCEDURE_TYPE, 1, "revalidate_worktree", revalidateWorktree);
  registerStepHandler(PROCEDURE_TYPE, 1, "open_execution_episode", openExecutionEpisode);
  registerStepHandler(PROCEDURE_TYPE, 1, "dispatch_implementation_turn", dispatchImplementationTurn);
}
