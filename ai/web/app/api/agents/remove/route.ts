import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAgentIndex } from "@/lib/agents/index-loader";
import { syncAgents } from "@/lib/agents/sync";
import { runManageUser } from "@/lib/agents/manage-user";
import { summarizeAgentDeletion } from "@/lib/agents/deletion-summary";

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

  let inRegistry = false;
  try {
    const index = await readAgentIndex();
    inRegistry = index.agents.some((a) => a.user === user);
  } catch {
    // Registry unreadable — fall through; the helper still validates, and we
    // can still reconcile a stale PM row below.
  }

  // Allow cleanup of a stale PM row whose registry entry is already gone (e.g.
  // an agent removed before this route hard-deleted the dashboard card).
  const existingAgent = await db.agent.findUnique({ where: { slug: user } });
  if (!inRegistry && !existingAgent) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }

  // Snapshot the blast radius before anything is torn down (for the response
  // and the audit log).
  const summary = await summarizeAgentDeletion(user);

  // The root helper removes the system user, Samba/sudoers state, the runtime
  // dir, and the registry entry, then reconciles via install.sh. Skip it when
  // the agent is already gone from the registry (stale PM-row cleanup only).
  if (inRegistry) {
    try {
      await runManageUser(["delete", user]);
    } catch (err) {
      console.error("[agents/remove] deprovisioning failed:", err);
      return NextResponse.json(
        { error: "deprovisioning_failed", message: (err as Error).message },
        { status: 500 },
      );
    }
  }

  try {
    await syncAgents();
  } catch (err) {
    console.error("[agents/remove] syncAgents failed:", err);
  }

  // Retire the PM account but keep its history: deactivate + unlink the login,
  // then hard-delete the Agent row so its dashboard card disappears for good.
  // The user row is intentionally preserved — several tables hold a required,
  // non-cascading FK to it (chat messages, proposals), so a full user delete
  // would either fail or tear holes in shared conversation history.
  try {
    const agentRow = await db.agent.findUnique({ where: { slug: user }, include: { user: true } });
    if (agentRow) {
      if (agentRow.user) {
        await db.user.update({
          where: { id: agentRow.user.id },
          data: { status: "deactivated", agentId: null },
        });
      }
      await db.agent.delete({ where: { id: agentRow.id } });
    }
  } catch (err) {
    console.error("[agents/remove] PM row cleanup failed:", err);
    return NextResponse.json(
      { error: "pm_cleanup_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  try {
    await db.activityLog.create({
      data: {
        userId: session.user.id,
        kind: "agent.registry.remove",
        targetAgent: user,
        payload: JSON.stringify({ user, summary }),
      },
    });
  } catch (err) {
    console.error("[agents/remove] activityLog failed:", err);
  }

  return NextResponse.json({ ok: true, removed: user, summary });
}
