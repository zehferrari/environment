import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAgentIndex } from "@/lib/agents/index-loader";
import { syncAgents } from "@/lib/agents/sync";
import { runManageUser } from "@/lib/agents/manage-user";
import { getSystemSettings } from "@/lib/settings/system";
import { queueProfileImageGenerationRequest } from "@/lib/agents/profile-image-generation";
import {
  normalizeProfileImageAgeGroup,
  normalizeProfileImageContextText,
  normalizeProfileImageCustomizationMode,
  normalizeProfileImageEthnicity,
  normalizeProfileImageGender,
  normalizeProfileImagePrompt,
} from "@/lib/agents/profile-image-options";
import { MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/profile-image-themes";
import {
  allocatePorts,
  allocateUid,
  buildAgentEntry,
  renderAgentFiles,
  type ProvisionListener,
} from "@/lib/agents/provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTECTED_USERS = ["root", "zeh", "karen", "system", "admin", "daemon", "bin", "sys", "code-agents"];
const APP_ROOT_SUFFIX = "/ai/web";

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
  image_theme: z.string().trim().min(1).max(120).optional().default(MANUAL_IMAGE_THEME),
  image_gender: z.string().trim().min(1).max(40).optional().default("Random"),
  image_age_group: z.string().trim().min(1).max(40).optional().default("Random"),
  image_ethnicity: z.string().trim().min(1).max(40).optional().default("Random"),
  image_customization_mode: z.string().trim().min(1).max(20).optional().default("Random"),
  image_prompt: z.string().trim().min(1).max(2000).optional(),
  image_username: z.string().trim().max(120).optional(),
  image_full_name: z.string().trim().max(120).optional(),
  image_bio: z.string().trim().max(500).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!session.user.id) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (session.user.name !== "zeh") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.format() }, { status: 400 });
  }
  const data = parsed.data;
  const imageTheme = normalizeProfileImageTheme(data.image_theme);
  const imageGender = normalizeProfileImageGender(data.image_gender);
  const imageAgeGroup = normalizeProfileImageAgeGroup(data.image_age_group);
  const imageEthnicity = normalizeProfileImageEthnicity(data.image_ethnicity);
  const imageCustomizationMode = normalizeProfileImageCustomizationMode(data.image_customization_mode);
  const imagePrompt = normalizeProfileImagePrompt(data.image_prompt);
  const imageUsername = normalizeProfileImageContextText(data.image_username) || data.user;
  const imageFullName = normalizeProfileImageContextText(data.image_full_name) || data.name;
  const imageBio = normalizeProfileImageContextText(data.image_bio, 500);

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
  let listeners: ProvisionListener[];
  let gatewayPort: number;
  try {
    const allocation = await allocatePorts(index.agents, data.role);
    listeners = allocation.listeners;
    gatewayPort = allocation.gatewayPort;
  } catch (err) {
    return NextResponse.json(
      { error: "port_allocation_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
  const settings = await getSystemSettings();
  const usesOpenRouter = data.model_config.selected_models.some((m) => m.provider === "openrouter");
  if (usesOpenRouter && !settings.openRouterApiKey) {
    return NextResponse.json({ error: "openrouter_api_key_required" }, { status: 400 });
  }

  const entry = buildAgentEntry({
    user: data.user,
    uid,
    name: data.name,
    role: data.role,
    email: data.email,
    telegram: data.telegram,
    integrations: data.integrations,
    imageTheme,
    imageGender,
    imageAgeGroup,
    imageEthnicity,
    imageCustomizationMode,
    imagePrompt,
    imageUsername,
    imageFullName,
    imageBio,
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
    openRouterApiKey: settings.openRouterApiKey,
  });

  const telegramToken = data.telegram?.enabled ? data.telegram.token ?? "" : "";

  // Privileged provisioning happens entirely in the root helper, which also
  // owns the registry write. On any failure, roll the system user back.
  try {
    await runManageUser(["add", data.user, String(uid), data.role], {
      repoRoot: activeRepoRoot(),
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
        payload: JSON.stringify({ uid, role: data.role, imageTheme, imageGender, imageAgeGroup, imageEthnicity }),
      },
    });
  } catch (err) {
    console.error("[agents/add] activityLog failed:", err);
  }

  let imageRequest: Awaited<ReturnType<typeof queueProfileImageGenerationRequest>> | null = null;
  try {
    imageRequest = await queueProfileImageGenerationRequest({
      newAgentSlug: data.user,
      newAgentName: data.name,
      theme: imageTheme,
      customizationMode: imageCustomizationMode,
      prompt: imagePrompt,
      gender: imageGender,
      ageGroup: imageAgeGroup,
      ethnicity: imageEthnicity,
      username: imageUsername,
      fullName: imageFullName,
      bio: imageBio,
      requestedByUserId: session.user.id,
      requestedByName: session.user.name ?? session.user.id,
    });
  } catch (err) {
    console.error("[agents/add] profile image generation request failed:", err);
    imageRequest = { requested: false, reason: (err as Error).message };
  }

  return NextResponse.json({ ok: true, agent: entry, imageRequest }, { status: 201 });
}

function activeRepoRoot(): string | null {
  const appRoot = process.env.PM_APP_ROOT;
  if (appRoot?.endsWith(APP_ROOT_SUFFIX)) {
    return appRoot.slice(0, -APP_ROOT_SUFFIX.length);
  }
  return null;
}
