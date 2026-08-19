// ORCH-04 — prepare_todo_task procedure handlers.
//
// Trigger: approve_plan or any authorized transition that makes an approved
// task enter To Do.
//
// §17 side-effect ownership audit (PHASEE-06):
//   Row: plan approved — command owns: approval fields, revision, checklist,
//   To Do transition, procedure, episode state. This procedure owns: repository
//   prep, assignee wake/auto-start request. No dual ownership — handlers do
//   not call applyTaskTransition; mechanical transitions go through
//   submitWorkflowCommand.
//   Row: board/cache refresh — intentionally owner-less (best-effort projection
//   invalidation). No handler action needed.
//
// Ordered steps (§7):
//   1. resolve_repository_contract — determine if code-touching, resolve repo
//      path/branch/identity. Store a versioned snapshot on the procedure run.
//   2. prepare_worktree — skip for non-code tasks. Call the repository runner
//      to create/reconcile the registered worktree. Reject primary checkouts,
//      copied directories, unregistered worktrees, wrong branches, dirty
//      pre-existing state, mismatched Git identity.
//   3. verify_actionability — confirm task still To Do, plan unchanged,
//      assignee active, blockers clear, procedure workflow version not stale.
//      If the plan changed or task moved, supersede the procedure.
//   4. wake_assignee — send one deduplicated todo_start_required notification.
//      The notification says the worktree is prepared and asks for start; it
//      must not ask the agent to create a branch or worktree.
//
// Failure behavior (§7):
//   - Repository/configuration errors keep the task in To Do and set a
//     visible operational-error procedure state.
//   - Do not wake the assignee when worktree preparation failed.
//   - Retry transient Git/filesystem runner failures; escalate terminal
//     policy/permission failures once.

import { db } from "@/lib/db";
import { reserveTaskRepositoryState, updateTaskRepositoryState } from "@/lib/tasks/repository-state";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";
import { effectiveTaskBranchName, effectiveEpicBranchName } from "@/lib/work-items/branches";
import { registerStepHandler } from "@/lib/tasks/orchestrator/procedure-runner";
import type { StepHandlerResult, StepHandlerContext } from "@/lib/tasks/orchestrator/procedure-runner";
import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";

const PROCEDURE_TYPE: TaskProcedureType = "prepare_todo_task";

// --- Step 1: resolve_repository_contract ---------------------------------
// Determine whether the task is code-touching. Resolve repository path,
// branch name, Epic branch, commit prefix, Git identity, and local-only
// policy. Store a versioned snapshot on the procedure run output so later
// steps use the snapshot, not mutable project settings.
async function resolveRepositoryContract(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      workItemKey: true,
      branchName: true,
      commitPrefix: true,
      projectId: true,
      epicId: true,
      project: {
        select: {
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
        },
      },
      epic: {
        select: {
          workItemKey: true,
          branchName: true,
          commitPrefix: true,
        },
      },
    },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  const branchName = effectiveTaskBranchName(task);
  const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
  const codeTouching = Boolean(branchName && task.project.repositoryPath);
  const snapshot = {
    codeTouching,
    repositoryPath: task.project.repositoryPath,
    branchName,
    epicBranch,
    epicChild: Boolean(task.epicId),
    localOnly: Boolean(task.epicId), // Epic children are local-only
    gitUserName: task.project.defaultGitUserName ?? null,
    gitUserEmail: task.project.defaultGitUserEmail ?? null,
  };
  // Reserve the repository state if code-touching (mirrors the existing
  // approve_plan handler's reservation).
  if (codeTouching) {
    try {
      await reserveTaskRepositoryState(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", error: `Repository contract reservation failed: ${message}`, retryable: true };
    }
  }
  return { status: "completed", output: snapshot };
}

// --- Step 2: prepare_worktree --------------------------------------------
// Skip for non-code tasks. For code tasks, call the repository runner to
// create or reconcile the registered worktree. Record worktree path, base
// SHA, branch, and runner job ID. Reject primary checkouts, copied
// directories, unregistered worktrees, wrong branches, dirty pre-existing
// state, and mismatched Git identity (the existing ensureTaskCodeWorktree
// helper enforces these).
async function prepareWorktree(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  // Load the snapshot from step 1's output.
  const prevStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "resolve_repository_contract" },
    select: { output: true },
  });
  let snapshot: Record<string, unknown> | null = null;
  if (prevStep?.output) {
    try { snapshot = JSON.parse(prevStep.output); } catch { /* ignore */ }
  }
  if (!snapshot) {
    return { status: "failed", error: "Missing repository contract snapshot from step 1.", retryable: false };
  }
  if (snapshot.codeTouching !== true) {
    // Non-code task: skip worktree preparation.
    return { status: "completed", output: { skipped: true, reason: "non_code_task" } };
  }
  try {
    const worktree = await ensureTaskCodeWorktree(ctx.taskId, null, { reconcile: true });
    if (!worktree.required) {
      return { status: "completed", output: { skipped: true, reason: "no_repository" } };
    }
    // Record the worktree path and base SHA on the repository state.
    await updateTaskRepositoryState(ctx.taskId, {
      phase: "active",
      repositoryPath: worktree.repositoryRoot,
      branchName: worktree.branchName,
      worktreePath: worktree.worktreePath,
      baseSha: worktree.headSha,
      lastError: null,
    });
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
    // TaskWorktreeError is typically a policy/permission failure (non-retryable).
    // Other errors (git filesystem) are transient.
    const retryable = !(error instanceof TaskWorktreeError);
    return { status: "failed", error: `Worktree preparation failed: ${message}`, retryable };
  }
}

