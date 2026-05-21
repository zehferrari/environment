import { db } from "@/lib/db";
import { readAgentIndex, gatewayPortFor, type IndexAgent } from "@/lib/agents/index-loader";
import { ensureAgentCredential, type SeededAgentCredential } from "@/lib/agents/credentials";
import { hashPassword } from "@/lib/auth/password";

export type SyncResult = {
  codeOwner: string;
  hostMatchedAgents: number;
  syncedAgents: number;
  deactivatedAgents: number;
  seededUsers: number;
  rotatedUsers: number;
  errors: string[];
};

/**
 * Refresh the Agent table from /srv/agents/index.json, and ensure each
 * co-located agent (codeOwner-matches-this-host) has a matching User row
 * seeded with a host-private credential.
 *
 * Idempotent — safe to call on boot and every interval.
 */
export async function syncAgents(): Promise<SyncResult> {
  const index = await readAgentIndex();
  const codeOwner = index.codeOwner;
  const result: SyncResult = {
    codeOwner,
    hostMatchedAgents: 0,
    syncedAgents: 0,
    deactivatedAgents: 0,
    seededUsers: 0,
    rotatedUsers: 0,
    errors: [],
  };

  const seen = new Set<string>();

  for (const agent of index.agents) {
    if (!agent.user || !agent.name) continue;
    seen.add(agent.user);

    // Stage 1 scope: only seed users for agents on this host.
    // index.codeOwner is the host owner; agents on this host inherit it.
    const isColocated = agent.enabled !== false;

    try {
      await upsertAgentRow(agent, codeOwner);
      result.syncedAgents += 1;

      if (isColocated) {
        result.hostMatchedAgents += 1;
        const { seeded } = await ensureAgentUser(agent);
        if (seeded) result.seededUsers += 1;
      }
    } catch (err) {
      result.errors.push(`${agent.user}: ${(err as Error).message}`);
    }
  }

  // Deactivate agents that disappeared from index.json (do not delete).
  const dropped = await db.agent.findMany({
    where: { slug: { notIn: Array.from(seen) }, deactivatedAt: null },
  });
  for (const a of dropped) {
    await db.agent.update({
      where: { id: a.id },
      data: { deactivatedAt: new Date() },
    });
    if (a) {
      await db.user.updateMany({
        where: { agentId: a.id, status: "active" },
        data: { status: "deactivated" },
      });
      result.deactivatedAgents += 1;
    }
  }

  await db.activityLog.create({
    data: {
      kind: "agent.sync",
      payload: JSON.stringify(result),
    },
  });

  return result;
}

async function upsertAgentRow(agent: IndexAgent, codeOwner: string) {
  const port = gatewayPortFor(agent);
  await db.agent.upsert({
    where: { slug: agent.user },
    update: {
      name: agent.name,
      email: agent.email ?? null,
      role: agent.role,
      codeOwner,
      gatewayPort: port ?? null,
      avatar: agent.avatar ?? null,
      rawJson: JSON.stringify(agent),
      deactivatedAt: null,
    },
    create: {
      slug: agent.user,
      name: agent.name,
      email: agent.email ?? null,
      role: agent.role,
      codeOwner,
      gatewayPort: port ?? null,
      avatar: agent.avatar ?? null,
      rawJson: JSON.stringify(agent),
    },
  });
}

async function ensureAgentUser(
  agent: IndexAgent,
): Promise<{ seeded: boolean; credential?: SeededAgentCredential }> {
  const row = await db.agent.findUnique({ where: { slug: agent.user } });
  if (!row) throw new Error(`agent row missing after upsert: ${agent.user}`);

  const existing = await db.user.findUnique({ where: { username: agent.user } });
  if (existing) {
    // Re-link if a previous sync left agentId null.
    if (!existing.agentId) {
      await db.user.update({
        where: { id: existing.id },
        data: { agentId: row.id, status: "active" },
      });
    } else if (existing.status === "deactivated") {
      await db.user.update({ where: { id: existing.id }, data: { status: "active" } });
    }
    return { seeded: false };
  }

  // First-time seed: generate temp credential, write it to disk, persist hash.
  const credential = await ensureAgentCredential(agent.user);
  const passwordHash = await hashPassword(credential.password);

  await db.user.create({
    data: {
      username: agent.user,
      email: agent.email ?? `${agent.user}@local`,
      kind: "agent",
      passwordHash,
      passwordSetAt: new Date(),
      mustRotatePassword: true,
      agentId: row.id,
    },
  });

  return { seeded: true, credential };
}
