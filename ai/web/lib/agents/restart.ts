import { db } from "@/lib/db";

async function snapshotServices(agent: string) {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json() as { agents?: Record<string, { services?: string[] }> };
    return data.agents?.[agent]?.services ?? [];
  } catch {
    return [];
  }
}

export async function requestAgentRestart(agent: string, reason: string) {
  const row = await db.agent.findUnique({ where: { slug: agent } });
  const raw = row?.rawJson ? JSON.parse(row.rawJson) as { services?: string[] } : {};
  const services = Array.from(new Set([...(raw.services ?? []), ...(await snapshotServices(agent))]));
  const targets = services.filter((service) => service.startsWith("openclaw-") && service.endsWith(".service"));
  const attempted = targets.length > 0 ? targets : ["openclaw-gateway.service"];
  const results: Array<{ service: string; ok: boolean; status: number; error?: string }> = [];

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
