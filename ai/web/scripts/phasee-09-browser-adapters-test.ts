import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "phasee-09-browser-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  return { dbUrl, cleanup: () => rm(sandbox, { recursive: true, force: true }) };
}

async function assertSourceContracts() {
  const moveStatus = await readFile("lib/tasks/move-status.ts", "utf8");
  assert.doesNotMatch(moveStatus, /submitWorkflowCommand|applyTaskTransition|transitionTask|\bdb\./);
  assert.doesNotMatch(moveStatus, /function moveTaskStatus/);

  for (const file of [
    "app/(app)/projects/[slug]/page.tsx",
    "app/(app)/workspaces/[slug]/page.tsx",
    "app/(app)/workspaces/(landing)/page.tsx",
  ]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /submitBrowserStatusOverride|moveTaskAction|reorderTasksAction/, `${file} exposes no board status-move transport`);
    assert.doesNotMatch(source, /moveTaskStatus|transitionTask\(|applyTaskTransition\(/, `${file} has no direct status writer`);
    assert.doesNotMatch(source, /recordLegacyWorkflowBoundaryInvocation/, `${file} is no longer a legacy boundary`);
  }

  const taskDetail = await readFile("app/(app)/projects/[slug]/tasks/[taskId]/page.tsx", "utf8");
  assert.match(taskDetail, /submitBrowserStatusOverride/);
  assert.match(taskDetail, /submitBrowserPlanApproval/);
  assert.match(taskDetail, /TaskHeaderWorkflowActions/);
  assert.doesNotMatch(taskDetail, /moveTaskStatus|applyTaskTransition\(|recordLegacyWorkflowBoundaryInvocation/);

  const statusAdapter = await readFile("lib/tasks/orchestrator/browser-status-adapter.ts", "utf8");
  assert.match(statusAdapter, /intent: "start_implementation"/, "browser start requests use the canonical start command");
  assert.match(statusAdapter, /intent: "accept_review"/, "browser completion requests use immutable review acceptance");

  const createFab = await readFile("components/create-fab.tsx", "utf8");
  for (const label of ["Just Comment", "Reset Task", "Suspend Work", "Isn't Ready Yet", "Task is Complete"]) {
    assert.match(createFab, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `comment composer exposes ${label}`);
  }
  assert.match(createFab, /ConfirmPopup/, "status-changing composer actions require confirmation");
  assert.ok(
    createFab.indexOf("Reset Task") < createFab.indexOf("Suspend Work"),
    "hard reset appears immediately before suspend",
  );
  assert.match(createFab, /textareaRef\.current\?\.focus/, "cancelled confirmation returns focus to the preserved draft");

  const board = await readFile("app/(app)/projects/[slug]/board-client.tsx", "utf8");
  assert.doesNotMatch(board, /DndContext|useSortable|useDroppable|SortableContext|DragOverlay/, "boards do not change status through drag and drop");
  assert.doesNotMatch(board, /type="checkbox"|selectedIds|TaskBulkEditControls/, "boards do not expose multi-select controls");
}

async function main() {
  await assertSourceContracts();
  const { dbUrl, cleanup } = await freshDb();
  process.env.DATABASE_URL = dbUrl;

  try {
    const { db } = await import("@/lib/db");
    const { submitBrowserStatusOverride } = await import("@/lib/tasks/orchestrator/browser-status-adapter");
    const { submitBrowserPlanApproval } = await import("@/lib/tasks/orchestrator/browser-plan-adapter");
    const {
      getBrowserTaskWorkflowActions,
      submitBrowserAcceptReview,
      submitBrowserCancelTask,
    } = await import("@/lib/tasks/orchestrator/browser-review-adapter");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");

    const human = await db.user.create({
      data: { username: "owner", email: "owner@example.test", kind: "human", isOwner: true },
    });
    const agentProfile = await db.agent.create({
      data: { slug: "browser-agent", name: "Browser Agent", role: "coding" },
    });
    const agent = await db.user.create({
      data: { username: "agent", email: "agent@example.test", kind: "agent", agentId: agentProfile.id },
    });
    const project = await db.project.create({
      data: { slug: "phasee-09-browser", name: "Phase E browser adapters" },
    });
    const actor = {
      id: human.id,
      username: human.username,
      kind: "human" as const,
      role: "owner" as const,
      agentVisibility: "full" as const,
      canAccessOwnerFeatures: true,
    };

    const overrideTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Browser override",
        status: "To Do",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });
    const firstOverride = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "To Do",
      targetStatus: "In Progress",
      expectedWorkflowVersion: 0,
      activeWorkflowCycleId: null,
      surface: "project-board",
    });
    assert.equal(firstOverride.ok, true);
    const afterOverride = await db.task.findUniqueOrThrow({ where: { id: overrideTask.id } });
    assert.equal(afterOverride.status, "In Progress");
    assert.equal(afterOverride.workflowVersion, 1);
    assert.equal(await db.activityLog.count({ where: { taskId: overrideTask.id, kind: "task.blocker" } }), 0);
    assert.equal(await db.comment.count({ where: { taskId: overrideTask.id, commentKind: "blocker_notice" } }), 0);

    const replay = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "To Do",
      targetStatus: "In Progress",
      expectedWorkflowVersion: 0,
      activeWorkflowCycleId: null,
      surface: "project-board",
    });
    assert.equal(replay.ok, true, "same browser evidence replays exactly");
    assert.equal(await db.activityLog.count({ where: { taskId: overrideTask.id, kind: "task.blocker" } }), 0);

    const stale = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "To Do",
      targetStatus: "Review",
      expectedWorkflowVersion: 0,
      activeWorkflowCycleId: null,
      surface: "task-detail",
    });
    assert.deepEqual(stale, {
      ok: false,
      code: "STALE_VERSION",
      message: "The task changed while this status update was pending. Refresh the board and try again.",
    });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: overrideTask.id } })).status, "In Progress");

    const done = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "In Progress",
      targetStatus: "Done",
      expectedWorkflowVersion: 1,
      activeWorkflowCycleId: null,
      surface: "workspace-landing",
    });
    assert.equal(done.ok, true);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: overrideTask.id } })).status, "Done");
    assert.equal(
      await db.activityLog.count({ where: { taskId: overrideTask.id, kind: "task.blocker" } }),
      0,
      "human status updates never create wait-for-human blockers",
    );

    const repositoryProject = await db.project.create({
      data: {
        slug: "phasee-09-browser-repository",
        name: "Phase E browser repository workflow",
        repositoryPath: "/srv/Code/test-repository",
      },
    });
    const repositoryStartTask = await db.task.create({
      data: {
        projectId: repositoryProject.id,
        title: "Protected browser start",
        status: "To Do",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
        approvedOn: new Date(),
        approvedById: human.id,
      },
    });
    const repositoryPlan = await db.actionPlan.create({
      data: {
        taskId: repositoryStartTask.id,
        summary: "Start through the protected browser edge",
        version: 1,
        status: "approved",
        authorId: agent.id,
        contentHash: "phasee-09-protected-start",
        approvedOn: new Date(),
        approvedById: human.id,
      },
    });
    await db.actionPlanStep.create({
      data: {
        actionPlanId: repositoryPlan.id,
        stepId: "protected-start",
        title: "Revalidate the worktree before dispatch",
        acceptanceCriteria: JSON.stringify(["The canonical start procedure is scheduled"]),
        kind: "sequential",
        rank: 0,
      },
    });

    const protectedStart = await submitBrowserStatusOverride({
      actor,
      taskId: repositoryStartTask.id,
      currentStatus: "To Do",
      targetStatus: "In Progress",
      expectedWorkflowVersion: 0,
      activeWorkflowCycleId: null,
      surface: "task-detail",
    });
    assert.equal(protectedStart.ok, true, "repository-backed browser start uses the canonical command");
    const afterProtectedStart = await db.task.findUniqueOrThrow({ where: { id: repositoryStartTask.id } });
    assert.equal(afterProtectedStart.status, "In Progress");
    assert.ok(afterProtectedStart.activeWorkflowCycleId, "canonical browser start opens an implementation cycle");
    assert.equal(
      await db.taskProcedureRun.count({
        where: { taskId: repositoryStartTask.id, type: "start_implementation_cycle" },
      }),
      1,
      "canonical browser start schedules worktree revalidation before dispatch",
    );

    const bypassDone = await submitBrowserStatusOverride({
      actor,
      taskId: repositoryStartTask.id,
      currentStatus: "In Progress",
      targetStatus: "Done",
      expectedWorkflowVersion: afterProtectedStart.workflowVersion,
      activeWorkflowCycleId: afterProtectedStart.activeWorkflowCycleId,
      surface: "task-detail",
    });
    assert.equal(bypassDone.ok, false, "repository work cannot bypass Review and finalization");
    assert.match(bypassDone.ok ? "" : bypassDone.message, /only be completed from Review/);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: repositoryStartTask.id } })).status,
      "In Progress",
    );

    const planTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Browser plan approval",
        status: "Backlog",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });
    const plan = await db.actionPlan.create({
      data: {
        taskId: planTask.id,
        summary: "Approve through browser command",
        version: 1,
        status: "draft",
        authorId: agent.id,
        contentHash: "phasee-09-browser-plan",
      },
    });
    await db.actionPlanStep.create({
      data: {
        actionPlanId: plan.id,
        stepId: "browser-step",
        title: "Use canonical command",
        acceptanceCriteria: JSON.stringify(["Approval is atomic"]),
        kind: "sequential",
        rank: 0,
      },
    });
    const approval = await submitBrowserPlanApproval({
      actor,
      taskId: planTask.id,
      actionPlanId: plan.id,
      actionPlanVersion: 1,
      expectedWorkflowVersion: 0,
    });
    assert.equal(approval.ok, true);
    assert.ok(approval.ok && approval.procedureId, "approval schedules prepare_todo_task");
    const approvedTask = await db.task.findUniqueOrThrow({ where: { id: planTask.id } });
    assert.equal(approvedTask.status, "To Do");
    assert.ok(approvedTask.approvedOn);
    assert.equal(approvedTask.approvedById, human.id);
    assert.equal((await db.actionPlan.findUniqueOrThrow({ where: { id: plan.id } })).status, "approved");
    assert.equal(await db.subTask.count({ where: { taskId: planTask.id, kind: "implementation" } }), 1);
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: planTask.id, type: "prepare_todo_task" } }), 1);

    const queuedPlanTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Queued browser plan approval",
        status: "To Do",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });
    const queuedPlan = await db.actionPlan.create({
      data: {
        taskId: queuedPlanTask.id,
        summary: "Approve without a status edge",
        version: 1,
        status: "draft",
        authorId: agent.id,
        contentHash: "phasee-09-browser-queued-plan",
      },
    });
    await db.actionPlanStep.create({
      data: {
        actionPlanId: queuedPlan.id,
        stepId: "queued-browser-step",
        title: "Use the canonical approval no-op",
        acceptanceCriteria: JSON.stringify(["To Do approval stays in To Do"]),
        kind: "sequential",
        rank: 0,
      },
    });
    const queuedApproval = await submitBrowserPlanApproval({
      actor,
      taskId: queuedPlanTask.id,
      actionPlanId: queuedPlan.id,
      actionPlanVersion: 1,
      expectedWorkflowVersion: 0,
    });
    assert.equal(queuedApproval.ok, true);
    const approvedQueuedTask = await db.task.findUniqueOrThrow({ where: { id: queuedPlanTask.id } });
    assert.equal(approvedQueuedTask.status, "To Do");
    assert.equal(approvedQueuedTask.workflowVersion, 0);
    assert.ok(approvedQueuedTask.approvedOn);
    assert.equal(
      await db.activityLog.count({
        where: {
          taskId: queuedPlanTask.id,
          kind: "task.workflow.approve_plan",
        },
      }),
      1,
      "queued plan approval is an audited canonical no-op",
    );
    assert.equal(
      await db.taskProcedureRun.count({ where: { taskId: queuedPlanTask.id, type: "prepare_todo_task" } }),
      1,
    );

    const approvalReplay = await submitBrowserPlanApproval({
      actor,
      taskId: planTask.id,
      actionPlanId: plan.id,
      actionPlanVersion: 1,
      expectedWorkflowVersion: 0,
    });
    assert.equal(approvalReplay.ok, true);
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: planTask.id, type: "prepare_todo_task" } }), 1);

    const repositoryReviewTask = await db.task.create({
      data: {
        projectId: repositoryProject.id,
        title: "Protected browser completion",
        status: "Review",
        workflowVersion: 1,
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
        approvedOn: new Date(),
        approvedById: human.id,
      },
    });
    await db.$transaction(async (tx) => {
      await openTaskWorkflowCycle(tx, { taskId: repositoryReviewTask.id, openedWorkflowVersion: 1 });
      const cycle = await tx.taskWorkflowCycle.findFirstOrThrow({
        where: { taskId: repositoryReviewTask.id, status: "open" },
      });
      await tx.reviewRun.create({
        data: {
          taskId: repositoryReviewTask.id,
          workflowCycleId: cycle.id,
          candidateSha: "protected-review-candidate",
          baseSha: "protected-review-base",
          repoTouched: true,
          validationOutcome: "valid",
          status: "awaiting_review",
        },
      });
      await tx.taskRepositoryRun.create({
        data: {
          taskId: repositoryReviewTask.id,
          workflowCycleId: cycle.id,
          repositoryPath: "/srv/Code/test-repository",
          branchName: "protected-review",
          worktreePath: "/srv/Code/test-repository.worktrees/protected-review",
          baseSha: "protected-review-base",
          candidateSha: "protected-review-candidate",
          phase: "review_ready",
          validationOutcome: "valid",
          repoTouched: true,
        },
      });
    });
    const repositoryReviewState = await db.task.findUniqueOrThrow({
      where: { id: repositoryReviewTask.id },
    });
    const protectedCompletion = await submitBrowserStatusOverride({
      actor,
      taskId: repositoryReviewTask.id,
      currentStatus: "Review",
      targetStatus: "Done",
      expectedWorkflowVersion: repositoryReviewState.workflowVersion,
      activeWorkflowCycleId: repositoryReviewState.activeWorkflowCycleId,
      surface: "task-detail",
    });
    assert.equal(protectedCompletion.ok, true, "repository completion routes through accept_review");
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: repositoryReviewTask.id } })).status,
      "Review",
      "accepted repository work stays in Review until finalization and cleanup finish",
    );
    assert.equal(
      await db.taskProcedureRun.count({
        where: { taskId: repositoryReviewTask.id, type: "finalize_accepted_review", status: "queued" },
      }),
      1,
      "browser completion schedules the canonical finalizer",
    );

    const reviewTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Browser reviewer actions",
        status: "Review",
        workflowVersion: 1,
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
        approvedOn: new Date(),
        approvedById: human.id,
      },
    });
    await db.$transaction(async (tx) => {
      await openTaskWorkflowCycle(tx, { taskId: reviewTask.id, openedWorkflowVersion: 1 });
      const cycle = await tx.taskWorkflowCycle.findFirstOrThrow({
        where: { taskId: reviewTask.id, status: "open" },
      });
      await tx.reviewRun.create({
        data: {
          taskId: reviewTask.id,
          workflowCycleId: cycle.id,
          candidateSha: "review-candidate",
          baseSha: "review-base",
          repoTouched: true,
          validationOutcome: "valid",
          status: "awaiting_review",
        },
      });
      await tx.taskRepositoryRun.create({
        data: {
          taskId: reviewTask.id,
          workflowCycleId: cycle.id,
          repositoryPath: "/srv/Code/test-repo",
          branchName: "review-actions",
          worktreePath: "/srv/Code/test-repo.worktrees/review-actions",
          baseSha: "review-base",
          candidateSha: "review-candidate",
          phase: "review_ready",
          validationOutcome: "valid",
          repoTouched: true,
        },
      });
    });

    const available = await getBrowserTaskWorkflowActions({ actor, taskId: reviewTask.id });
    assert.equal(available.canCancel, true, "authorized reviewer can suspend work");
    assert.equal(available.canRequestChanges, true, "authorized reviewer can request another implementation pass");
    assert.equal(available.canAccept, true, "authorized reviewer can accept the immutable candidate");
    assert.equal(available.reviewStatus, "awaiting_review", "the browser receives the live review lease state");
    assert.ok(available.reviewRunId && available.candidateSha && available.workflowCycleId);

    const accepted = await submitBrowserAcceptReview({
      actor,
      taskId: reviewTask.id,
      expectedWorkflowVersion: available.workflowVersion,
      workflowCycleId: available.workflowCycleId!,
      reviewRunId: available.reviewRunId!,
      candidateSha: available.candidateSha!,
      reviewerComment: "The reviewed candidate is complete.",
    });
    assert.equal(accepted.ok, true);
    const afterAccept = await db.task.findUniqueOrThrow({ where: { id: reviewTask.id } });
    assert.equal(afterAccept.status, "Review", "acceptance waits for repository finalization before Done");
    assert.equal(
      await db.taskProcedureRun.count({
        where: { taskId: reviewTask.id, type: "finalize_accepted_review", status: "queued" },
      }),
      1,
      "acceptance schedules one finalization procedure",
    );
    assert.equal(
      await db.comment.count({ where: { taskId: reviewTask.id, body: "The reviewed candidate is complete." } }),
      1,
      "the reviewer note commits with acceptance",
    );

    const acceptedActions = await getBrowserTaskWorkflowActions({ actor, taskId: reviewTask.id });
    assert.equal(acceptedActions.canAccept, false, "an accepted lease cannot be accepted twice");
    assert.equal(acceptedActions.reviewStatus, "accepted", "the task page can keep refreshing during finalization");
    assert.equal(acceptedActions.canRequestChanges, true, "the reviewer may still revoke stuck finalization");
    assert.equal(acceptedActions.canCancel, true, "the reviewer may suspend stuck finalization");

    const suspended = await submitBrowserCancelTask({
      actor,
      taskId: reviewTask.id,
      expectedWorkflowVersion: acceptedActions.workflowVersion,
      workflowCycleId: acceptedActions.workflowCycleId,
      reason: "Suspend this work while requirements are reconsidered.",
    });
    assert.equal(suspended.ok, true);
    const afterSuspend = await db.task.findUniqueOrThrow({ where: { id: reviewTask.id } });
    assert.equal(afterSuspend.status, "Backlog");
    assert.equal(afterSuspend.assigneeId, agent.id, "suspension preserves the assignee");
    const suspendedCycle = await db.taskWorkflowCycle.findUniqueOrThrow({
      where: { id: available.workflowCycleId! },
    });
    assert.equal(suspendedCycle.status, "closed");
    assert.equal(suspendedCycle.outcome, "cancelled");
    assert.equal(
      (await db.taskProcedureRun.findFirstOrThrow({
        where: { taskId: reviewTask.id, type: "finalize_accepted_review" },
      })).status,
      "superseded",
      "suspension retires the old finalizer",
    );
    const suspendedRepo = await db.taskRepositoryRun.findUniqueOrThrow({ where: { taskId: reviewTask.id } });
    assert.equal(suspendedRepo.phase, "action_required");
    assert.equal(suspendedRepo.worktreePath, "/srv/Code/test-repo.worktrees/review-actions");
    assert.equal(
      await db.comment.count({
        where: { taskId: reviewTask.id, body: "Suspend this work while requirements are reconsidered." },
      }),
      1,
      "the suspension reason commits as an audit comment",
    );

    console.log("phasee-09 browser adapters: PASS");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
