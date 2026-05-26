import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/profile";
import { db } from "@/lib/db";
import { resolveEffectiveAgentConfig } from "@/lib/agents/effective-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

function uidFromRaw(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { uid?: unknown };
    return typeof parsed.uid === "number" ? parsed.uid : null;
  } catch {
    return null;
  }
}

async function snapshotServices(agent: string) {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
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

async function toggleViaSystemctl(agentId: string, uid: number, service: string, enabled: boolean) {
  await execFileAsync("sudo", [
    "-n",
    "-u",
    agentId,
    "env",
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
    "systemctl",
    "--user",
    enabled ? "start" : "stop",
    service,
  ], { timeout: 30000 });
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const { agentId } = await params;
  const allowed = await canEditProfile({ name: session.user.name, kind: session.user.kind }, agentId);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null) as { service?: unknown; enabled?: unknown } | null;
  if (!body || typeof body.service !== "string" || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "service and boolean enabled are required" }, { status: 400 });
  }

  const [row, allRows] = await Promise.all([
    db.agent.findUnique({ where: { slug: agentId } }),
    db.agent.findMany({ select: { rawJson: true } }),
  ]);
  if (!row) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const effective = await resolveEffectiveAgentConfig(row.rawJson, allRows.map((r) => r.rawJson));
  const allowedServices = new Set([...effective.services, ...(await snapshotServices(agentId))]);
  if (!allowedServices.has(body.service)) {
    return NextResponse.json({ error: "service not listed for this agent" }, { status: 404 });
  }

  try {
    const res = await fetch("http://127.0.0.1:3013/agents/services/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: agentId, service: body.service, enabled: body.enabled }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (res.status === 404) {
      const uid = uidFromRaw(row.rawJson);
      if (uid == null) return NextResponse.json({ error: "agent uid missing from registry" }, { status: 400 });
      await toggleViaSystemctl(agentId, uid, body.service, body.enabled);
      await db.activityLog.create({
        data: {
          userId: session.user.id,
          kind: "agent.service.toggle",
          targetAgent: agentId,
          payload: JSON.stringify({ service: body.service, enabled: body.enabled, driver: "systemctl-user" }),
        },
      });
      return NextResponse.json({ ok: true, service: body.service, enabled: body.enabled, driver: "systemctl-user" });
    }
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
