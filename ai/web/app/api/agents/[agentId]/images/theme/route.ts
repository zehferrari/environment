import { readFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEditProfile } from "@/lib/agents/management/profile";
import { readAgentIndex } from "@/lib/agents/management/index-loader";
import { runManageUser } from "@/lib/agents/management/manage-user";
import { syncAgents } from "@/lib/agents/management/sync";
import { queueProfileImageGenerationRequest } from "@/lib/agents/management/profile-image-generation";
import { commitStagedAgentImages, linkAvatarToProfile, readAgentImagesState } from "@/lib/agents/management/profile-images";
import {
  normalizeProfileImageAgeGroup,
  normalizeProfileImageContextText,
  normalizeProfileImageCustomizationMode,
  normalizeProfileImageEthnicity,
  normalizeProfileImageGender,
  normalizeProfileImagePrompt,
} from "@/lib/agents/management/profile-image-options";
import { MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/management/profile-image-themes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_ROOT_SUFFIX = "/ai/web";
const BodySchema = z.object({
  theme: z.string().trim().min(1).max(120),
  gender: z.string().trim().min(1).max(40).optional().default("Random"),
  ageGroup: z.string().trim().min(1).max(40).optional().default("Random"),
  ethnicity: z.string().trim().min(1).max(40).optional().default("Random"),
  customizationMode: z.string().trim().min(1).max(20).optional().default("Random"),
  prompt: z.string().trim().min(1).max(2000).optional(),
  username: z.string().trim().max(120).optional(),
  fullName: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(500).optional(),
  savePromptAsDefault: z.boolean().optional().default(false),
  regenerate: z.boolean().optional().default(true),
  stagedImageId: z.string().trim().regex(/^[a-zA-Z0-9_-]{12,80}$/).optional(),
  useProfileAsAvatar: z.boolean().optional().default(false),
});

async function readCurrentAgentFiles(agent: string) {
  const root = path.join("/srv/agents/openclaw", agent);
  const read = (file: string) => readFile(path.join(root, file), "utf8");
  const [soul, identity, tools, memory, heartbeat, openclawJson] = await Promise.all([
    read("SOUL.md"),
    read("IDENTITY.md"),
    read("TOOLS.md"),
    read("MEMORY.md"),
    read("HEARTBEAT.md"),
    read("openclaw.json"),
  ]);
  return { soul, identity, tools, memory, heartbeat, openclawJson };
}

function activeRepoRoot(): string | null {
  const appRoot = process.env.PM_APP_ROOT;
  if (appRoot?.endsWith(APP_ROOT_SUFFIX)) {
    return appRoot.slice(0, -APP_ROOT_SUFFIX.length);
  }
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { agentId } = await params;
  const allowed = await canEditProfile({ name: session.user.name, kind: session.user.kind }, agentId);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed", details: parsed.error.format() }, { status: 400 });
  }

  const theme = normalizeProfileImageTheme(parsed.data.theme);
  const gender = normalizeProfileImageGender(parsed.data.gender);
  const ageGroup = normalizeProfileImageAgeGroup(parsed.data.ageGroup);
  const ethnicity = normalizeProfileImageEthnicity(parsed.data.ethnicity);
  const customizationMode = normalizeProfileImageCustomizationMode(parsed.data.customizationMode);
  const prompt = normalizeProfileImagePrompt(parsed.data.prompt);
  const username = normalizeProfileImageContextText(parsed.data.username) || agentId;
  const index = await readAgentIndex().catch(() => null);
  const existing = index?.agents.find((agent) => agent.user === agentId) as
    | (NonNullable<typeof index>["agents"][number] & Record<string, unknown>)
    | undefined;
  if (!existing) return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
  const fullName = normalizeProfileImageContextText(parsed.data.fullName) || (typeof existing.name === "string" ? existing.name : agentId);
  const bio = normalizeProfileImageContextText(parsed.data.bio, 500);

  const entry = {
    ...existing,
    profileImages: {
      theme,
      customizationMode,
      gender,
      ageGroup,
      ethnicity,
      prompt,
      username,
      fullName,
      bio,
    },
  };
  const files = await readCurrentAgentFiles(agentId).catch((err) => {
    throw new Error(`agent_files_unreadable: ${(err as Error).message}`);
  });

  try {
    await runManageUser(["update", agentId], {
      repoRoot: activeRepoRoot(),
      entry,
      files,
      reinstallGateway: false,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "theme_update_failed", message: (err as Error).message },
      { status: 500 },
    );
  }

  if (parsed.data.savePromptAsDefault) {
    await db.systemSettings.upsert({
      where: { id: "system" },
      create: { id: "system", profileImagePrompt: prompt },
      update: { profileImagePrompt: prompt },
    }).catch((err) => console.error("[agents/images/theme] prompt default update failed:", err));
  }

  await syncAgents().catch((err) => console.error("[agents/images/theme] syncAgents failed:", err));

  await db.activityLog.create({
    data: {
      userId: session.user.id,
      kind: "agent.profile.image_theme_update",
      targetAgent: agentId,
      payload: JSON.stringify({ theme, customizationMode, gender, ageGroup, ethnicity, username, fullName, bio, savePromptAsDefault: parsed.data.savePromptAsDefault, regenerate: parsed.data.regenerate }),
    },
  }).catch((err) => console.error("[agents/images/theme] activityLog failed:", err));

  let imageRequest: Awaited<ReturnType<typeof queueProfileImageGenerationRequest>> | null = null;
  if (theme !== MANUAL_IMAGE_THEME && parsed.data.stagedImageId) {
    await commitStagedAgentImages({
      agent: agentId,
      stageId: parsed.data.stagedImageId,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.id,
      useProfileAsAvatar: parsed.data.useProfileAsAvatar,
    });
    revalidatePath(`/agents/${agentId}`);
    revalidatePath("/agents");
    imageRequest = { requested: false, reason: "staged_images_committed" };
  } else if (theme !== MANUAL_IMAGE_THEME && parsed.data.useProfileAsAvatar) {
    await linkAvatarToProfile({
      agent: agentId,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.id,
      source: "profile_symlink_requested",
    });
    revalidatePath(`/agents/${agentId}`);
    revalidatePath("/agents");
    imageRequest = { requested: false, reason: "avatar_linked_to_profile" };
  } else if (theme !== MANUAL_IMAGE_THEME && parsed.data.regenerate) {
    imageRequest = await queueProfileImageGenerationRequest({
      newAgentSlug: agentId,
      newAgentName: typeof entry.name === "string" ? entry.name : agentId,
      theme,
      gender,
      ageGroup,
      ethnicity,
      customizationMode,
      prompt,
      username,
      fullName,
      bio,
      requestedByUserId: session.user.id,
      requestedByName: session.user.name ?? session.user.id,
    }).catch((err) => {
      console.error("[agents/images/theme] profile image generation request failed:", err);
      return { requested: false, reason: (err as Error).message };
    });
  }

  return NextResponse.json({
    ok: true,
    theme,
    gender,
    ageGroup,
    ethnicity,
    customizationMode,
    prompt,
    username,
    fullName,
    bio,
    imageRequest,
    state: await readAgentImagesState(agentId),
  });
}
