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
