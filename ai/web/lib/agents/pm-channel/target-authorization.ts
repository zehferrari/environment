import { db } from "@/lib/db";
import type {
  PmChannelReplyTarget,
  SendPmChannelTurnArgs,
} from "@/lib/agents/pm-channel/openclaw";
import { parsePmChannelReplyTarget } from "@/lib/agents/pm-channel/openclaw";
import { pmChannelRunTargetKey } from "@/lib/agents/pm-channel/runs";
import {
  hasActiveOwnerOrigin,
  hasAuthorizedTaskAgentOrigin,
} from "@/lib/agents/owner-origin";

function taskIsEffectivelyPublic(task: {
  deletedAt: Date | null;
  private: boolean;
  epic: { private: boolean } | null;
  parent: { private: boolean; epic: { private: boolean } | null } | null;
} | null | undefined) {
  return Boolean(
    task &&
    !task.deletedAt &&
    !task.private &&
    !task.epic?.private &&
    !task.parent?.private &&
    !task.parent?.epic?.private,
  );
}

function sameTarget(left: PmChannelReplyTarget, right: PmChannelReplyTarget) {
  if (pmChannelRunTargetKey(left) !== pmChannelRunTargetKey(right)) return false;
  const leftProjectSlug = left.kind === "direct" ? null : left.projectSlug ?? null;
  const rightProjectSlug = right.kind === "direct" ? null : right.projectSlug ?? null;
  return leftProjectSlug === rightProjectSlug;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The async worker persists the complete dispatch payload before it publishes
 * to the bus. Compare a bus envelope against that record so the bus is not a
 * way to alter an owner-authorized message or prompt in transit.
 */
function jobPayloadMatchesDispatch(payload: string, args: SendPmChannelTurnArgs) {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const target = parsePmChannelReplyTarget(parsed.replyTarget);
    const actor = parsed.actor && typeof parsed.actor === "object"
      ? parsed.actor as Record<string, unknown>
      : null;
    return Boolean(
      target
      && sameTarget(target, args.replyTarget)
      && parsed.agentSlug === args.agentSlug
      && parsed.sessionKey === args.sessionKey
      && parsed.kind === args.kind
      && parsed.text === args.text
      && numberOrNull(parsed.gatewayPort) === args.gatewayPort
      && stringOrNull(parsed.contextText) === (args.contextText ?? null)
      && stringOrNull(parsed.systemPrompt) === (args.systemPrompt ?? null)
      && stringOrNull(parsed.projectId) === (args.projectId ?? null)
      && numberOrNull(parsed.timeoutMs) === (args.timeoutMs ?? null)
      && actor?.id === args.actor.id
      && actor.kind === args.actor.kind,
    );
  } catch {
    return false;
  }
}

function runMatchesDispatch(
  run: {
    kind: string;
    agentSlug: string;
    messageId: string;
    taskId: string | null;
    epicId: string | null;
    projectId: string | null;
    sessionKey: string | null;
    gatewayPort: number | null;
  },
  args: SendPmChannelTurnArgs,
) {
  const target = args.replyTarget;
  const taskId = target.kind === "task-chat" || target.kind === "task-comment"
    ? target.taskId
    : null;
  const epicId = target.kind === "epic-chat" ? target.epicId : null;
  return run.kind === args.kind
    && run.agentSlug === args.agentSlug
    && run.messageId === target.messageId
    && run.taskId === taskId
    && run.epicId === epicId
    && run.projectId === (args.projectId ?? null)
    && run.sessionKey === args.sessionKey
    && run.gatewayPort === args.gatewayPort;
}

function senderMatchesDispatch(
  sender: { id: string; kind: string } | null | undefined,
  args: SendPmChannelTurnArgs,
) {
  return Boolean(
    sender
    && sender.id === args.actor.id
    && sender.kind === args.actor.kind,
  );
}

/**
 * Bus ingress authorization differs from callback authorization. The consumer
 * receives an envelope during dispatch, while the durable run is normally
 * still `queued` and its job is `claimed`. Accept only that persisted handoff
 * (or the legacy synchronous no-job path), then validate the original sender
 * and current work visibility before forwarding the turn to OpenClaw.
 */
