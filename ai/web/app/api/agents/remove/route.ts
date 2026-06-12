import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAgentIndex } from "@/lib/agents/index-loader";
import { syncAgents } from "@/lib/agents/sync";
import { runManageUser } from "@/lib/agents/manage-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTECTED_USERS = ["root", "zeh", "karen", "system", "admin", "daemon", "bin", "sys", "code-agents"];

const RemoveSchema = z.object({
  user: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (session.user.name !== "zeh") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = RemoveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.format() }, { status: 400 });
  }
  const { user } = parsed.data;

  // Never deprovision the operator, the monitor that runs this service, or a
  // system account. (The root helper enforces this too — defence in depth.)
  if (PROTECTED_USERS.includes(user)) {
    return NextResponse.json({ error: "protected_user" }, { status: 400 });
  }

  try {
    const index = await readAgentIndex();
    if (!index.agents.some((a) => a.user === user)) {
      return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    }
  } catch {
    // If the registry can't be read, fall through — the helper still validates.
  }

  // The root helper removes the system user, Samba/sudoers state, the runtime
  // dir, and the registry entry, then reconciles via install.sh.
  try {
    await runManageUser(["delete", user]);
  } catch (err) {
    console.error("[agents/remove] deprovisioning failed:", err);
    return NextResponse.json(
      { error: "deprovisioning_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  try {
    await syncAgents();
  } catch (err) {
    console.error("[agents/remove] syncAgents failed:", err);
  }

  try {
    await db.activityLog.create({
      data: {
        userId: session.user.id,
        kind: "agent.registry.remove",
        targetAgent: user,
        payload: JSON.stringify({ user }),
      },
    });
  } catch (err) {
    console.error("[agents/remove] activityLog failed:", err);
  }

  return NextResponse.json({ ok: true, removed: user });
}
