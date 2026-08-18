import { db } from "@/lib/db";
import {
  PM_SILENT_REPLY_TOKEN,
  isPmTerminalFailureText,
  modelFallbackActivityText,
} from "@/lib/agents/ops/pm-silence";
import { recordModelFallbackActivity } from "@/lib/agents/ops/model-fallback-activity";

const apply = process.argv.includes("--apply");

async function main() {
  const comments = await db.comment.findMany({
    where: {
      OR: [
        { body: { contains: "Model Fallback:" } },
        { body: { contains: PM_SILENT_REPLY_TOKEN } },
        { body: { contains: "Model login expired on the gateway for " } },
        { body: { contains: "Agent couldn't generate a response." } },
        { body: { contains: "Exec failed: " } },
      ],
    },
    select: {
      id: true,
      taskId: true,
      epicId: true,
      userId: true,
      body: true,
      authorAgentSlug: true,
      runId: true,
      provider: true,
      model: true,
      task: { select: { projectId: true } },
      epic: { select: { projectId: true } },
      user: {
        select: {
          username: true,
          agent: { select: { slug: true } },
        },
      },
    },
  });
  const fallbackComments = comments.flatMap((comment) => {
    const message = modelFallbackActivityText(comment.body);
    return message ? [{ comment, message }] : [];
  });
  const silentComments = comments.filter((comment) =>
    comment.body.includes(PM_SILENT_REPLY_TOKEN),
  );
  const terminalFailureComments = comments.filter((comment) =>
    isPmTerminalFailureText(comment.body),
  );
  const removableIds = new Set([
    ...fallbackComments.map(({ comment }) => comment.id),
    ...silentComments.map((comment) => comment.id),
    ...terminalFailureComments.map((comment) => comment.id),
  ]);

  const summary = {
    apply,
    fallbackComments: fallbackComments.length,
    silentComments: silentComments.length,
    terminalFailureComments: terminalFailureComments.length,
    commentsToDelete: removableIds.size,
    fallbackActivitiesCreated: 0,
    fallbackActivitiesDeduplicated: 0,
    linkedActivitiesDeleted: 0,
  };
  if (!apply || removableIds.size === 0) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  for (const { comment, message } of fallbackComments) {
    const activity = await recordModelFallbackActivity({
      agentUserId: comment.userId,
      agentSlug: comment.authorAgentSlug ?? comment.user.agent?.slug ?? comment.user.username,
      projectId: comment.task?.projectId ?? comment.epic?.projectId ?? null,
      taskId: comment.taskId,
      epicId: comment.epicId,
      messageId: comment.id,
      message,
      driver: "comment-spam-repair",
      runId: comment.runId,
      provider: comment.provider,
      model: comment.model,
    });
    if (activity.created) summary.fallbackActivitiesCreated += 1;
    else summary.fallbackActivitiesDeduplicated += 1;
  }

  // Remove the obsolete “comment added” Activity rows as well; otherwise the
  // Activity feed would retain hundreds of dead links after the hard delete.
  const linked = await db.activityLog.findMany({
    where: { kind: { in: ["task.comment", "epic.comment"] } },
    select: { id: true, payload: true },
  });
  const linkedActivityIds = linked.flatMap((activity) => {
    try {
      const payload = JSON.parse(activity.payload ?? "{}") as { commentId?: unknown };
      return typeof payload.commentId === "string" && removableIds.has(payload.commentId)
        ? [activity.id]
        : [];
    } catch {
      return [];
    }
  });

  await db.$transaction(async (tx) => {
    if (linkedActivityIds.length > 0) {
      const deleted = await tx.activityLog.deleteMany({
        where: { id: { in: linkedActivityIds } },
      });
      summary.linkedActivitiesDeleted = deleted.count;
    }
    await tx.comment.deleteMany({ where: { id: { in: [...removableIds] } } });
  });

  const remainingCandidates = await db.comment.findMany({
    where: {
      OR: [
        { body: { contains: "Model Fallback:" } },
        { body: { contains: PM_SILENT_REPLY_TOKEN } },
        { body: { contains: "Model login expired on the gateway for " } },
        { body: { contains: "Agent couldn't generate a response." } },
        { body: { contains: "Exec failed: " } },
      ],
    },
    select: { body: true },
  });
  const remaining = remainingCandidates.filter((comment) =>
    modelFallbackActivityText(comment.body)
    || comment.body.includes(PM_SILENT_REPLY_TOKEN)
    || isPmTerminalFailureText(comment.body),
  ).length;
  if (remaining !== 0) throw new Error(`Repair left ${remaining} system comments behind.`);
  console.log(JSON.stringify({ ...summary, remaining }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
