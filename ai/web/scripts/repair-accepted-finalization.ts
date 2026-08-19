import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import { db } from "@/lib/db";
import { inspectValidatedCandidateWorktree } from "@/lib/deploy/epic-merge-git";
import { recordWorkflowActionExecutionState } from "@/lib/agents/watchdog/transitions";
import { resolveActiveMonitorAgent } from "@/lib/tasks/repository-state";
import {
  applyTaskTransition,
  isTaskWorkflowStatus,
  type TaskWorkflowStatus,
} from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

function flag(name: string) {
  return process.argv.includes(name);
}

function objectPayload(payload: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringField(payload: Record<string, unknown>, key: string) {
  return typeof payload[key] === "string" ? payload[key] : null;
}

async function main() {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "workflow-reconciler-and-repair-tools",
    entryPoint: "main",
  });
  const taskId = argument("--task-id");
  const expectedCandidateSha = argument("--candidate-sha");
  const supersededTransitionId = argument("--supersede-transition-id");
  const apply = flag("--apply");
  if (!taskId || !/^[0-9a-f]{40}$/i.test(expectedCandidateSha) || !supersededTransitionId) {
    throw new Error(
      "Usage: repair:accepted-finalization --task-id <id> --candidate-sha <40-hex> --supersede-transition-id <id> [--apply]",
    );
  }

  const [task, badTransition, activity, reviewRun, laterTransitions, latestBlocker, monitor] = await Promise.all([
    db.task.findFirst({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        status: true,
        workflowVersion: true,
        projectId: true,
        epicId: true,
        alertReporter: true,
        deletedAt: true,
        repositoryRun: {
          select: {
            id: true,
            version: true,
            phase: true,
            repositoryPath: true,
            branchName: true,
            worktreePath: true,
            repoTouched: true,
            candidateSha: true,
            reviewedSha: true,
            validationOutcome: true,
          },
        },
      },
    }),
    db.workflowTransition.findFirst({ where: { id: supersededTransitionId } }),
    db.activityLog.findMany({
      where: {
        taskId,
        kind: { in: ["task.review.accepted", "pm.epic.merge.ok", "pm.repo.verify.ok"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, payload: true, createdAt: true },
    }),
    db.reviewRun.findFirst({
      where: { taskId, candidateSha: expectedCandidateSha }, orderBy: { createdAt: "desc" },
      select: {
        id: true,
        candidateSha: true,
        repoTouched: true,
        status: true,
        reviewerId: true,
        reviewedAt: true,
        validationOutcome: true,
      },
    }),
    db.workflowTransition.findMany({
      where: { taskId },
      orderBy: { workflowVersion: "asc" },
      select: {
        id: true,
        workflowVersion: true,
        intent: true,
        fromStatus: true,
        toStatus: true,
        evidence: true,
        createdAt: true,
      },
    }),
    db.activityLog.findFirst({
      where: {
        taskId,
        kind: { in: ["task.blocker", "task.extra_work.blocker", "task.blocker.cleared"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, kind: true, payload: true },
    }),
    resolveActiveMonitorAgent(),
  ]);

  if (!task || task.deletedAt) throw new Error("Task does not exist or is deleted.");
  if (!isTaskWorkflowStatus(task.status) || task.status === "Done") {
    throw new Error(`Task must be in a repairable non-Done status, found ${task.status}.`);
  }
  if (!task.repositoryRun || task.repositoryRun.repoTouched !== true) {
    throw new Error("The repair requires a code-touching repository run.");
  }
  if (task.repositoryRun.candidateSha !== expectedCandidateSha) {
    throw new Error("The current repository candidate does not match --candidate-sha.");
  }
  if (!badTransition || badTransition.taskId !== task.id || badTransition.intent !== "request_changes") {
    throw new Error("--supersede-transition-id must identify this task's Review -> To Do request_changes transition.");
  }
  if (badTransition.fromStatus !== "Review" || badTransition.toStatus !== "To Do") {
    throw new Error("The superseded transition is not a Review -> To Do edge.");
  }
  if (!reviewRun?.reviewerId || !reviewRun.reviewedAt || reviewRun.candidateSha !== expectedCandidateSha) {
    throw new Error("No durable reviewer decision exists for the expected candidate.");
  }

  const accepted = activity.find((row) => {
    if (row.kind !== "task.review.accepted") return false;
    const payload = objectPayload(row.payload);
    return stringField(payload, "candidateSha") === expectedCandidateSha
      && stringField(payload, "reviewRunId") === reviewRun.id;
  });
  const merge = activity.find((row) => {
    if (row.kind !== "pm.epic.merge.ok") return false;
    const payload = objectPayload(row.payload);
    return stringField(payload, "candidateSha") === expectedCandidateSha
      && stringField(payload, "taskId") === task.id
      && stringField(payload, "epicId") === task.epicId;
  });
  const validation = activity.find((row) => {
    if (row.kind !== "pm.repo.verify.ok") return false;
    const payload = objectPayload(row.payload);
    return stringField(payload, "candidateSha") === expectedCandidateSha
      && (payload.validationOutcome === "valid" || payload.validationOutcome === "valid_with_warning");
  });
  if (
    !accepted ||
    !merge ||
    !validation ||
    accepted.createdAt >= badTransition.createdAt ||
    merge.createdAt >= badTransition.createdAt ||
    validation.createdAt >= badTransition.createdAt
  ) {
    throw new Error("Accepted-review, successful-validation, and Epic-merge evidence must all predate the superseded transition.");
  }

  const badIndex = laterTransitions.findIndex((row) => row.id === badTransition.id);
  if (badIndex < 0) throw new Error("The superseded transition is absent from the task ledger.");
  const repairableIntents = new Set(["request_changes", "start", "repository_validation_failed"]);
  const unsafeLater = laterTransitions.slice(badIndex).find((row) => !repairableIntents.has(row.intent));
  if (unsafeLater) {
    throw new Error(`A later ${unsafeLater.intent} transition makes automatic restoration unsafe (${unsafeLater.id}).`);
  }

  if (!task.repositoryRun.worktreePath || !task.repositoryRun.branchName) {
    throw new Error("The task has no registered worktree/branch to re-check.");
  }
  const inspection = await inspectValidatedCandidateWorktree({
    worktreePath: task.repositoryRun.worktreePath,
    taskBranch: task.repositoryRun.branchName,
    candidateSha: expectedCandidateSha,
  });
  if (!inspection.ok) {
    throw new Error(`The accepted worktree candidate is no longer immutable: ${inspection.reason}`);
  }
  if (!monitor.ok) throw new Error(monitor.error);

  const validationPayload = objectPayload(validation.payload);
  const validationOutcome = validationPayload.validationOutcome === "valid_with_warning"
    ? "valid_with_warning" as const
    : "valid" as const;
  const report = {
    taskId: task.id,
    title: task.title,
    currentStatus: task.status,
    currentRepositoryPhase: task.repositoryRun.phase,
    candidateSha: expectedCandidateSha,
    acceptedActivityId: accepted.id,
    mergeActivityId: merge.id,
    reviewRunId: reviewRun.id,
    supersededTransitionId,
    worktreeInspection: inspection,
    apply,
  };

  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, ...report }, null, 2));
    return;
  }

  const actor = { ...monitor.user, kind: "agent" as const };
  const transition = await db.$transaction(async (tx) => applyTaskTransition(tx, {
    taskId: task.id,
    projectId: task.projectId,
    actorUserId: actor.id,
    intent: "operator_override",
    from: task.status as TaskWorkflowStatus,
    to: "Review",
    source: "operator-finalization-repair",
    idempotencyKey: `restore-accepted-finalization:${supersededTransitionId}:${expectedCandidateSha}`,
    expectedVersion: task.workflowVersion,
    evidence: {
      operatorRepair: true,
      candidateSha: expectedCandidateSha,
      acceptedActivityId: accepted.id,
      mergeActivityId: merge.id,
      reviewRunId: reviewRun.id,
      supersededTransitionId,
    },
    effects: [
      {
        type: "review_finalize",
        key: `repair-finalize:${expectedCandidateSha}:${supersededTransitionId}`,
        payload: {
          taskId: task.id,
          projectId: task.projectId,
          requestedByUserId: actor.id,
          requestedByUsername: actor.username,
          candidateSha: expectedCandidateSha,
        },
      },
      { type: "board_touch", key: `board-finalization-repair:${expectedCandidateSha}`, payload: {} },
    ],
    mutate: async ({ tx: inner }) => {
      const restoredRepository = await inner.taskRepositoryRun.updateMany({
        where: { id: task.repositoryRun!.id, version: task.repositoryRun!.version },
        data: {
          phase: "finalizing",
          candidateSha: expectedCandidateSha,
          reviewedSha: expectedCandidateSha,
          validationOutcome,
          lastError: null,
          version: { increment: 1 },
        },
      });
      if (restoredRepository.count !== 1) {
        throw new Error("Repository state changed concurrently during repair.");
      }
      await inner.reviewRun.update({
        where: { id: reviewRun.id },
        data: {
          status: "accepted",
          validationOutcome,
          invalidatedAt: null,
          invalidatedReason: null,
        },
      });
      await inner.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: actor.id,
          kind: "task.workflow.finalization_repair",
          payload: JSON.stringify(report),
        },
      });
      if (latestBlocker && latestBlocker.kind !== "task.blocker.cleared") {
        const blockerPayload = objectPayload(latestBlocker.payload);
        await inner.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: actor.id,
            kind: "task.blocker.cleared",
            payload: JSON.stringify({
              via: "operator-finalization-repair",
              blockerActivityId: latestBlocker.id,
              blockerCommentId: stringField(blockerPayload, "commentId"),
              candidateSha: expectedCandidateSha,
              evidence: "The accepted immutable candidate was restored to repository finalization.",
            }),
          },
        });
      }
    },
  }));

  await drainWorkflowOutbox({ limit: 10 });
  await recordWorkflowActionExecutionState({
    taskId: task.id,
    projectId: task.projectId,
    action: "review_done",
    status: "Review",
  });
  console.log(JSON.stringify({ ok: true, dryRun: false, transition: transition.transition.id, ...report }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await db.$disconnect();
});
