import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isOwnerUserId } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { DEFAULT_AGENT_REASONING, normalizeAgentReasoning, normalizeAgentThinking, readAgentIndex, gatewayPortFor } from "@/lib/agents/management/index-loader";
import { syncAgents } from "@/lib/agents/management/sync";
import { runManageUser } from "@/lib/agents/management/manage-user";
import { getSystemSettings } from "@/lib/settings/system";
import { queueProfileImageGenerationRequest } from "@/lib/agents/management/profile-image-generation";
import { readAgentImagesState } from "@/lib/agents/management/profile-images";
import {
  normalizeProfileImageAgeGroup,
  normalizeProfileImageContextText,
  normalizeProfileImageCustomizationMode,
  normalizeProfileImageEthnicity,
  normalizeProfileImageGender,
  normalizeProfileImagePrompt,
} from "@/lib/agents/management/profile-image-options";
import { MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/management/profile-image-themes";
import { isProtectedAgentUsername } from "@/lib/agents/management/protected-usernames";
import {
  allocatePorts,
  buildAgentEntry,
  renderAgentFiles,
  type ProvisionListener,
} from "@/lib/agents/management/provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_ROOT_SUFFIX = "/ai/web";

const EditSchema = z.object({
  user: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  name: z.string().min(1).max(120),
  role: z.enum(["coding", "monitor"]),
  reasoning: z.string().trim().max(40).optional().default(DEFAULT_AGENT_REASONING),
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
  if (!(await isOwnerUserId(session.user.id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = EditSchema.safeParse(body);
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
  const reasoning = normalizeAgentReasoning(data.reasoning);

  // Protected/system identities are not editable through this surface.
  if (isProtectedAgentUsername(data.user)) {
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
  const previousImageTheme = normalizeProfileImageTheme(
    (existing as { profileImages?: { theme?: unknown } }).profileImages?.theme,
  );
  const previousImageCustomizationMode = normalizeProfileImageCustomizationMode(
    (existing as { profileImages?: { customizationMode?: unknown } }).profileImages?.customizationMode,
  );
  const previousImageGender = normalizeProfileImageGender(
    (existing as { profileImages?: { gender?: unknown } }).profileImages?.gender,
  );
  const previousImageAgeGroup = normalizeProfileImageAgeGroup(
    (existing as { profileImages?: { ageGroup?: unknown } }).profileImages?.ageGroup,
  );
  const previousImageEthnicity = normalizeProfileImageEthnicity(
    (existing as { profileImages?: { ethnicity?: unknown } }).profileImages?.ethnicity,
  );
  const previousImagePrompt = normalizeProfileImagePrompt(
    (existing as { profileImages?: { prompt?: unknown } }).profileImages?.prompt,
  );
  const previousImageUsername = normalizeProfileImageContextText(
    (existing as { profileImages?: { username?: unknown } }).profileImages?.username,
  ) || data.user;
  const previousImageFullName = normalizeProfileImageContextText(
    (existing as { profileImages?: { fullName?: unknown } }).profileImages?.fullName,
  ) || data.name;
  const previousImageBio = normalizeProfileImageContextText(
    (existing as { profileImages?: { bio?: unknown } }).profileImages?.bio,
    500,
  );
  const settings = await getSystemSettings();
  const usesOpenRouter = data.model_config.selected_models.some((m) => m.provider === "openrouter");
  if (usesOpenRouter && !settings.openRouterApiKey) {
    return NextResponse.json({ error: "openrouter_api_key_required" }, { status: 400 });
  }

  const roleChanged = existing.role !== data.role;
  // Effort is a host policy stored in the registry, not the reasoning-output
  // visibility control in this form. Preserve it across an otherwise unrelated
  // Agent edit so a requested `xhigh` policy cannot silently fall back to low.
  const thinking = normalizeAgentThinking(existing.thinking);

  // Keep the existing port allocation unless the role changed (which flips the
  // gateway/sidecar listener shape); only then reallocate against the others.
  let listeners: ProvisionListener[];
  let gatewayPort: number | undefined;
  if (roleChanged) {
    let allocation;
    try {
      allocation = await allocatePorts(
        index.agents.filter((a) => a.user !== data.user),
        data.role,
      );
    } catch (err) {
      return NextResponse.json(
        { error: "port_allocation_failed", message: (err as Error).message },
        { status: 500 },
      );
    }
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
    reasoning,
    thinking,
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
    reasoning,
    thinking,
    primary: data.model_config.default_model,
    fallbacks: data.model_config.fallback_models,
    selectedModels: data.model_config.selected_models,
    gatewayPort,
    openRouterApiKey: settings.openRouterApiKey,
  });

  const telegramToken = data.telegram?.enabled ? data.telegram.token ?? "" : "";

  try {
    await runManageUser(["update", data.user], {
      repoRoot: activeRepoRoot(),
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
        payload: JSON.stringify({ roleChanged, role: data.role, reasoning, imageTheme, imageCustomizationMode, imageGender, imageAgeGroup, imageEthnicity, imageUsername, imageFullName, imageBio }),
      },
    });
  } catch (err) {
    console.error("[agents/edit] activityLog failed:", err);
  }

  let imageRequest: Awaited<ReturnType<typeof queueProfileImageGenerationRequest>> | null = null;
  try {
    const imageState = await readAgentImagesState(data.user);
    const needsGeneratedImages =
      imageTheme !== MANUAL_IMAGE_THEME &&
      (imageTheme !== previousImageTheme ||
        imageCustomizationMode !== previousImageCustomizationMode ||
        imageGender !== previousImageGender ||
        imageAgeGroup !== previousImageAgeGroup ||
        imageEthnicity !== previousImageEthnicity ||
        imagePrompt !== previousImagePrompt ||
        imageUsername !== previousImageUsername ||
        imageFullName !== previousImageFullName ||
        imageBio !== previousImageBio ||
        !imageState.images.profile.exists ||
        !imageState.images.avatar.exists);
    if (needsGeneratedImages) {
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
    }
  } catch (err) {
    console.error("[agents/edit] profile image generation request failed:", err);
    imageRequest = { requested: false, reason: (err as Error).message };
  }

  return NextResponse.json({ ok: true, agent: entry, imageRequest });
}

function activeRepoRoot(): string | null {
  const appRoot = process.env.PM_APP_ROOT;
  if (appRoot?.endsWith(APP_ROOT_SUFFIX)) {
    return appRoot.slice(0, -APP_ROOT_SUFFIX.length);
  }
  return null;
}
