import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyTaskWorkflowToken } from "@/lib/agents/workflow/token/task";
import { hasAuthorizedTaskAgentOrigin } from "@/lib/agents/owner-origin";
import { resolveAgentTaskAccess } from "@/lib/agents/private-task-access";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { storeAttachment } from "@/lib/attachments/service";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { revalidateTaskAttachments } from "@/lib/tasks/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/**
 * Upload a deliverable from an authenticated PM task execution turn.
 * The existing message/token grant scopes the write to one task and agent;
 * no browser cookie or cross-user filesystem access is involved.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await ctx.params;
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return error("Expected multipart/form-data", 400);
  }
  const messageId = String(formData.get("messageId") ?? "");
  const token = String(formData.get("token") ?? "");
  const file = formData.get("file");
  if (!messageId || !token || !(file instanceof File) || file.size === 0) {
    return error("messageId, token, and one non-empty file are required", 400);
  }
  if (file.size > attachmentMaxBytes()) return error("Attachment exceeds the configured size cap", 413);

  const original = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    select: {
      taskId: true,
      agentSlug: true,
      targetType: true,
      targetValue: true,
      senderUserId: true,
      sender: { select: { kind: true, status: true } },
    },
  });
  if (!original || original.taskId !== taskId) return error("Task grant message not found", 404);
  const grantAgentSlug = original.agentSlug === "room"
    && original.targetType === "agent"
    && original.targetValue?.startsWith("agent:")
    ? original.targetValue.slice("agent:".length)
    : original.agentSlug;
  if (!verifyTaskWorkflowToken(messageId, taskId, grantAgentSlug, token)) {
    return error("Invalid task grant token", 403);
  }
  if (!(await hasAuthorizedTaskAgentOrigin({
    taskId,
    messageId,
    targetAgentSlug: grantAgentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  }))) {
    return error("Task grant is no longer authorized", 403);
  }

  const [agent, task] = await Promise.all([
    db.agent.findUnique({
      where: { slug: grantAgentSlug },
      select: { deactivatedAt: true, user: { select: { id: true, status: true } } },
    }),
    db.task.findFirst({
      where: { id: taskId, archivedAt: null, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        status: true,
        assigneeId: true,
        actingManagerId: true,
        reporterId: true,
        epic: { select: { status: true, actingManagerId: true } },
      },
    }),
  ]);
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return error("Agent is not active", 403);
  }
  const access = await resolveAgentTaskAccess({ taskId, agentUserId: agent.user.id });
  if (!task || !access.allowed) return error("Task not found", 404);
  const reviewOwnerId = resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic,
  });
  const canUpload = (task.status === "In Progress" && task.assigneeId === agent.user.id)
    || (task.status === "Review" && reviewOwnerId === agent.user.id);
  if (!canUpload) {
    return error("Only the active assignee in In Progress or reviewer in Review may upload", 403);
  }

  try {
    const row = await storeAttachment({
      projectId: task.projectId,
      taskId: task.id,
      epicId: null,
      uploaderId: agent.user.id,
      filename: file.name,
      declaredMimeType: file.type,
      data: Buffer.from(await file.arrayBuffer()),
    });
    revalidateTaskAttachments(task.id);
    return NextResponse.json({
      ok: true,
      attachment: {
        ...row,
        createdAt: row.createdAt.toISOString(),
        downloadUrl: `/api/attachments/${row.id}`,
      },
    }, { status: 201 });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "Attachment upload failed", 500);
  }
}
