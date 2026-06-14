import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/profile";
import { readAgentIndex } from "@/lib/agents/index-loader";
import { queuePlushImageGenerationRequest, queueProfileImageGenerationRequest } from "@/lib/agents/profile-image-generation";
import {
  AgentImageError,
  readAgentImage,
  readStagedAgentImage,
  readStagedAgentImagesState,
  writeStagedGeneratedAgentImage,
} from "@/lib/agents/profile-images";
import {
  normalizeProfileImageAgeGroup,
  normalizeProfileImageContextText,
  normalizeProfileImageCustomizationMode,
  normalizeProfileImageEthnicity,
  normalizeProfileImageGender,
  normalizeProfileImagePrompt,
} from "@/lib/agents/profile-image-options";
import { MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/profile-image-themes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  theme: z.string().trim().min(1).max(120),
  kind: z.enum(["profile", "avatar"]).optional().default("profile"),
  sourceStageId: z.string().trim().regex(/^[a-zA-Z0-9_-]{12,80}$/).optional(),
  gender: z.string().trim().min(1).max(40).optional().default("Random"),
  ageGroup: z.string().trim().min(1).max(40).optional().default("Random"),
  ethnicity: z.string().trim().min(1).max(40).optional().default("Random"),
  customizationMode: z.string().trim().min(1).max(20).optional().default("Random"),
  prompt: z.string().trim().min(1).max(2000).optional(),
  username: z.string().trim().max(120).optional(),
  fullName: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(500).optional(),
});

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
  if (theme === MANUAL_IMAGE_THEME) return NextResponse.json({ error: "manual_upload" }, { status: 400 });

  const index = await readAgentIndex().catch(() => null);
  const existing = index?.agents.find((agent) => agent.user === agentId) as
    | (NonNullable<typeof index>["agents"][number] & Record<string, unknown>)
    | undefined;
  if (!existing) return NextResponse.json({ error: "agent_not_found" }, { status: 404 });

  const customizationMode = normalizeProfileImageCustomizationMode(parsed.data.customizationMode);
  const gender = normalizeProfileImageGender(parsed.data.gender);
  const ageGroup = normalizeProfileImageAgeGroup(parsed.data.ageGroup);
  const ethnicity = normalizeProfileImageEthnicity(parsed.data.ethnicity);
  const prompt = normalizeProfileImagePrompt(parsed.data.prompt);
  const username = normalizeProfileImageContextText(parsed.data.username) || agentId;
  const fullName = normalizeProfileImageContextText(parsed.data.fullName) || (typeof existing.name === "string" ? existing.name : agentId);
  const bio = normalizeProfileImageContextText(parsed.data.bio, 500);
  const stageId = randomUUID();

  let imageRequest:
    | Awaited<ReturnType<typeof queueProfileImageGenerationRequest>>
    | Awaited<ReturnType<typeof queuePlushImageGenerationRequest>>;
  if (parsed.data.kind === "avatar") {
    let sourceProfile = parsed.data.sourceStageId
      ? await readStagedAgentImage(agentId, parsed.data.sourceStageId, "profile").catch((err) => {
          if (err instanceof AgentImageError && err.status === 404) return null;
          throw err;
        })
      : null;
    sourceProfile ??= await readAgentImage(agentId, "profile").catch((err) => {
      if (err instanceof AgentImageError && err.status === 404) return null;
      throw err;
    });
    if (!sourceProfile) {
      return NextResponse.json({ error: "missing_profile_source", message: "Generate or upload a Profile before creating the Avatar." }, { status: 400 });
    }
    await writeStagedGeneratedAgentImage({
      agent: agentId,
      stageId,
      kind: "profile",
      bytes: sourceProfile.bytes,
    });
    imageRequest = await queuePlushImageGenerationRequest({
      newAgentSlug: agentId,
      newAgentName: typeof existing.name === "string" ? existing.name : agentId,
      theme,
      customizationMode,
      prompt,
      gender,
      ageGroup,
      ethnicity,
      username,
      fullName,
      bio,
      stageId,
      sourceProfileBytes: sourceProfile.bytes,
      requestedByUserId: session.user.id,
      requestedByName: session.user.name ?? session.user.id,
    });
  } else {
    imageRequest = await queueProfileImageGenerationRequest({
      newAgentSlug: agentId,
      newAgentName: typeof existing.name === "string" ? existing.name : agentId,
      theme,
      customizationMode,
      prompt,
      gender,
      ageGroup,
      ethnicity,
      username,
      fullName,
      bio,
      stageId,
      requestedByUserId: session.user.id,
      requestedByName: session.user.name ?? session.user.id,
    });
  }

  return NextResponse.json({
    ok: true,
    stageId,
    imageRequest,
    staged: await readStagedAgentImagesState(agentId, stageId),
  });
}
