import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAgentIndex } from "@/lib/agents/index-loader";
import { syncAgents } from "@/lib/agents/sync";
import { runManageUser } from "@/lib/agents/manage-user";
import {
  allocatePorts,
  allocateUid,
  buildAgentEntry,
  renderAgentFiles,
} from "@/lib/agents/provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTECTED_USERS = ["root", "zeh", "karen", "system", "admin", "daemon", "bin", "sys", "code-agents"];

const ModelConfigSchema = z.object({
  default_model: z.string().min(1),
  fallback_models: z.array(z.string()).default([]),
  selected_models: z
    .array(z.object({ provider: z.string().min(1), id: z.string().min(1), name: z.string().optional() }))
    .min(1, "select at least one model"),
});

const AddSchema = z.object({
  user: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "lowercase slug, starts with a letter"),
  name: z.string().min(1).max(120),
  role: z.enum(["coding", "monitor"]),
  email: z.string().email(),
  telegram: z
    .object({ enabled: z.boolean(), bot: z.string(), token: z.string().optional().default("") })
    .optional(),
  integrations: z
    .object({
      gmail: z.boolean(),
      jira: z.boolean(),
      bitbucket: z.boolean(),
      maildir: z.boolean().optional().default(false),
    })
    .optional(),
  model_config: ModelConfigSchema,
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (session.user.name !== "zeh") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.format() }, { status: 400 });
  }
  const data = parsed.data;

  if (PROTECTED_USERS.includes(data.user)) {
    return NextResponse.json({ error: "protected_user" }, { status: 400 });
  }

  let index;
  try {
    index = await readAgentIndex();
  } catch {
    return NextResponse.json({ error: "registry_read_failed" }, { status: 500 });
  }

  if (index.agents.some((a) => a.user === data.user)) {
    return NextResponse.json({ error: "username_collision" }, { status: 409 });
  }

  const uid = allocateUid(index.agents);
  const { listeners, gatewayPort } = allocatePorts(index.agents, data.role);

  const entry = buildAgentEntry({
    user: data.user,
    uid,
    name: data.name,
    role: data.role,
    email: data.email,
    telegram: data.telegram,
    integrations: data.integrations,
    listeners,
  });

  const files = renderAgentFiles({
    name: data.name,
    user: data.user,
    role: data.role,
    email: data.email,
    primary: data.model_config.default_model,
    fallbacks: data.model_config.fallback_models,
    selectedModels: data.model_config.selected_models,
  });

  const telegramToken = data.telegram?.enabled ? data.telegram.token ?? "" : "";

  // Privileged provisioning happens entirely in the root helper, which also
  // owns the registry write. On any failure, roll the system user back.
  try {
    await runManageUser(["add", data.user, String(uid), data.role], {
      gatewayPort,
      entry,
      files,
      telegramToken,
    });
  } catch (err) {
    console.error("[agents/add] provisioning failed, rolling back:", err);
    await runManageUser(["delete", data.user]).catch((e) =>
      console.error("[agents/add] rollback delete failed:", e),
    );
    return NextResponse.json(
      { error: "provisioning_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  // Reflect the new registry into the PM database (non-fatal if it lags).
  try {
    await syncAgents();
  } catch (err) {
    console.error("[agents/add] syncAgents failed:", err);
  }

  try {
    await db.activityLog.create({
      data: {
        userId: session.user.id,
        kind: "agent.registry.add",
        targetAgent: data.user,
        payload: JSON.stringify({ uid, role: data.role }),
      },
    });
  } catch (err) {
    console.error("[agents/add] activityLog failed:", err);
  }

  return NextResponse.json({ ok: true, agent: entry }, { status: 201 });
}
