import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAgentIndex, gatewayPortFor } from "@/lib/agents/index-loader";
import { syncAgents } from "@/lib/agents/sync";
import { runManageUser } from "@/lib/agents/manage-user";
import {
  allocatePorts,
  buildAgentEntry,
  renderAgentFiles,
  type ProvisionListener,
} from "@/lib/agents/provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTECTED_USERS = ["root", "zeh", "karen", "system", "admin", "daemon", "bin", "sys", "code-agents"];

const EditSchema = z.object({
  user: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
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
  model_config: z.object({
    default_model: z.string().min(1),
    fallback_models: z.array(z.string()).default([]),
    selected_models: z
      .array(z.object({ provider: z.string().min(1), id: z.string().min(1), name: z.string().optional() }))
      .min(1, "select at least one model"),
  }),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (session.user.name !== "zeh") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.format() }, { status: 400 });
  }
  const data = parsed.data;

  // Protected/system identities are not editable through this surface.
  if (PROTECTED_USERS.includes(data.user)) {
    return NextResponse.json({ error: "protected_user" }, { status: 400 });
  }

  let index;
  try {
    index = await readAgentIndex();
  } catch {
    return NextResponse.json({ error: "registry_read_failed" }, { status: 500 });
  }

  const existing = index.agents.find((a) => a.user === data.user);
  if (!existing) {
    return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  }
  if (existing.uid == null) {
    return NextResponse.json({ error: "agent_missing_uid" }, { status: 500 });
  }

  const roleChanged = existing.role !== data.role;

  // Keep the existing port allocation unless the role changed (which flips the
  // gateway/sidecar listener shape); only then reallocate against the others.
  let listeners: ProvisionListener[];
  let gatewayPort: number | undefined;
  if (roleChanged) {
    const allocation = allocatePorts(
      index.agents.filter((a) => a.user !== data.user),
      data.role,
    );
    listeners = allocation.listeners;
    gatewayPort = allocation.gatewayPort;
  } else {
    listeners = (existing.listeners as ProvisionListener[] | undefined) ?? [];
    gatewayPort = gatewayPortFor(existing);
  }

  const entry = buildAgentEntry({
    user: data.user,
    uid: existing.uid,
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

  try {
    await runManageUser(["update", data.user], {
      entry,
      files,
      reinstallGateway: roleChanged,
      gatewayPort,
      telegramToken,
    });
  } catch (err) {
    console.error("[agents/edit] update failed:", err);
    return NextResponse.json(
      { error: "update_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  try {
    await syncAgents();
  } catch (err) {
    console.error("[agents/edit] syncAgents failed:", err);
  }

  try {
    await db.activityLog.create({
      data: {
        userId: session.user.id,
        kind: "agent.registry.edit",
        targetAgent: data.user,
        payload: JSON.stringify({ roleChanged, role: data.role }),
      },
    });
  } catch (err) {
    console.error("[agents/edit] activityLog failed:", err);
  }

  return NextResponse.json({ ok: true, agent: entry });
}
