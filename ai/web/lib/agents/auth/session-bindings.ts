import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";

export type AgentSessionScopeType = "task" | "epic" | "direct" | "billing";

export type AgentSessionBinding = {
  id: string;
  scopeType: string;
  scopeId: string;
  agentSlug: string;
  openclawSessionKey: string;
  openclawSessionId: string | null;
  lastDispatchedMessageId: string | null;
  lastDispatchedAt: Date | null;
};

function cleanSegment(value: string) {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return cleaned || "unknown";
}

export function buildPmOpenClawSessionKey(args: {
  scopeType: AgentSessionScopeType;
  scopeId: string;
  agentSlug: string;
}) {
  return [
    "pm",
    cleanSegment(args.scopeType),
    cleanSegment(args.scopeId),
    "agent",
    cleanSegment(args.agentSlug),
  ].join(":");
}

// Roll back the incremental-context baseline after a turn's dispatch fails
// permanently. The binding is advanced optimistically at enqueue time (async
// dispatch returns 202 before the gateway is contacted), so a job that later
// exhausts its retries would otherwise leave `lastDispatchedMessageId` pointing
// at a turn the agent never received — and the next turn would be built as an
// incremental "changes since <messageId>" against context the agent never saw.
// Resetting to null forces the next turn to rebuild a full (non-incremental)
// prompt, which is always correct. The update is conditional on the binding
// still pointing at the failed message: a newer turn may have already advanced
// the baseline, in which case that newer turn owns it and we leave it alone.
export async function rollbackDispatchedMessageId(args: {
  scopeType: AgentSessionScopeType;
  scopeId: string;
  agentSlug: string;
  messageId: string;
}): Promise<void> {
  await db.agentSessionBinding.updateMany({
    where: {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      agentSlug: args.agentSlug,
      lastDispatchedMessageId: args.messageId,
    },
    data: {
      lastDispatchedMessageId: null,
      lastDispatchedAt: null,
    },
  });
}

export async function getOrCreateAgentSessionBinding(args: {
  scopeType: AgentSessionScopeType;
  scopeId: string;
  agentSlug: string;
}): Promise<AgentSessionBinding> {
  const openclawSessionKey = buildPmOpenClawSessionKey(args);
  const binding = await db.agentSessionBinding.upsert({
    where: {
      scopeType_scopeId_agentSlug: {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        agentSlug: args.agentSlug,
      },
    },
    // A binding may deliberately carry a recovery suffix after an
    // unrecoverable context-compaction turn. Never rewrite it back to the
    // canonical key here or the next notification would reopen the poisoned
    // OpenClaw session.
    update: {},
    create: {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      agentSlug: args.agentSlug,
      openclawSessionKey,
      openclawSessionId: openclawSessionKey,
    },
    select: {
      id: true,
      scopeType: true,
      scopeId: true,
      agentSlug: true,
      openclawSessionKey: true,
      openclawSessionId: true,
      lastDispatchedMessageId: true,
      lastDispatchedAt: true,
    },
  });
  if (args.scopeType !== "task") return binding;

  // Provider-neutral preventive rotation. Session limits and error strings
  // vary across OpenAI, Anthropic, Ollama, and future backends, but completed
  // task turns are observable at the PM boundary. Rotate before the session
  // becomes the task's only memory; every PM turn already carries a bounded,
  // self-sufficient context packet.
  const configured = Number.parseInt(process.env.PM_TASK_SESSION_MAX_COMPLETED_TURNS ?? "8", 10);
  const maxCompletedTurns = Number.isFinite(configured) && configured > 0 ? configured : 8;
  const completedTurns = await db.pmChannelRun.count({
    where: {
      agentSlug: args.agentSlug,
      taskId: args.scopeId,
      sessionKey: binding.openclawSessionKey,
      status: "completed",
    },
  });
  if (completedTurns < maxCompletedTurns) return binding;
  return await rotateAgentSessionBinding({
    agentSlug: args.agentSlug,
    currentSessionKey: binding.openclawSessionKey,
    recoveryId: `budget-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    reason: "completed_turn_budget",
  }) ?? binding;
}

/**
 * Move the PM scope to a fresh OpenClaw session after the current session has
 * proven unable to compact. The per-turn PM prompt is self-contained, so the
 * next retry can safely start cold. Conditional update makes concurrent
 * terminal callbacks idempotent: only the callback that still owns the old
 * key rotates it.
 */
export async function rotateAgentSessionBinding(args: {
  agentSlug: string;
  currentSessionKey: string;
  recoveryId?: string;
  reason?: "context_failure" | "completed_turn_budget" | "operator_recovery";
}): Promise<AgentSessionBinding | null> {
  const candidates = await db.agentSessionBinding.findMany({
    where: { agentSlug: args.agentSlug },
    select: {
      id: true,
      scopeType: true,
      scopeId: true,
      agentSlug: true,
      openclawSessionKey: true,
      openclawSessionId: true,
      lastDispatchedMessageId: true,
      lastDispatchedAt: true,
    },
  });
  const current = candidates.find((binding) => (
    args.currentSessionKey === binding.openclawSessionKey ||
    args.currentSessionKey.startsWith(`${binding.openclawSessionKey}:turn:`)
  )) ?? candidates.find((binding) => {
    const canonical = buildPmOpenClawSessionKey({
      scopeType: binding.scopeType as AgentSessionScopeType,
      scopeId: binding.scopeId,
      agentSlug: binding.agentSlug,
    });
    return (
      args.currentSessionKey === canonical ||
      args.currentSessionKey.startsWith(`${canonical}:turn:`) ||
      args.currentSessionKey.startsWith(`${canonical}:recovery:`)
    );
  });
  if (!current) return null;

  const canonical = buildPmOpenClawSessionKey({
    scopeType: current.scopeType as AgentSessionScopeType,
    scopeId: current.scopeId,
    agentSlug: current.agentSlug,
  });
  const recoveryId = cleanSegment(args.recoveryId ?? randomUUID()).slice(0, 48);
  const nextKey = `${canonical}:recovery:${recoveryId}`;
  const updated = await db.agentSessionBinding.updateMany({
    where: { id: current.id, openclawSessionKey: current.openclawSessionKey },
    data: {
      openclawSessionKey: nextKey,
      openclawSessionId: nextKey,
      lastDispatchedMessageId: null,
      lastDispatchedAt: null,
    },
  });
  if (updated.count !== 1) {
    return db.agentSessionBinding.findUnique({
      where: {
        scopeType_scopeId_agentSlug: {
          scopeType: current.scopeType,
          scopeId: current.scopeId,
          agentSlug: current.agentSlug,
        },
      },
      select: {
        id: true,
        scopeType: true,
        scopeId: true,
        agentSlug: true,
        openclawSessionKey: true,
        openclawSessionId: true,
        lastDispatchedMessageId: true,
        lastDispatchedAt: true,
      },
    });
  }
  await db.activityLog.create({
    data: {
      taskId: current.scopeType === "task" ? current.scopeId : null,
      userId: null,
      kind: "pm.session.rotated",
      targetAgent: current.agentSlug,
      payload: JSON.stringify({
        scopeType: current.scopeType,
        scopeId: current.scopeId,
        fromSessionKey: current.openclawSessionKey,
        toSessionKey: nextKey,
        reason: args.reason ?? "context_failure",
      }),
    },
  }).catch(() => {});
  return { ...current, openclawSessionKey: nextKey, openclawSessionId: nextKey, lastDispatchedMessageId: null, lastDispatchedAt: null };
}
