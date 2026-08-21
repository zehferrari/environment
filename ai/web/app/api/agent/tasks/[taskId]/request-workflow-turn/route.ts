// Self-service workflow-turn re-arm (2026-07 workflow overhaul).
//
// Workflow tokens are delivered ONLY inside a workflow turn's system prompt.
// An assignee whose token-bearing turn ended without acting (subagent
// completions, failed streams, direct-chat prompts) used to have NO path to
// transition their own task — observed as multi-hour stalls on finished work
// (PH-122, PH-124). This endpoint lets the task's CURRENT assignee request a
// fresh workflow turn, authenticated with the same per-agent PM-channel
// bearer used by /api/openclaw/pm-channel/reply.

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolvePmChannelToken } from "@/lib/agents/pm-channel/openclaw";
import { authorizePmChannelCallback } from "@/lib/agents/pm-channel/callback-auth";
import {
  sendTaskWorkflowNotification,
  type TaskWorkflowNotificationReason,
} from "@/lib/agents/workflow/notifications/task";
import { resolveAgentTaskAccess } from "@/lib/agents/private-task-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

function configuredSharedToken() {
  return process.env.PM_OPENCLAW_CHANNEL_TOKEN
    ?? process.env.PM_OPENCLAW_CHANNEL_CALLBACK_TOKEN
    ?? "";
}

function bearerToken(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : "";
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await ctx.params;
  let payload: { agentSlug?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const agentSlug = typeof payload.agentSlug === "string" ? payload.agentSlug.trim() : "";
  if (!agentSlug) {
    return NextResponse.json({ error: "agentSlug is required" }, { status: 400 });
  }

  const presented = bearerToken(req);
  const expectedAgent = await resolvePmChannelToken(agentSlug);
  if (!authorizePmChannelCallback({
    presented,
    expectedShared: configuredSharedToken(),
    expectedAgent,
  })) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [agent, task] = await Promise.all([
    db.agent.findUnique({
      where: { slug: agentSlug },
      select: {
        slug: true,
        deactivatedAt: true,
        user: { select: { id: true, username: true, status: true } },
      },
    }),
    db.task.findFirst({
      where: {
        id: taskId,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        status: true,
        projectId: true,
        assigneeId: true,
        approvedOn: true,
      },
    }),
  ]);

  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  const taskAccess = await resolveAgentTaskAccess({ taskId, agentUserId: agent.user.id });
  if (!task || !taskAccess.allowed) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (task.assigneeId !== agent.user.id) {
    return NextResponse.json({ error: "Only the task's current assignee can request a workflow turn" }, { status: 403 });
  }
  if (task.status !== "To Do" && task.status !== "In Progress" && task.status !== "Review") {
    return NextResponse.json({
      error: `Workflow turns can only be requested while the task is in To Do, In Progress, or Review (current: ${task.status})`,
      currentStatus: task.status,
    }, { status: 409 });
  }

  // This endpoint is a recovery seam for an agent whose token-bearing turn
  // has ENDED. Calling it from inside a live turn used to supersede that very
  // process, start a replacement on the same OpenClaw session, and leave the
  // original model mutating its worktree behind PM's callback fence. Treat a
  // currently leased run as success-with-no-op so an uncertain agent cannot
  // create a competing execution lane.
  const now = new Date();
  const activeRun = await db.pmChannelRun.findFirst({
    where: {
      taskId: task.id,
      agentSlug,
      status: { in: ["queued", "delivered", "accepted", "streaming"] },
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { gt: now } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, messageId: true, leaseExpiresAt: true },
  });
  if (activeRun) {
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: task.status,
      dispatched: false,
      alreadyActive: true,
      activeRun: {
        id: activeRun.id,
        status: activeRun.status,
        messageId: activeRun.messageId,
        leaseExpiresAt: activeRun.leaseExpiresAt,
      },
    });
  }

  // Rate limit: 1 request per task per 5 minutes, durable via ActivityLog.
  const lastRequest = await db.activityLog.findFirst({
    where: { taskId: task.id, kind: "task.workflow.turn_requested" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (lastRequest) {
    const elapsedMs = Date.now() - lastRequest.createdAt.getTime();
    if (elapsedMs < RATE_LIMIT_WINDOW_MS) {
      const retryAfterSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsedMs) / 1000);
      return NextResponse.json(
        { error: "A workflow turn was already requested for this task in the last 5 minutes" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }
  }

  const actor = { id: agent.user.id, kind: "agent" as const, username: agent.user.username };
  let reason: TaskWorkflowNotificationReason;
  let body: string;
  if (task.status === "To Do") {
    reason = "todo_start_required";
    body = [
      `You requested a fresh workflow turn for "${task.title}" (status: To Do).`,
      task.approvedOn
        ? "The Action Plan is approved: call the workflow endpoint with action=start, move the task to In Progress, and begin work."
        : "The Action Plan is not approved yet: call action=submit_plan with one structured technical Action Plan and wait for approval. A plain chat reply is discussion only; do not start work.",
    ].join("\n");
  } else if (task.status === "In Progress") {
    reason = "ready_for_review_available";
    body = [
      `You requested a fresh workflow turn for "${task.title}" (status: In Progress).`,
      "Verify every implementation sub-task is ticked (action=complete_subtask for each finished item), confirm the work is committed per the commit-hygiene rules, then call action=ready_for_review.",
      "If work is still in flight, continue it and keep the sub-task checklist current instead.",
    ].join("\n");
  } else {
    // Review: re-send the current-state turn. The assignee cannot start or
    // resume from Review — the reviewer's review_feedback / review_done owns
    // the next transition.
    reason = "monitor_recovery";
    body = [
      `You requested a fresh workflow turn for "${task.title}" (status: Review).`,
      "The task is waiting on its reviewer. You cannot start or resume it from Review — if the reviewer leaves review_feedback, the task returns to the front of To Do and you start it from there.",
      "Use this turn only to add genuinely new information (a blocker, a correction, completion evidence) as a concise comment. Otherwise reply with the silent token.",
    ].join("\n");
  }

  const sent = await sendTaskWorkflowNotification({
    taskId: task.id,
    targetUserId: agent.user.id,
    actor,
    reason,
    body,
  });

  await db.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      userId: agent.user.id,
      kind: "task.workflow.turn_requested",
      targetAgent: agent.slug,
      payload: JSON.stringify({
        agentSlug: agent.slug,
        status: task.status,
        reason,
        messageId: sent?.messageId ?? null,
        dispatched: Boolean(sent),
      }),
    },
  });

  return NextResponse.json({
    ok: true,
    taskId: task.id,
    status: task.status,
    reason,
    messageId: sent?.messageId ?? null,
  });
}
