import { db } from "@/lib/db";
import { inspectValidatedCandidateWorktree } from "@/lib/deploy/epic-merge-git";
import { resolveActiveMonitorAgent } from "@/lib/tasks/repository-state";
import { isTaskWorkflowStatus } from "@/lib/tasks/transition-kernel";

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

  if (apply) {
    throw new Error(
      "--apply is retired: this tool is read-only. Submit the authenticated operator finalization-repair command with the exact evidence printed below.",
    );
  }
  console.log(JSON.stringify({ ok: true, dryRun: true, validationOutcome, latestBlockerId: latestBlocker?.id ?? null, ...report }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await db.$disconnect();
});
