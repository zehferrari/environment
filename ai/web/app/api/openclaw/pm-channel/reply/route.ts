import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  parsePmChannelReplyTarget,
  resolvePmChannelToken,
  type PmChannelReplyTarget,
} from "@/lib/agents/pm-channel/openclaw";
import { authorizePmChannelCallback } from "@/lib/agents/pm-channel/callback-auth";

import {
  pmChannelRunTargetKey,
  pmChannelTargetIsCanceled,
  pmChannelTargetHasDurableReply,
  recordPmChannelRunEvent,
} from "@/lib/agents/pm-channel/runs";
import { markPmChannelJobCompleteForTarget } from "@/lib/agents/pm-channel/jobs";
import {
  enqueuePmChannelStreamDurability,
  publishPmChannelStreamEventDurably,
} from "@/lib/agents/pm-channel/stream-log";
import { publishPmChannelStreamEvent } from "@/lib/agents/pm-channel/stream";
import { checkPmChannelCallbackRateLimit } from "@/lib/agents/pm-channel/rate-limit";
import { normalizeDiscussionReplySections } from "@/lib/agents/chat/discussion-reply-format";
import {
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
} from "@/lib/agents/workflow/notifications/task";
import {
  isPmTerminalFailureText,
  isSilentPmReplyText,
  isTransientPmProgressText,
  modelFallbackActivityText,
} from "@/lib/agents/ops/pm-silence";
import { recordModelFallbackActivityForTarget } from "@/lib/agents/ops/model-fallback-activity";
import { notifyHumanOfAgentReply } from "@/lib/push/notify-reply";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import { revalidateEpicReplyScope } from "@/lib/epics/cache";
import { tryCompleteTaskFromReviewerComment } from "@/lib/tasks/review-automation";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { isAuthorizedPmChannelCallbackTarget } from "@/lib/agents/pm-channel/target-authorization";
import {
  continueActionableTaskAfterReply,
  taskWorkflowReasonForMessage,
} from "@/lib/agents/workflow/execution-continuation";
import {
  persistTaskReply,
  activeAgentUser,
} from "@/lib/agents/pm-channel/persist-task-reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configuredToken() {
  return process.env.PM_OPENCLAW_CHANNEL_TOKEN
    ?? process.env.PM_OPENCLAW_CHANNEL_CALLBACK_TOKEN
    ?? "";
}

function bearerToken(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : "";
}

function replyBody(payload: Record<string, unknown>) {
  const value = payload.text ?? payload.body;
  return typeof value === "string" ? value.trim() : "";
}

// ENV-122: Extract provider/model from the OpenClaw reply payload's agentMeta,
// then persist them to the PmChannelRun so comment creation sites can copy
// provenance from the run row instead of each needing its own model identity.
function extractRunProvenance(payload: Record<string, unknown>): { provider: string | null; model: string | null } {
  const meta = (payload.meta ?? payload.result) as Record<string, unknown> | undefined;
  const agentMeta = meta?.agentMeta as Record<string, unknown> | undefined;
  return {
    provider: typeof agentMeta?.provider === "string" ? agentMeta.provider : null,
    model: typeof agentMeta?.model === "string" ? agentMeta.model : null,
  };
}

async function persistRunProvenance(target: PmChannelReplyTarget, provenance: { provider: string | null; model: string | null }) {
  if (provenance.provider === null && provenance.model === null) return;
  try {
    await db.pmChannelRun.update({
      where: { targetKey: pmChannelRunTargetKey(target) },
      data: {
        ...(provenance.provider !== null ? { provider: provenance.provider } : {}),
        ...(provenance.model !== null ? { model: provenance.model } : {}),
      },
    });
  } catch (err) {
    console.warn("[pm-channel] failed to persist run provenance", err);
  }
}

async function persistDirectReply(target: Extract<PmChannelReplyTarget, { kind: "direct" }>, body: string) {
  const [original, agentUser] = await Promise.all([
    db.directAgentChatMessage.findUnique({
      where: { id: target.messageId },
      select: { id: true, agentSlug: true, archiveId: true, baseArchiveId: true },
    }),
    activeAgentUser(target.agentSlug),
  ]);

  if (!original || original.agentSlug !== target.agentSlug) {
    return { status: 404, body: { error: "Message not found" } };
  }
  if (!agentUser) {
    return { status: 403, body: { error: "Agent not active" } };
  }

  const reply = await db.$transaction(async (tx) => {
    const created = await tx.directAgentChatMessage.create({
      data: {
        agentSlug: target.agentSlug,
        senderUserId: agentUser.id,
        archiveId: original.archiveId,
        baseArchiveId: original.baseArchiveId,
        body,
      },
      select: { id: true, archiveId: true, createdAt: true },
    });
    if (created.archiveId) {
      await tx.directAgentChatArchive.update({
        where: { id: created.archiveId },
        data: {
          endedAt: created.createdAt,
          messageCount: { increment: 1 },
        },
      });
    }
    await tx.activityLog.create({
      data: {
        userId: agentUser.id,
        kind: "agent.direct_chat.reply",
        targetAgent: target.agentSlug,
        payload: JSON.stringify({
          driver: "openclaw-pm-channel",
          agentSlug: target.agentSlug,
          messageId: created.id,
          inReplyToMessageId: target.messageId,
        }),
      },
    });
    return created;
  });

  revalidatePath(`/agents/${target.agentSlug}/chat`);
  return { status: 200, body: { ok: true, id: reply.id, channel: "direct" }, streamText: body };
}



