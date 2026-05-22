import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/profile";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type RawAgent = { uid?: number; services?: string[] };

function parseRaw(raw: string | null): RawAgent {
  if (!raw) return {};
  try { return JSON.parse(raw) as RawAgent; } catch { return {}; }
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

  const row = await db.agent.findUnique({ where: { slug: agentId } });
  if (!row) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const raw = parseRaw(row.rawJson);
  if (!(raw.services ?? []).includes(body.service)) {
    return NextResponse.json({ error: "service not listed for this agent" }, { status: 404 });
  }
  if (!raw.uid) return NextResponse.json({ error: "agent uid missing from registry" }, { status: 400 });

  const action = body.enabled ? "start" : "stop";
  try {
    await execFileAsync("sudo", [
      "-n", "-u", agentId, "env",
      `XDG_RUNTIME_DIR=/run/user/${raw.uid}`,
      `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${raw.uid}/bus`,
      "systemctl", "--user", action, body.service,
    ], { timeout: 30000 });
    return NextResponse.json({ ok: true, service: body.service, enabled: body.enabled });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
