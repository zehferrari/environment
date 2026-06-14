// Map a PmEvent to the agent slug + gateway port we should wake.
//
// The PM envelope carries User.id values for actor / assignee /
// mentioned. The consumer resolves those to an Agent slug via the
// User → Agent 1:1 relation, then asks the host index.json for the
// authoritative gateway_port. Returning null is a normal outcome —
// many events (human-assignee, no-mention comments) have no agent
// wake target.

import { db } from "@/lib/db";
import {
  readAgentIndex,
  gatewayPortFor,
  type AgentIndex,
} from "@/lib/agents/management/index-loader";
import type { PmEvent } from "@/lib/pm-events";

export interface ResolvedTarget {
  slug: string;
  gatewayPort: number;
  reason: "assignee" | "mentioned" | "task-assignee" | "chat-target";
}

export interface TargetResolverOptions {
  // Inject for tests; defaults to the live host index file.
  loadIndex?: () => Promise<AgentIndex>;
}

export function createTargetResolver(opts: TargetResolverOptions = {}) {
  const loadIndex = opts.loadIndex ?? (() => readAgentIndex());
  let cached: { at: number; index: AgentIndex } | null = null;
  const TTL_MS = 5_000;

  async function indexNow(): Promise<AgentIndex> {
    const now = Date.now();
    if (cached && now - cached.at < TTL_MS) return cached.index;
    const index = await loadIndex();
    cached = { at: now, index };
    return index;
  }

  async function lookupAgentByUserId(
    userId: string,
  ): Promise<{ slug: string } | null> {
    const user = await db.user.findUnique({
      where: { id: userId },
      include: { agent: true },
    });
    if (!user || user.kind !== "agent" || !user.agent) return null;
    return { slug: user.agent.slug };
  }

  async function gatewayPortBySlug(slug: string): Promise<number | null> {
    const index = await indexNow();
    const agent = index.agents.find((a) => a.user === slug);
    if (!agent) return null;
    return gatewayPortFor(agent) ?? null;
  }

  async function resolveByUserId(
    userId: string,
    reason: ResolvedTarget["reason"],
  ): Promise<ResolvedTarget | null> {
    const a = await lookupAgentByUserId(userId);
    if (!a) return null;
    const port = await gatewayPortBySlug(a.slug);
    if (!port) return null;
    return { slug: a.slug, gatewayPort: port, reason };
  }

  async function resolve(event: PmEvent): Promise<ResolvedTarget | null> {
    switch (event.kind) {
      case "task.assigned": {
        const id = event.payload.assignee?.id;
        if (!id || event.payload.assignee?.kind !== "agent") return null;
        return resolveByUserId(id, "assignee");
      }
      case "task.mentioned": {
        const id = event.payload.mentioned.id;
        if (event.payload.mentioned.kind !== "agent") return null;
        return resolveByUserId(id, "mentioned");
      }
      case "task.ack_ready": {
        const task = await db.task.findUnique({
          where: { id: event.task.id },
          select: { assigneeId: true },
        });
        if (!task?.assigneeId) return null;
        return resolveByUserId(task.assigneeId, "task-assignee");
      }
      case "task.commented":
        // Per-mention task.mentioned events handle the wake fanout;
        // the commented envelope itself is a no-op for wake routing.
        return null;
      case "deployment.approved":
        return null;
      case "task.agent_chat": {
        // HOMELAB-48 — chat wakes the addressed agent regardless of
        // task assignee. The slug is authoritative; we re-resolve the
        // gateway port via the host index so deactivated agents fall
        // back to null and the consumer marks the delivery "unmatched".
        const slug = event.payload.targetAgentSlug;
        if (!slug) return null;
        const port = await gatewayPortBySlug(slug);
        if (!port) return null;
        return { slug, gatewayPort: port, reason: "chat-target" };
      }
    }
  }

  return { resolve };
}

export type TargetResolver = ReturnType<typeof createTargetResolver>;
