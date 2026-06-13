import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import {
  getOrCreateAgentSessionBinding,
} from "@/lib/agents/session-bindings";
import { sendOrQueueOpenClawPmChannelTurn } from "@/lib/agents/pm-channel-jobs";
import { recordPmChannelRunEvent } from "@/lib/agents/pm-channel-runs";
import { MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/profile-image-themes";

type SelectedGenerator = {
  slug: string;
  gatewayPort: number | null;
  userId: string;
};

function capitalizedAgentFolder(agent: string) {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function modelRefsFromConfig(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const json = config as Record<string, any>;
  const model = json.agents?.defaults?.model;
  const refs = [
    typeof model === "string" ? model : model?.primary,
    ...(Array.isArray(model?.fallbacks) ? model.fallbacks : []),
  ].filter((v): v is string => typeof v === "string");
  const providers = json.models?.providers ?? {};
  if (providers["openai-codex"]) refs.push("openai-codex/provider");
  return refs;
}

async function agentUsesChatGptModel(slug: string): Promise<boolean> {
  try {
    const raw = await readFile(`/srv/agents/openclaw/${slug}/openclaw.json`, "utf8");
    const refs = modelRefsFromConfig(JSON.parse(raw));
    return refs.some((ref) => {
      const text = ref.toLowerCase();
      return text.startsWith("openai-codex/") || text.includes("gpt") || text.includes("chatgpt");
    });
  } catch {
    return false;
  }
}

async function selectImageGenerator(excludeAgent: string): Promise<SelectedGenerator | null> {
  const candidates = await db.agent.findMany({
    where: {
      deactivatedAt: null,
      user: { is: { status: "active" } },
    },
    orderBy: { slug: "asc" },
    select: {
      slug: true,
      gatewayPort: true,
      user: { select: { id: true } },
    },
  });
  const sorted = [
    ...candidates.filter((agent) => agent.slug !== excludeAgent),
    ...candidates.filter((agent) => agent.slug === excludeAgent),
  ];
  for (const candidate of sorted) {
    if (!candidate.user?.id) continue;
    if (await agentUsesChatGptModel(candidate.slug)) {
      return {
        slug: candidate.slug,
        gatewayPort: candidate.gatewayPort,
        userId: candidate.user.id,
      };
    }
  }
  return null;
}

function buildImagePrompt(args: {
  newAgentSlug: string;
  newAgentName: string;
  theme: string;
}) {
  const folder = capitalizedAgentFolder(args.newAgentSlug);
  return [
    `Create profile image assets for the newly provisioned PM agent @${args.newAgentSlug} (${args.newAgentName}).`,
    "",
    `Character theme / inspiration: ${args.theme}`,
    "",
    "Use the existing visual convention in /srv/agents/Pictures as the target:",
    "- profile.png is a square photorealistic portrait/headshot of the character.",
    "- avatar.png is a plush doll version of the same character, matching the profile's face, hair, outfit, and color cues.",
    "",
    "Write exactly these PNG files:",
    `/srv/agents/Pictures/${folder}/profile.png`,
    `/srv/agents/Pictures/${folder}/avatar.png`,
    "",
    "Requirements:",
    "- Use your ChatGPT/OpenAI image-generation capability if available.",
    "- Keep the character original. Use the theme as inspiration, not as a direct copy of a living person, copyrighted character, or trademarked superhero.",
    "- Make both images square, polished, and suitable for agent profile UI.",
    "- Do not change source code, the PM database, or the agent registry.",
    "- If the directory does not exist, create it. If writing fails, reply with the exact error and do not pretend the files were saved.",
    "- Reply in the direct chat with the generated file paths and a one-sentence description of the visual design.",
  ].join("\n");
}

export async function queueProfileImageGenerationRequest(args: {
  newAgentSlug: string;
  newAgentName: string;
  theme: string;
  requestedByUserId: string;
  requestedByName: string;
}) {
  const theme = normalizeProfileImageTheme(args.theme);
  if (theme === MANUAL_IMAGE_THEME) {
    return { requested: false, reason: "manual_upload" };
  }

  const generator = await selectImageGenerator(args.newAgentSlug);
  if (!generator) {
    await db.activityLog.create({
      data: {
        userId: args.requestedByUserId,
        kind: "agent.profile.image_request_failed",
        targetAgent: args.newAgentSlug,
        payload: JSON.stringify({ theme, reason: "no_chatgpt_agent_available" }),
      },
    }).catch(() => undefined);
    return { requested: false, reason: "no_chatgpt_agent_available" };
  }

  const body = buildImagePrompt({
    newAgentSlug: args.newAgentSlug,
    newAgentName: args.newAgentName,
    theme,
  });

  const msg = await db.$transaction(async (tx) => {
    const created = await tx.directAgentChatMessage.create({
      data: {
        agentSlug: generator.slug,
        senderUserId: args.requestedByUserId,
        body,
      },
      select: { id: true },
    });
    await tx.activityLog.create({
      data: {
        userId: args.requestedByUserId,
        kind: "agent.profile.image_request",
        targetAgent: args.newAgentSlug,
        payload: JSON.stringify({
          theme,
          generatorAgent: generator.slug,
          messageId: created.id,
          requestedFor: args.newAgentSlug,
        }),
      },
    });
    return created;
  });

  const sessionBinding = await getOrCreateAgentSessionBinding({
    scopeType: "direct",
    scopeId: msg.id,
    agentSlug: generator.slug,
  });

  const target = { kind: "direct" as const, agentSlug: generator.slug, messageId: msg.id };
  const delivery = await sendOrQueueOpenClawPmChannelTurn({
    gatewayPort: generator.gatewayPort,
    agentSlug: generator.slug,
    sessionKey: sessionBinding.openclawSessionKey,
    kind: "direct",
    text: body,
    contextText: "",
    systemPrompt: [
      "PM internal profile-image generation request.",
      "You are acting on an explicit human-triggered provisioning request.",
      "Complete the requested file outputs if your local tools and permissions allow it.",
      "Reply normally; OpenClaw will deliver your visible response back to the PM direct chat window.",
    ].join("\n"),
    actor: {
      id: args.requestedByUserId,
      username: args.requestedByName,
      kind: "human",
    },
    replyTarget: target,
  });

  if (!delivery.ok) {
    const error = delivery.error ?? `dispatch failed (${delivery.status ?? "unknown"})`;
    await recordPmChannelRunEvent({ target, event: "error", error }).catch(() => undefined);
    await db.activityLog.create({
      data: {
        userId: args.requestedByUserId,
        kind: "agent.profile.image_request_failed",
        targetAgent: args.newAgentSlug,
        payload: JSON.stringify({
          theme,
          generatorAgent: generator.slug,
          messageId: msg.id,
          error,
        }),
      },
    }).catch(() => undefined);
    return { requested: false, reason: error, generatorAgent: generator.slug };
  }

  return { requested: true, generatorAgent: generator.slug, messageId: msg.id };
}
