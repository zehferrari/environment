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

const RegisterSchema = z.object({
  user: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(32),
  uid: z.number().int().min(1001),
  name: z.string().min(1),
  role: z.enum(["coding", "monitor"]),
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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (session.user?.name !== "zeh") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const index = await readAgentIndex();
    return NextResponse.json(index.agents);
  } catch (err) {
    console.error("[agents-api] GET error:", err);
    return NextResponse.json({ error: "failed to read agent index" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
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

  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.format() }, { status: 400 });
  }

  const data = parsed.data;

  const PROTECTED_USERS = ["root", "zeh", "karen", "system", "admin", "daemon", "bin", "sys", "code-agents"];
  if (PROTECTED_USERS.includes(data.user)) {
    return NextResponse.json({ error: "protected_user" }, { status: 400 });
  }
  const registryPath = process.env.AGENT_INDEX_PATH ?? "/srv/agents/index.json";

  let index: any;
  try {
    index = await readAgentIndex(registryPath);
  } catch (err) {
    index = { version: 1, codeOwner: "zeh", agents: [] };
  }

  // Check unique constraints
  if (index.agents.some((a: any) => a.user === data.user)) {
    return NextResponse.json({ error: "username_collision" }, { status: 400 });
  }
  if (index.agents.some((a: any) => a.uid === data.uid)) {
    return NextResponse.json({ error: "uid_collision" }, { status: 400 });
  }

  const oldAgents = [...index.agents];
  const newAgent = {
    user: data.user,
    uid: data.uid,
    name: data.name,
    role: data.role,
    enabled: true,
    home: `/home/${data.user}`,
    workspace: `/home/${data.user}/workspace`,
    email: data.email || null,
    gitName: data.gitName || null,
    gitEmail: data.gitEmail || null,
    listeners: data.role === "monitor" ? [] : [
      {
        host: "127.0.0.1",
        port: 3000 + data.uid,
        owner: "openclaw-gateway",
        expected: true,
      },
    ],
  };

  index.agents.push(newAgent);

  try {
    await writeRegistryAtomically(registryPath, index);
  } catch (err) {
    console.error("[agents-api] failed to write registry:", err);
    return NextResponse.json({ error: "registry_write_failed" }, { status: 500 });
  }

  // Run system helper and install script
  try {
    await execPromise(`sudo /usr/local/sbin/openclaw-manage-user add ${data.user} ${data.uid} ${data.role}`);
  } catch (err) {
    console.error("[agents-api] openclaw-manage-user failed, rolling back registry:", err);
    index.agents = oldAgents;
    await writeRegistryAtomically(registryPath, index).catch((e) => console.error("failed rollback:", e));
    return NextResponse.json({ error: "provisioning_failed", message: (err as Error).message }, { status: 500 });
  }

  const repoRoot = path.resolve(process.cwd(), "../..");
  const installScript = path.join(repoRoot, "ai", "openclaw", "install.sh");

  try {
    await execPromise(`sudo ${installScript}`);
  } catch (err) {
    console.error("[agents-api] install.sh failed, rolling back system user and registry:", err);
    // Rollback system user
    await execPromise(`sudo /usr/local/sbin/openclaw-manage-user delete ${data.user}`).catch((e) =>
      console.error("failed system user delete rollback:", e),
    );
    index.agents = oldAgents;
    await writeRegistryAtomically(registryPath, index).catch((e) => console.error("failed registry rollback:", e));
    return NextResponse.json({ error: "installation_failed", message: (err as Error).message }, { status: 500 });
  }

  // Database synchronization
  try {
    await syncAgents();
  } catch (err) {
    console.error("[agents-api] syncAgents failed:", err);
    // Note: DB sync failure is an operational warning, the agent is already in the registry and provisioned.
  }

  // Audit activity logging
  try {
    await db.activityLog.create({
      data: {
        kind: "agent.register",
        targetAgent: data.user,
        userId: session.user.id || null,
        payload: JSON.stringify({ user: data.user, uid: data.uid, role: data.role }),
      },
    });
  } catch (err) {
    console.error("[agents-api] activityLog failed:", err);
  }

  return NextResponse.json(newAgent, { status: 201 });
}
