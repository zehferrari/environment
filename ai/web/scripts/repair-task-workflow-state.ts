import { db } from "@/lib/db";
import { settleConsumedCheckpointBlocker } from "@/lib/tasks/checkpoint-blocker";
import { resolveActiveMonitorAgent } from "@/lib/tasks/repository-state";
import { rotateAgentSessionBinding } from "@/lib/agents/auth/session-bindings";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

function flag(name: string) {
  return process.argv.includes(name);
}

function checkpointPayload(payload: string | null) {
  try {
    const parsed = JSON.parse(payload ?? "{}") as Record<string, unknown>;
    return {
      authorizationCommentId: typeof parsed.authorizationCommentId === "string" ? parsed.authorizationCommentId : null,
      epicSha: typeof parsed.epicSha === "string" ? parsed.epicSha : null,
    };
  } catch {
    return { authorizationCommentId: null, epicSha: null };
  }
}

async function main() {
  const taskId = argument("--task-id");
  const apply = flag("--apply");
  if (!taskId) throw new Error("Usage: repair-task-workflow-state --task-id <id> [--apply] [--rotate-session] [--resume]");
  if (apply && flag("--resume") && !process.env.AUTH_SECRET?.trim()) {
    throw new Error("AUTH_SECRET is required with --resume; run this repair with the live pm.service environment before any state is changed");
  }

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      assigneeId: true,
      assignee: { select: { username: true, agent: { select: { slug: true } } } },
    },
  });
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const monitor = await resolveActiveMonitorAgent();
  const actor = monitor.ok
    ? { id: monitor.user.id, username: monitor.user.username, kind: "agent" as const }
    : null;
  const checkpointRows = await db.activityLog.findMany({
    where: { taskId, kind: "pm.repo.checkpoint.ok" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  let blockerCleared = false;
  for (const row of apply ? checkpointRows : []) {
    const checkpoint = checkpointPayload(row.payload);
    if (!checkpoint.authorizationCommentId) continue;
    const settlement = await settleConsumedCheckpointBlocker({
      taskId,
      projectId: task.projectId,
      authorizationCommentId: checkpoint.authorizationCommentId,
      requestedByUsername: task.assignee?.username ?? "unknown",
      actor: actor ? { id: actor.id, username: actor.username } : null,
      outcome: "checkpoint_published",
      evidence: checkpoint.epicSha
        ? `Historical checkpoint publication recorded Epic SHA \`${checkpoint.epicSha}\`.`
        : "Historical checkpoint publication was already recorded by PM.",
    });
    if (settlement.cleared) {
      blockerCleared = true;
      break;
    }
  }

  let rotatedSessionKey: string | null = null;
  if (apply && flag("--rotate-session") && task.assignee?.agent?.slug) {
    const binding = await db.agentSessionBinding.findUnique({
      where: {
        scopeType_scopeId_agentSlug: {
          scopeType: "task",
          scopeId: task.id,
          agentSlug: task.assignee.agent.slug,
        },
      },
      select: { openclawSessionKey: true },
    });
    if (binding) {
      const rotated = await rotateAgentSessionBinding({
        agentSlug: task.assignee.agent.slug,
        currentSessionKey: binding.openclawSessionKey,
        recoveryId: `operator-${Date.now().toString(36)}`,
        reason: "operator_recovery",
      });
      rotatedSessionKey = rotated?.openclawSessionKey ?? null;
    }
  }

  let resumeMessageId: string | null = null;
  if (
    apply && flag("--resume") &&
    task.status === "In Progress" &&
    task.assigneeId &&
    task.assignee?.agent?.slug &&
    actor
  ) {
    const latestAuthorization = checkpointRows.map((row) => checkpointPayload(row.payload).authorizationCommentId).find(Boolean);
    const recoveryKey = `workflow-repair:${task.id}:${latestAuthorization ?? "none"}`;
    const alreadyResumed = await db.activityLog.findFirst({
      where: {
        taskId: task.id,
        kind: "task.workflow.repair.resume",
        payload: { contains: JSON.stringify(recoveryKey).slice(1, -1) },
      },
      select: { id: true },
    });
    if (!alreadyResumed) {
      const notification = await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "monitor_recovery",
        body: [
          `PM repaired stale workflow state for "${task.title}".`,
          blockerCleared
            ? "The already-consumed checkpoint permission round is now closed."
            : "The formal blocker state was already settled or did not match a consumed checkpoint.",
          "Re-read the current task context and newest comments now. Continue implementation/live verification. If the current code fix needs another checkpoint, raise a fresh permission-only blocker with permissionKind=publish_checkpoint so the reporter receives a new single-use grant action. Do not reuse an earlier authorization.",
          "Work through to ready_for_review or one precise blocker that genuinely needs external input; do not stop at a progress-only comment.",
        ].join("\n"),
      });
      resumeMessageId = notification?.messageId ?? null;
      await db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: actor.id,
          kind: "task.workflow.repair.resume",
          targetAgent: task.assignee.agent.slug,
          payload: JSON.stringify({ recoveryKey, resumeMessageId, blockerCleared, rotatedSessionKey }),
        },
      });
    }
  }

  console.log(JSON.stringify({
    taskId,
    dryRun: !apply,
    requested: {
      settleConsumedCheckpoint: checkpointRows.some((row) => Boolean(checkpointPayload(row.payload).authorizationCommentId)),
      rotateSession: flag("--rotate-session"),
      resume: flag("--resume"),
    },
    blockerCleared,
    rotatedSessionKey,
    resumeMessageId,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await db.$disconnect();
});
