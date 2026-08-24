import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyTaskWorkflowToken } from "@/lib/agents/workflow/token/task";
import { hasAuthorizedTaskAgentOrigin } from "@/lib/agents/owner-origin";
import { resolveAgentTaskAccess } from "@/lib/agents/private-task-access";
import { resolveEpisodeRolloverBarrier } from "@/lib/agents/episodes/lifecycle";
import {
  decorateAuthoritativeAgentResponseCache,
  isAgentWorkflowPublicAction,
  submitAuthoritativeAgentWorkflowAction,
} from "@/lib/tasks/orchestrator/agent-route-adapter";
import { ENGINE_ORCHESTRATOR_V2, resolveEngineOwnership } from "@/lib/tasks/orchestrator/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await ctx.params;
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const action = payload.action;
  const comment = typeof payload.comment === "string" ? payload.comment.trim() : "";
  if (!messageId || !token || !isAgentWorkflowPublicAction(action)) {
    return NextResponse.json(
      { error: "messageId, token, and valid action are required" },
      { status: 400 },
    );
  }
  if (comment.length > 8000) {
    return NextResponse.json({ error: "comment must be <= 8000 chars" }, { status: 400 });
  }

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
  if (!original || original.taskId !== taskId) {
    return NextResponse.json({ error: "Workflow grant message not found" }, { status: 404 });
  }
  const grantAgentSlug = original.agentSlug === "room" &&
    original.targetType === "agent" && original.targetValue?.startsWith("agent:")
    ? original.targetValue.slice("agent:".length)
    : original.agentSlug;
  if (!verifyTaskWorkflowToken(messageId, taskId, grantAgentSlug, token)) {
    return NextResponse.json({ error: "Invalid workflow token" }, { status: 403 });
  }
  if (!(await hasAuthorizedTaskAgentOrigin({
    taskId,
    messageId,
    targetAgentSlug: grantAgentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  }))) {
    return NextResponse.json({ error: "Workflow grant is no longer authorized" }, { status: 403 });
  }

  const [agent, task, ownership, rolloverBarrier] = await Promise.all([
    db.agent.findUnique({
      where: { slug: grantAgentSlug },
      select: {
        slug: true,
        role: true,
        deactivatedAt: true,
        user: { select: { id: true, username: true, status: true } },
      },
    }),
    db.task.findFirst({
      where: { id: taskId, archivedAt: null, deletedAt: null },
      select: { id: true, project: { select: { slug: true } } },
    }),
    resolveEngineOwnership(db, taskId),
    resolveEpisodeRolloverBarrier({ taskId, agentSlug: grantAgentSlug, messageId }),
  ]);
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  const taskAccess = await resolveAgentTaskAccess({ taskId, agentUserId: agent.user.id });
  if (!task || !taskAccess.allowed) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (!ownership.ok) {
    return NextResponse.json(
      { error: ownership.reason, code: ownership.code },
      { status: ownership.code === "task_not_found" ? 404 : 409 },
    );
  }
  if (ownership.engine !== ENGINE_ORCHESTRATOR_V2) {
    return NextResponse.json(
      { error: "Legacy workflow mutation ownership is retired.", code: "legacy_retired" },
      { status: 409 },
    );
  }

  const matchingRun = await db.pmChannelRun.findFirst({
    where: { taskId, agentSlug: grantAgentSlug, messageId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, settledByAction: true, lastAction: true },
  });
  const exactReplay = matchingRun?.status === "completed" &&
    (matchingRun.settledByAction === action || matchingRun.lastAction === action);
  if (rolloverBarrier && (rolloverBarrier.state === "consumed" || action !== "checkpoint")) {
    return NextResponse.json(
      {
        error: rolloverBarrier.state === "consumed"
          ? "This execution episode is closed and its final checkpoint was already consumed."
          : "This execution episode is exhausted; submit its final checkpoint before further workflow actions.",
        episodeBudgetExhausted: true,
        episodeClosed: true,
        episodeNo: rolloverBarrier.episode.episodeNo,
      },
      { status: 409 },
    );
  }
  if (matchingRun &&
    !["queued", "delivered", "accepted", "streaming"].includes(matchingRun.status) &&
    !exactReplay && !rolloverBarrier) {
    return NextResponse.json(
      { error: `Workflow grant belongs to a ${matchingRun.status} run and is fenced from further actions` },
      { status: 409 },
    );
  }

  let result;
  try {
    result = await submitAuthoritativeAgentWorkflowAction({
      taskId,
      action,
      rawBody: payload,
      messageId,
      pmChannelRunId: matchingRun?.id ?? null,
      agent: {
        id: agent.user.id,
        username: agent.user.username,
        slug: agent.slug,
        registryRole: agent.role,
      },
    });
  } catch (error) {
    result = {
      status: 503,
      body: {
        error: error instanceof Error ? error.message : String(error),
        code: "operational_error",
        orchestratorStatus: "operational",
      },
    };
  }
  if (result.body.ok === true) {
    decorateAuthoritativeAgentResponseCache({ taskId, projectSlug: task.project.slug });
  }
  return NextResponse.json(result.body, { status: result.status });
}