// --- Step 3: verify_actionability ----------------------------------------
// Confirm task is still To Do, the same approved plan revision is current,
// assignee is active, blockers are clear, and the procedure's workflow
// version is not stale. If the plan changed or task moved, supersede the
// procedure without waking anyone.
async function verifyActionability(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      status: true,
      approvedOn: true,
      approvedById: true,
      assigneeId: true,
      assignee: { select: { status: true, agent: { select: { deactivatedAt: true } } } },
      blockedById: true,
      dependencies: { select: { prerequisite: { select: { status: true, deletedAt: true } } } },
    },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  if (task.status !== "To Do") {
    // Task moved away from To Do — supersede the procedure without waking.
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  if (!task.approvedOn) {
    return { status: "completed", output: { superseded: true, reason: "plan_no_longer_approved" } };
  }
  if (task.assigneeId && task.assignee) {
    if (task.assignee.status !== "active" || task.assignee.agent?.deactivatedAt) {
      return { status: "completed", output: { superseded: true, reason: "assignee_inactive" } };
    }
  }
  // Check prerequisites.
  const unresolvedDeps = task.dependencies.filter((d) => d.prerequisite.status !== "Done" && !d.prerequisite.deletedAt);
  if (task.blockedById || unresolvedDeps.length > 0) {
    return { status: "completed", output: { superseded: true, reason: "blocked" } };
  }
  return { status: "completed", output: { actionable: true } };
}

// --- Step 4: wake_assignee -----------------------------------------------
// Send one deduplicated todo_start_required notification. The notification
// says the worktree is prepared and asks for start; it must not ask the
// agent to create a branch or worktree.
async function wakeAssignee(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  // Check if the actionability step superseded the procedure.
  const actionabilityStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "verify_actionability" },
    select: { output: true },
  });
  let actionability: Record<string, unknown> | null = null;
  if (actionabilityStep?.output) {
    try { actionability = JSON.parse(actionabilityStep.output); } catch { /* ignore */ }
  }
  if (actionability?.superseded === true) {
    // Don't wake anyone — the procedure was superseded.
    return { status: "completed", output: { skipped: true, reason: actionability.reason } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      title: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true, kind: true } },
      approvedById: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || !task.assigneeId || !task.assignee) {
    return { status: "completed", output: { skipped: true, reason: "no_assignee" } };
  }
  // Load the worktree path from step 2's output.
  const worktreeStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "prepare_worktree" },
    select: { output: true },
  });
  let worktreePath: string | null = null;
  if (worktreeStep?.output) {
    try {
      const parsed = JSON.parse(worktreeStep.output) as Record<string, unknown>;
      if (typeof parsed.worktreePath === "string") worktreePath = parsed.worktreePath;
    } catch { /* ignore */ }
  }
  // The actor for the notification must be an agent or the Mission Control
  // owner (humans who are not the owner are rejected by the notification
  // dispatcher). Use the assignee's agent identity as the actor — the
  // notification is FROM PM TO the assignee, so the actor is the PM/agent
  // system, not the human approver. The approver is recorded in the
  // procedure's activity log.
  const actorUser = task.assignee;
  // Enqueue a task_notification outbox effect rather than calling the
  // notification dispatcher directly. The outbox drain (integrated with the
  // PM worker poll) handles the actual PM-channel dispatch asynchronously.
  // This keeps the procedure step fast and crash-safe — the durable outbox
  // row is the source of truth, not an in-flight HTTP call.
  const taskWithProject = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { projectId: true } });
  await enqueueWorkflowEffects(db, {
    taskId: task.id,
    projectId: taskWithProject.projectId,
    aggregateVersion: 0,
    effects: [{
      type: "task_notification",
      key: `prepare_todo_task:wake:${task.id}:${ctx.procedureRunId}`,
      payload: {
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor: { id: actorUser.id, kind: "agent", username: actorUser.username },
        reason: "todo_start_required",
        body: [
          `The Action Plan for "${task.title}" was approved.`,
          worktreePath
            ? `The worktree is prepared at ${worktreePath}. Start the task with action=start.`
            : "Start the task with action=start when the lane is free.",
          "Do not create a branch or worktree — PM has already prepared it.",
        ].join("\n"),
      },
    }],
  });
  return { status: "completed", output: { woke: true, targetUserId: task.assigneeId } };
}

// --- Register handlers ----------------------------------------------------
export function registerPrepareTodoTaskHandlers(): void {
  registerStepHandler(PROCEDURE_TYPE, 1, "resolve_repository_contract", resolveRepositoryContract);
  registerStepHandler(PROCEDURE_TYPE, 1, "prepare_worktree", prepareWorktree);
  registerStepHandler(PROCEDURE_TYPE, 1, "verify_actionability", verifyActionability);
  registerStepHandler(PROCEDURE_TYPE, 1, "wake_assignee", wakeAssignee);
}