export async function isAuthorizedPmChannelDispatchTarget(
  args: SendPmChannelTurnArgs,
): Promise<boolean> {
  const targetKey = pmChannelRunTargetKey(args.replyTarget);
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey },
    select: {
      kind: true,
      agentSlug: true,
      messageId: true,
      taskId: true,
      epicId: true,
      projectId: true,
      sessionKey: true,
      gatewayPort: true,
      status: true,
      jobs: {
        select: { status: true, payload: true },
        take: 1,
      },
    },
  });
  if (
    !run
    || run.status === "cancelled"
    || run.status === "failed"
    || run.status === "completed"
    || !runMatchesDispatch(run, args)
  ) {
    return false;
  }

  const job = run.jobs[0];
  // Async dispatches must be claimed by the worker (or already accepted when
  // a file-drop consumer observes the envelope slightly later). This prevents
  // a queued owner message from being injected directly into the bus.
  if (job && (
    !["claimed", "accepted"].includes(job.status)
    || !jobPayloadMatchesDispatch(job.payload, args)
  )) {
    return false;
  }

  if (args.replyTarget.kind === "direct") {
    const original = await db.directAgentChatMessage.findUnique({
      where: { id: args.replyTarget.messageId },
      select: {
        agentSlug: true,
        projectId: true,
        senderUserId: true,
        deletedAt: true,
        sender: { select: { id: true, kind: true } },
      },
    });
    return Boolean(
      original
      && !original.deletedAt
      && original.agentSlug === args.replyTarget.agentSlug
      && original.projectId === (args.projectId ?? null)
      && original.senderUserId === args.actor.id
      && senderMatchesDispatch(original.sender, args)
      && await hasActiveOwnerOrigin(original.senderUserId),
    );
  }

  if (args.replyTarget.kind === "epic-chat") {
    const original = await db.agentChatMessage.findUnique({
      where: { id: args.replyTarget.messageId },
      select: {
        agentSlug: true,
        projectId: true,
        epicId: true,
        senderUserId: true,
        deletedAt: true,
        sender: { select: { id: true, kind: true } },
        epic: { select: { deletedAt: true, private: true } },
      },
    });
    return Boolean(
      original
      && !original.deletedAt
      && original.projectId === (args.projectId ?? null)
      && original.epicId === args.replyTarget.epicId
      && original.epic
      && !original.epic.deletedAt
      && !original.epic.private
      && (original.agentSlug === "room" || original.agentSlug === args.replyTarget.agentSlug)
      && original.senderUserId === args.actor.id
      && senderMatchesDispatch(original.sender, args)
      && await hasActiveOwnerOrigin(original.senderUserId),
    );
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: args.replyTarget.messageId },
    select: {
      agentSlug: true,
      projectId: true,
      taskId: true,
      senderUserId: true,
      deletedAt: true,
      sender: { select: { id: true, kind: true, status: true } },
      task: {
        select: {
          deletedAt: true,
          private: true,
          epic: { select: { private: true } },
          parent: { select: { private: true, epic: { select: { private: true } } } },
        },
      },
    },
  });
  if (
    !original
    || original.deletedAt
    || original.projectId !== (args.projectId ?? null)
    || original.taskId !== args.replyTarget.taskId
    || !taskIsEffectivelyPublic(original.task)
    || (original.agentSlug !== "room" && original.agentSlug !== args.replyTarget.agentSlug)
    || original.senderUserId !== args.actor.id
    || !senderMatchesDispatch(original.sender, args)
  ) {
    return false;
  }
  return hasAuthorizedTaskAgentOrigin({
    taskId: args.replyTarget.taskId,
    messageId: args.replyTarget.messageId,
    targetAgentSlug: args.replyTarget.agentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  });
}

/**
 * External PM callbacks are accepted only for a turn with a durable, already
 * dispatched run. This also rechecks the current owner/private policy because
 * a turn may have been queued before a membership or privacy change.
 */
export async function isAuthorizedPmChannelCallbackTarget(
  target: PmChannelReplyTarget,
): Promise<boolean> {
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: { status: true },
  });
  // A gateway can report a retryable/failed delivery after the agent already
  // received the turn. Preserve that late-final recovery path, but never
  // accept a callback for a queued or explicitly canceled target.
  if (!run || run.status === "queued" || run.status === "cancelled") return false;

  if (target.kind === "direct") {
    const original = await db.directAgentChatMessage.findUnique({
      where: { id: target.messageId },
      select: { agentSlug: true, senderUserId: true, deletedAt: true },
    });
    return Boolean(
      original &&
      !original.deletedAt &&
      original.agentSlug === target.agentSlug &&
      await hasActiveOwnerOrigin(original.senderUserId),
    );
  }

  if (target.kind === "epic-chat") {
    const original = await db.agentChatMessage.findUnique({
      where: { id: target.messageId },
      select: {
        agentSlug: true,
        epicId: true,
        senderUserId: true,
        deletedAt: true,
        epic: { select: { deletedAt: true, private: true } },
      },
    });
    return Boolean(
      original &&
      !original.deletedAt &&
      original.epicId === target.epicId &&
      original.epic &&
      !original.epic.deletedAt &&
      !original.epic.private &&
      (original.agentSlug === "room" || original.agentSlug === target.agentSlug) &&
      await hasActiveOwnerOrigin(original.senderUserId),
    );
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      agentSlug: true,
      taskId: true,
      senderUserId: true,
      sender: { select: { kind: true, status: true } },
      deletedAt: true,
      task: {
        select: {
          deletedAt: true,
          private: true,
          epic: { select: { private: true } },
          parent: { select: { private: true, epic: { select: { private: true } } } },
        },
      },
    },
  });
  if (
    !original ||
    original.deletedAt ||
    original.taskId !== target.taskId ||
    !taskIsEffectivelyPublic(original.task) ||
    (original.agentSlug !== "room" && original.agentSlug !== target.agentSlug)
  ) {
    return false;
  }
  return hasAuthorizedTaskAgentOrigin({
    taskId: target.taskId,
    messageId: target.messageId,
    targetAgentSlug: target.agentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  });
}