async function persistEpicReply(
  target: Extract<PmChannelReplyTarget, { kind: "epic-chat" }>,
  body: string,
) {
  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      id: true,
      projectId: true,
      epicId: true,
      agentSlug: true,
      archiveId: true,
      baseArchiveId: true,
      originChannel: true,
      epic: { select: { deletedAt: true } },
    },
  });
  if (!original || original.epicId !== target.epicId || original.epic?.deletedAt) {
    return { status: 404, body: { error: "Message not found" } };
  }
  if (original.agentSlug !== "room" && original.agentSlug !== target.agentSlug) {
    return { status: 403, body: { error: "Agent mismatch" } };
  }

  const agentUser = await activeAgentUser(target.agentSlug);
  if (!agentUser) {
    return { status: 403, body: { error: "Agent not active" } };
  }
  const persistedBody = normalizeDiscussionReplySections(body);

  const reply = await db.$transaction(async (tx) => {
    const created = await tx.agentChatMessage.create({
      data: {
        projectId: original.projectId,
        taskId: null,
        epicId: target.epicId,
        agentSlug: original.agentSlug,
        archiveId: original.archiveId,
        baseArchiveId: original.baseArchiveId,
        senderUserId: agentUser.id,
        body: persistedBody,
        allowDescriptionEdit: false,
        originChannel: "chat",
      },
      select: { id: true, archiveId: true, createdAt: true },
    });
    if (created.archiveId) {
      await tx.agentChatRoomArchive.update({
        where: { id: created.archiveId },
        data: {
          endedAt: created.createdAt,
          messageCount: { increment: 1 },
        },
      });
    }
    await tx.activityLog.create({
      data: {
        projectId: original.projectId,
        userId: agentUser.id,
        kind: "epic.chat.reply",
        targetAgent: target.agentSlug,
        payload: JSON.stringify({
          driver: "openclaw-pm-channel",
          messageId: created.id,
          epicId: target.epicId,
          inReplyToMessageId: target.messageId,
          agentSlug: target.agentSlug,
        }),
      },
    });
    return { id: created.id, channel: "chat" as const };
  });

  revalidateEpicReplyScope(target.epicId, "chat");
  return {
    status: 200,
    body: { ok: true, id: reply.id, channel: reply.channel },
    streamText: persistedBody,
  };
}

async function persistSilentReply(target: PmChannelReplyTarget) {
  const agentUser = await activeAgentUser(target.agentSlug);
  if (!agentUser) {
    return { status: 403, body: { error: "Agent not active" } };
  }

  if (target.kind === "direct") {
    const original = await db.directAgentChatMessage.findUnique({
      where: { id: target.messageId },
      select: { id: true, agentSlug: true },
    });
    if (!original || original.agentSlug !== target.agentSlug) {
      return { status: 404, body: { error: "Message not found" } };
    }
    revalidatePath(`/agents/${target.agentSlug}/chat`);
    return { status: 200, body: { ok: true, silent: true, channel: "direct" } };
  }

  if (target.kind === "epic-chat") {
    const original = await db.agentChatMessage.findUnique({
      where: { id: target.messageId },
      select: {
        id: true,
        projectId: true,
        epicId: true,
        agentSlug: true,
        epic: { select: { deletedAt: true } },
      },
    });
    if (!original || original.epicId !== target.epicId || original.epic?.deletedAt) {
      return { status: 404, body: { error: "Message not found" } };
    }
    if (original.agentSlug !== "room" && original.agentSlug !== target.agentSlug) {
      return { status: 403, body: { error: "Agent mismatch" } };
    }
    revalidateEpicReplyScope(target.epicId, "chat");
    return { status: 200, body: { ok: true, silent: true, channel: "epic-chat" } };
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      id: true,
      projectId: true,
      taskId: true,
      agentSlug: true,
      project: { select: { slug: true } },
      task: { select: { deletedAt: true } },
    },
  });
  if (!original || original.taskId !== target.taskId || original.task?.deletedAt) {
    return { status: 404, body: { error: "Message not found" } };
  }
  if (original.agentSlug !== "room" && original.agentSlug !== target.agentSlug) {
    return { status: 403, body: { error: "Agent mismatch" } };
  }

  revalidatePath(`/projects/${original.project.slug}/tasks/${target.taskId}`);
  return { status: 200, body: { ok: true, silent: true, channel: target.kind } };
}

