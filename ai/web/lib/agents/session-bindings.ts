import { db } from "@/lib/db";

export type AgentSessionScopeType = "task" | "epic" | "direct";

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
  return db.agentSessionBinding.upsert({
    where: {
      scopeType_scopeId_agentSlug: {
        scopeType: args.scopeType,
        scopeId: args.scopeId,
        agentSlug: args.agentSlug,
      },
    },
    update: {
      openclawSessionKey,
      openclawSessionId: openclawSessionKey,
    },
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
}
