import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  activeCheckpointBlockerUsesAuthorization,
  activeFormalBlockerStatesByTask,
} from "@/lib/tasks/formal-blocker";

type CheckpointBlockerOutcome = "checkpoint_published" | "checkpoint_failed";

function alertValue(payload: string | null | undefined) {
  if (!payload) return null;
  try {
    const value = (JSON.parse(payload) as { to?: unknown }).to;
    if (value === true || value === 1 || value === "1" || value === "true") return true;
    if (value === false || value === 0 || value === "0" || value === "false") return false;
  } catch {
    // A malformed administrative row cannot safely clear another alert.
  }
  return null;
}

/**
 * Determine whether an alert raised independently of a formal blocker still
 * needs to survive that blocker's resolution. Newest explicit alert state
 * wins; repository failures are resolved by a later successful repository
 * outcome. This flag is visual/admin state only and never owns execution.
 */
export async function hasNewerIndependentTaskAlert(
  taskId: string,
  since: Date | string | number | null,
) {
  if (since == null) return false;
  const rows = await db.activityLog.findMany({
    where: {
      taskId,
      createdAt: { gt: new Date(since) },
      kind: {
        in: [
          "task.alert_reporter",
          "pm.repo.verify.operational_error",
          "pm.repo.verify.ok",
          "pm.repo.checkpoint.fail",
          "pm.repo.checkpoint.ok",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: { kind: true, payload: true },
  });
  for (const row of rows) {
    if (row.kind === "task.alert_reporter") {
      const explicit = alertValue(row.payload);
      if (explicit != null) return explicit;
      continue;
    }
    if (row.kind === "pm.repo.verify.ok" || row.kind === "pm.repo.checkpoint.ok") return false;
    return true;
  }
  return false;
}

/**
 * Close the exact permission round whose authorization has been consumed by a
 * checkpoint attempt. The match is deliberately three-part: active blocker,
 * publish_checkpoint kind, and authorization comment id. A newer/different
 * blocker can never be cleared by an older runner outcome.
 */
export async function settleConsumedCheckpointBlocker(args: {
  taskId: string;
  projectId: string;
  authorizationCommentId: string;
  requestedByUsername: string;
  actor: { id: string; username: string } | null;
  outcome: CheckpointBlockerOutcome;
  evidence: string;
  alertAfterFailure?: boolean;
}) {
  const lifecycleRows = await db.activityLog.findMany({
    where: {
      taskId: args.taskId,
      kind: {
        in: [
          "task.blocker",
          "task.extra_work.blocker",
          "task.blocker.cleared",
          "task.blocker.permission.granted",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: { taskId: true, kind: true, payload: true, createdAt: true },
  });
  const blocker = activeFormalBlockerStatesByTask(lifecycleRows).get(args.taskId) ?? null;
  if (!blocker || !activeCheckpointBlockerUsesAuthorization(blocker, args.authorizationCommentId)) {
    return { cleared: false as const, blockerCommentId: null, alertReporter: null };
  }

  const independentAlert = await hasNewerIndependentTaskAlert(args.taskId, blocker.raisedAt);
  const alertReporter = args.outcome === "checkpoint_failed"
    ? (args.alertAfterFailure ?? true)
    : independentAlert;
  const evidence = args.evidence.trim().slice(0, 1_500);
  try {
    await db.$transaction([
      ...(args.actor ? [db.comment.create({
        data: {
          taskId: args.taskId,
          userId: args.actor.id,
          body: [
            `**Checkpoint permission blocker closed automatically by PM (${args.outcome === "checkpoint_published" ? "published" : "attempt failed"}).**`,
            "",
            `The single-use authorization comment \`${args.authorizationCommentId}\` was consumed by this checkpoint attempt.`,
            evidence,
            "",
            args.outcome === "checkpoint_published"
              ? "This permission round is complete. Continue verification; any later code change that needs publication must raise a fresh publish_checkpoint blocker."
              : "This permission round is complete even though publication failed. Diagnose the failure, fix agent-actionable work, then raise a fresh publish_checkpoint blocker for any retry; use a general blocker only for a genuine human/external dependency.",
          ].filter(Boolean).join("\n"),
        },
      })] : []),
      db.activityLog.create({
        data: {
          // Concurrent/replayed runner outcomes for one permission round must
          // collapse to one close event and one generated comment.
          id: `checkpoint-blocker-settlement-${blocker.commentId}`,
          projectId: args.projectId,
          taskId: args.taskId,
          userId: args.actor?.id ?? null,
          kind: "task.blocker.cleared",
          targetAgent: args.requestedByUsername,
          payload: JSON.stringify({
            action: args.outcome,
            automated: true,
            blockerCommentId: blocker.commentId,
            authorizationCommentId: args.authorizationCommentId,
            independentAlert,
            alertReporter,
          }),
        },
      }),
      db.task.update({
        where: { id: args.taskId },
        data: { alertReporter },
      }),
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { cleared: false as const, blockerCommentId: blocker.commentId, alertReporter: null };
    }
    throw error;
  }

  return {
    cleared: true as const,
    blockerCommentId: blocker.commentId,
    alertReporter,
  };
}
