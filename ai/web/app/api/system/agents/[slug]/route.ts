import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAgentIndex } from "@/lib/agents/index-loader";
import { syncAgents } from "@/lib/agents/sync";
import { z } from "zod";
import { writeFile, rename } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

const PROTECTED_USERS = ["root", "zeh", "karen", "system", "admin", "daemon", "bin", "sys", "code-agents"];

const EditSchema = z.object({
  uid: z.number().int().min(1001).optional(),
  name: z.string().min(1).optional(),
  role: z.enum(["coding", "monitor"]).optional(),
  email: z.string().email().optional().or(z.literal("")).or(z.null()),
  gitName: z.string().optional().or(z.null()),
  gitEmail: z.string().optional().or(z.null()),
});

async function writeRegistryAtomically(registryPath: string, indexData: any) {
  const dir = path.dirname(registryPath);
  const tmp = path.join(dir, `.agents.json.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, JSON.stringify(indexData, null, 2), "utf8");
  await rename(tmp, registryPath);
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  const params = await context.params;
  const slug = params.slug;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (session.user?.name !== "zeh") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (PROTECTED_USERS.includes(slug)) {
    return NextResponse.json({ error: "protected_user" }, { status: 400 });
  }

  const registryPath = process.env.AGENT_INDEX_PATH ?? "/srv/agents/index.json";
  let index: any;
  try {
    index = await readAgentIndex(registryPath);
  } catch (err) {
    return NextResponse.json({ error: "registry_read_failed" }, { status: 500 });
  }

  const agentIndex = index.agents.findIndex((a: any) => a.user === slug);
  if (agentIndex === -1) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }

  const oldAgents = [...index.agents];
  index.agents.splice(agentIndex, 1);

  try {
    await writeRegistryAtomically(registryPath, index);
  } catch (err) {
    return NextResponse.json({ error: "registry_write_failed" }, { status: 500 });
  }

  try {
    await execPromise(`sudo /usr/local/sbin/openclaw-manage-user delete ${slug}`);
  } catch (err) {
    console.error("[agents-api] openclaw-manage-user delete failed, rolling back:", err);
    index.agents = oldAgents;
    await writeRegistryAtomically(registryPath, index).catch((e) => console.error("failed delete rollback:", e));
    return NextResponse.json({ error: "deprovisioning_failed", message: (err as Error).message }, { status: 500 });
  }

  const repoRoot = path.resolve(process.cwd(), "../..");
  const installScript = path.join(repoRoot, "ai", "openclaw", "install.sh");

  try {
    await execPromise(`sudo ${installScript}`);
  } catch (err) {
    console.error("[agents-api] install.sh failed after delete:", err);
    // Note: Deletion is critical path, installation check failure still returns 500 but state has changed.
    return NextResponse.json({ error: "installation_failed", message: (err as Error).message }, { status: 500 });
  }

  try {
    await syncAgents();
  } catch (err) {
    console.error("[agents-api] syncAgents failed:", err);
  }

  try {
    await db.activityLog.create({
      data: {
        kind: "agent.delete",
        targetAgent: slug,
        userId: session.user.id || null,
        payload: JSON.stringify({ user: slug }),
      },
    });
  } catch (err) {
    console.error("[agents-api] activityLog failed:", err);
  }

  return NextResponse.json({ success: true });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  const params = await context.params;
  const slug = params.slug;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (session.user?.name !== "zeh") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.format() }, { status: 400 });
  }

  const updates = parsed.data;
  const registryPath = process.env.AGENT_INDEX_PATH ?? "/srv/agents/index.json";
  let index: any;
  try {
    index = await readAgentIndex(registryPath);
  } catch (err) {
    return NextResponse.json({ error: "registry_read_failed" }, { status: 500 });
  }

  const agent = index.agents.find((a: any) => a.user === slug);
  if (!agent) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }

  // Immutable UID check
  if (updates.uid !== undefined && updates.uid !== agent.uid) {
    return NextResponse.json({ error: "uid_immutable" }, { status: 400 });
  }

  const oldAgents = JSON.parse(JSON.stringify(index.agents));
  const oldRole = agent.role;

  if (updates.name !== undefined) agent.name = updates.name.trim();
  if (updates.role !== undefined) agent.role = updates.role;
  if (updates.email !== undefined) agent.email = updates.email || null;
  if (updates.gitName !== undefined) agent.gitName = updates.gitName || null;
  if (updates.gitEmail !== undefined) agent.gitEmail = updates.gitEmail || null;

  // Re-build listeners if role changed
  if (updates.role !== undefined && updates.role !== oldRole) {
    agent.listeners = updates.role === "monitor" ? [] : [
      {
        host: "127.0.0.1",
        port: 3000 + agent.uid,
        owner: "openclaw-gateway",
        expected: true,
      },
    ];
  }

  try {
    await writeRegistryAtomically(registryPath, index);
  } catch (err) {
    return NextResponse.json({ error: "registry_write_failed" }, { status: 500 });
  }

  // System actions ONLY if role changed
  if (updates.role !== undefined && updates.role !== oldRole) {
    try {
      // De-provision old role
      await execPromise(`sudo /usr/local/sbin/openclaw-manage-user delete ${slug}`);
      // Provision with new role
      await execPromise(`sudo /usr/local/sbin/openclaw-manage-user add ${slug} ${agent.uid} ${updates.role}`);
      // Run install script
      const repoRoot = path.resolve(process.cwd(), "../..");
      const installScript = path.join(repoRoot, "ai", "openclaw", "install.sh");
      await execPromise(`sudo ${installScript}`);
    } catch (err) {
      console.error("[agents-api] system modification during role edit failed, rolling back:", err);
      // Rollback registry
      index.agents = oldAgents;
      await writeRegistryAtomically(registryPath, index).catch((e) => console.error("failed rollback:", e));
      // Re-provision old role system-side (best effort)
      await execPromise(`sudo /usr/local/sbin/openclaw-manage-user delete ${slug}`).catch(() => undefined);
      await execPromise(`sudo /usr/local/sbin/openclaw-manage-user add ${slug} ${agent.uid} ${oldRole}`).catch(() => undefined);
      
      const repoRoot = path.resolve(process.cwd(), "../..");
      const installScript = path.join(repoRoot, "ai", "openclaw", "install.sh");
      await execPromise(`sudo ${installScript}`).catch(() => undefined);

      return NextResponse.json({ error: "system_edit_failed", message: (err as Error).message }, { status: 500 });
    }
  }

  try {
    await syncAgents();
  } catch (err) {
    console.error("[agents-api] syncAgents failed:", err);
  }

  try {
    await db.activityLog.create({
      data: {
        kind: "agent.edit",
        targetAgent: slug,
        userId: session.user.id || null,
        payload: JSON.stringify({ user: slug, updates }),
      },
    });
  } catch (err) {
    console.error("[agents-api] activityLog failed:", err);
  }

  return NextResponse.json(agent);
}