export async function POST(req: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = parsePmChannelReplyTarget(payload.target);
  const body = replyBody(payload);
  if (!target || !body || body.length > 8000) {
    return NextResponse.json(
      { error: "target and non-empty text/body <= 8000 chars are required" },
      { status: 400 },
    );
  }

  const actualToken = bearerToken(req);
  const expectedShared = configuredToken();
  const expectedAgent = await resolvePmChannelToken(target.agentSlug);
  if (!authorizePmChannelCallback({
    presented: actualToken,
    expectedShared,
    expectedAgent,
  })) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await pmChannelTargetIsCanceled(target)) {
    return NextResponse.json({ ok: true, canceled: true, ignored: true });
  }

  if (!(await isAuthorizedPmChannelCallbackTarget(target))) {
    return NextResponse.json({ error: "Reply target is not authorized" }, { status: 403 });
  }

  const rateLimit = checkPmChannelCallbackRateLimit({
    kind: "reply",
    agentSlug: target.agentSlug,
    targetKey: pmChannelRunTargetKey(target),
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "PM channel reply rate limit exceeded" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  // OpenClaw emits this while it is still working. Persisting it as the
  // agent's durable reply used to complete the PM job before the subsequent
  // tool loop (or compaction recovery) had actually finished.
  if (isTransientPmProgressText(body)) {
    return NextResponse.json({ ok: true, transient: true });
  }

  // OpenClaw can deliver the same terminal auto-compaction failure through
  // both its legacy final-reply callback and the typed stream callback. The
  // reply callback used to win that race by persisting the failure notice as
  // a normal Comment/ChatMessage; the stream error then saw a "durable reply"
  // and incorrectly completed the run. Classify it before the durable-reply
  // gate, persist only an error frame, and drive the shared retry policy.
  if (isPmTerminalFailureText(body)) {
    const eventInput = { target, event: "error" as const, error: body };
    publishPmChannelStreamEvent(eventInput);
    await enqueuePmChannelStreamDurability(eventInput);
    await recordPmChannelRunEvent({ target, event: "error", error: body });
    const run = await db.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      select: { status: true },
    });
    return NextResponse.json({
      ok: true,
      terminalFailure: true,
      persisted: false,
      runStatus: run?.status ?? "failed",
    });
  }

  // Provider fallback notices are operational telemetry. They are not an
  // agent contribution and must not settle the live run: record one deduped
  // Activity and wait for the actual model reply (or normal timeout/retry).
  const fallbackMessage = modelFallbackActivityText(body);
  if (fallbackMessage) {
    const provenance = extractRunProvenance(payload);
    await persistRunProvenance(target, provenance);
    const run = await db.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      select: { id: true, provider: true, model: true },
    });
    const fallback = await recordModelFallbackActivityForTarget({
      target,
      message: fallbackMessage,
      driver: "openclaw-pm-channel",
      runId: run?.id,
      provider: run?.provider ?? provenance.provider,
      model: run?.model ?? provenance.model,
    });
    return NextResponse.json(fallback.body, { status: fallback.status });
  }

  if (await pmChannelTargetHasDurableReply(target)) {
    publishPmChannelStreamEventDurably({ target, event: "done" }, async () => {
      await recordPmChannelRunEvent({ target, event: "done" });
      await markPmChannelJobCompleteForTarget(target);
    });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // ENV-122: Extract provider/model from the OpenClaw reply payload and
  // persist them to the PmChannelRun before persisting the reply, so the
  // comment creation sites can copy provenance from the run row.
  const provenance = extractRunProvenance(payload);
  await persistRunProvenance(target, provenance);

  const actionPlanPayload = payload.actionPlan;

  const result = isSilentPmReplyText(body)
    ? await persistSilentReply(target)
    : target.kind === "direct"
    ? await persistDirectReply(target, body)
    : target.kind === "epic-chat"
    ? await persistEpicReply(target, body)
    : await persistTaskReply(target, body, actionPlanPayload);

  if (result.status >= 200 && result.status < 300) {
    const executionContinuation = target.kind === "task-chat" || target.kind === "task-comment"
      ? {
          target,
          replyId: "id" in result.body && typeof result.body.id === "string" ? result.body.id : null,
        }
      : null;
    const eventInput = {
      target,
      event: "final",
      text: (result as { streamText?: string }).streamText ?? "",
      replace: true,
    } as const;
    publishPmChannelStreamEventDurably(eventInput, async () => {
      await recordPmChannelRunEvent({ target, event: "final" });
      await markPmChannelJobCompleteForTarget(target);
      if (executionContinuation) {
        await continueActionableTaskAfterReply(executionContinuation);
      }
    });
    // Closed-app delivery: push the reply to the human's devices so it lands
    // even with no PM tab open. Best-effort and no-op without VAPID config.
    // Silent replies (no-contribution / workflow acks) persist no visible
    // message, so skip the push — otherwise every silent agent fires a content-
    // less "New reply" notification that opens a chat with nothing new in it.
    if (eventInput.text.trim().length > 0) {
      void notifyHumanOfAgentReply(target, eventInput.text);
    }
  } else {
    const error = "error" in result.body && typeof result.body.error === "string"
      ? result.body.error
      : `Reply callback failed with HTTP ${result.status}`;
    publishPmChannelStreamEventDurably({
      target,
      event: "error",
      error,
    }, async () => {
      await recordPmChannelRunEvent({
        target,
        event: "error",
        error,
      });
    });
  }

  return NextResponse.json(result.body, { status: result.status });
}
