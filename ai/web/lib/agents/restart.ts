import { db } from "@/lib/db";
import { resolveEffectiveAgentConfig } from "@/lib/agents/effective-config";

async function snapshotServices(agent: string) {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json() as {
      agents?: Record<string, { services?: string[] }>;
      system?: Record<string, unknown>;
    };
    const direct = data.agents?.[agent]?.services ?? [];
    const fromSystem = Object.keys(data.system ?? {})
      .filter((name) => name.startsWith(`${agent}/`))
      .map((name) => name.slice(agent.length + 1));
    return Array.from(new Set([...direct, ...fromSystem]));
  } catch {
    return [];
  }
}

export type AgentRestartResult = { service: string; ok: boolean; status: number; error?: string };
export type QueuedAgentRestart = { queued: true; agent: string; reason: string };

export async function requestAgentRestart(agent: string, reason: string): Promise<AgentRestartResult[]> {
  const [row, allRows] = await Promise.all([
    db.agent.findUnique({ where: { slug: agent } }),
    db.agent.findMany({ select: { rawJson: true } }),
  ]);
  const effective = await resolveEffectiveAgentConfig(row?.rawJson ?? null, allRows.map((r) => r.rawJson));
  const services = Array.from(new Set([...effective.services, ...(await snapshotServices(agent))]));
  const targets = services.filter((service) => service.startsWith("openclaw-") && service.endsWith(".service"));
  const attempted = targets.length > 0 ? targets : ["openclaw-gateway.service"];
  const results: AgentRestartResult[] = [];

  for (const service of attempted) {
    try {
      const res = await fetch("http://127.0.0.1:3013/agents/services/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: agent, service }),
        cache: "no-store",
      });
      const text = await res.text().catch(() => "");
      results.push({ service, ok: res.ok, status: res.status, error: res.ok ? undefined : text.slice(0, 500) });
    } catch (err) {
      results.push({ service, ok: false, status: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await db.activityLog.create({
    data: {
      kind: results.some((r) => r.ok) ? "agent.restart.requested" : "agent.restart.failed",
      targetAgent: agent,
      payload: JSON.stringify({ reason, services: results }),
    },
  });

  return results;
}

export function queueAgentRestart(agent: string, reason: string): QueuedAgentRestart {
  const queued = { queued: true as const, agent, reason };
  setImmediate(() => {
    void requestAgentRestart(agent, reason).catch((err) => {
      void db.activityLog.create({
        data: {
          kind: "agent.restart.failed",
          targetAgent: agent,
          payload: JSON.stringify({ reason, queued: true, error: err instanceof Error ? err.message : String(err) }),
        },
      }).catch(() => undefined);
    });
  });
  return queued;
}
