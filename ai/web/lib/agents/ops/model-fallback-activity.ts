import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { PmChannelReplyTarget } from "@/lib/agents/pm-channel/openclaw";

type ModelFallbackScope = {
  agentUserId: string;
  agentSlug: string;
  projectId?: string | null;
  taskId?: string | null;
  epicId?: string | null;
  messageId: string;
  message: string;
  driver: string;
  runId?: string | null;
  provider?: string | null;
  model?: string | null;
};

function fallbackFingerprint(scope: ModelFallbackScope) {
  return createHash("sha256").update([
    scope.projectId ?? "",
    scope.taskId ?? "",
    scope.epicId ?? "",
    scope.agentSlug,
    scope.message,
  ].join("\0")).digest("hex");
}

/**
 * Record one durable operational event per exact fallback/scope/agent tuple.
 * Repeated transport callbacks and repeated PM nudges do not create new rows.
 */
export async function recordModelFallbackActivity(scope: ModelFallbackScope) {
  const fingerprint = fallbackFingerprint(scope);
  return db.$transaction(async (tx) => {
    const existing = await tx.activityLog.findFirst({
      where: {
        kind: "agent.model_fallback",
        targetAgent: scope.agentSlug,
        payload: { contains: `"fingerprint":"${fingerprint}"` },
      },
      select: { id: true },
    });
    if (existing) return { created: false as const, id: existing.id, fingerprint };
    const created = await tx.activityLog.create({
      data: {
        projectId: scope.projectId ?? null,
        taskId: scope.taskId ?? null,
        userId: scope.agentUserId,
        kind: "agent.model_fallback",
        targetAgent: scope.agentSlug,
        payload: JSON.stringify({
          fingerprint,
          message: scope.message,
          epicId: scope.epicId ?? null,
          inReplyToMessageId: scope.messageId,
          driver: scope.driver,
          runId: scope.runId ?? null,
          provider: scope.provider ?? null,
          model: scope.model ?? null,
        }),
      },
      select: { id: true },
    });
    return { created: true as const, id: created.id, fingerprint };
  });
}

export async function recordModelFallbackActivityForTarget(args: {
  target: PmChannelReplyTarget;
  message: string;
  driver: string;
  runId?: string | null;
  provider?: string | null;
  model?: string | null;
}) {
  const agent = await db.agent.findUnique({
    where: { slug: args.target.agentSlug },
    select: {
      deactivatedAt: true,
      user: { select: { id: true, status: true } },
    },
  });
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return { status: 403 as const, body: { error: "Agent not active" } };
  }

  if (args.target.kind === "direct") {
    const original = await db.directAgentChatMessage.findUnique({
      where: { id: args.target.messageId },
      select: { id: true, agentSlug: true },
    });
    if (!original || original.agentSlug !== args.target.agentSlug) {
      return { status: 404 as const, body: { error: "Message not found" } };
    }
    const activity = await recordModelFallbackActivity({
      agentUserId: agent.user.id,
      agentSlug: args.target.agentSlug,
      messageId: args.target.messageId,
      message: args.message,
      driver: args.driver,
      runId: args.runId,
      provider: args.provider,
      model: args.model,
    });
    return { status: 200 as const, body: { ok: true, modelFallback: true, ...activity } };
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: args.target.messageId },
    select: {
      id: true,
      projectId: true,
      taskId: true,
      epicId: true,
      agentSlug: true,
      task: { select: { deletedAt: true } },
      epic: { select: { deletedAt: true } },
    },
  });
  const expectedId = args.target.kind === "epic-chat" ? original?.epicId : original?.taskId;
  const targetId = args.target.kind === "epic-chat" ? args.target.epicId : args.target.taskId;
  if (
    !original
    || expectedId !== targetId
    || original.task?.deletedAt
    || original.epic?.deletedAt
    || (original.agentSlug !== "room" && original.agentSlug !== args.target.agentSlug)
  ) {
    return { status: 404 as const, body: { error: "Message not found" } };
  }
  const activity = await recordModelFallbackActivity({
    agentUserId: agent.user.id,
    agentSlug: args.target.agentSlug,
    projectId: original.projectId,
    taskId: args.target.kind === "epic-chat" ? null : args.target.taskId,
    epicId: args.target.kind === "epic-chat" ? args.target.epicId : null,
    messageId: args.target.messageId,
    message: args.message,
    driver: args.driver,
    runId: args.runId,
    provider: args.provider,
    model: args.model,
  });
  return { status: 200 as const, body: { ok: true, modelFallback: true, ...activity } };
}
