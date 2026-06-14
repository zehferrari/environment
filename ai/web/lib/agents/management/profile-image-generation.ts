import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  writeGeneratedAgentImage,
  writeStagedGeneratedAgentImage,
  type AgentImageKind,
} from "@/lib/agents/management/profile-images";
import {
  normalizeProfileImageAgeGroup,
  normalizeProfileImageContextText,
  normalizeProfileImageCustomizationMode,
  normalizeProfileImageEthnicity,
  normalizeProfileImageGender,
  normalizeProfileImagePrompt,
} from "@/lib/agents/management/profile-image-options";
import { MANUAL_IMAGE_THEME } from "@/lib/agents/management/profile-image-themes";

const CONFY_BASE_URL = (process.env.PM_PROFILE_IMAGE_CONFY_URL ?? "http://10.0.0.17:8188").replace(/\/+$/, "");
const CONFY_MODEL = process.env.PM_PROFILE_IMAGE_CONFY_MODEL ?? "flux1-dev-fp8.safetensors";
const IMAGE_SIZE = 256;
const STEPS = positiveIntEnv("PM_PROFILE_IMAGE_STEPS", 20);
const PREVIEW_STEPS = positiveIntEnv("PM_PROFILE_IMAGE_PREVIEW_STEPS", 18);
const CFG = 1.0;
const PULID_FLUX_MODEL = process.env.PM_PROFILE_IMAGE_PULID_FLUX_MODEL ?? "pulid_flux_v0.9.1.safetensors";
const PULID_FLUX_WEIGHT = Number(process.env.PM_PROFILE_IMAGE_PULID_FLUX_WEIGHT ?? "1.15");
const POLL_INTERVAL_MS = 1500;
const GENERATION_TIMEOUT_MS = 180_000;

const PROFILE_NEGATIVE_PROMPT = [
  "cartoon, anime, illustration, painting, 3d render, cgi, plastic skin, beauty filter, glamour pose, dramatic",
  "expression, smile too wide, teeth, open mouth, sunglasses, hat, headset, microphone, jewelry, logo, text,",
  "watermark, badge, ID card, lanyard, background clutter, harsh shadows, overexposed, underexposed, blurry, low",
  "resolution, distorted face, asymmetrical eyes, bad anatomy, extra limbs, extra fingers, deformed hands, cropped",
  "head, side profile, looking away, multiple people",
].join(" ");

const AVATAR_NEGATIVE_PROMPT = [
  "different person, changed identity, changed face shape, changed ethnicity, changed age, changed gender presentation,",
  "side profile, looking away, multiple people, full body, half body, torso, arms, hands, fingers, tiny face, cropped head, missing shoulders, harsh shadows,",
  "text, watermark, logo, badge, ID card, lanyard, background clutter, blurry, low resolution, distorted face,",
  "asymmetrical eyes, bad anatomy, extra limbs, extra fingers, deformed hands, plastic skin, cgi render",
].join(" ");

type ComfyImageRef = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type ComfyUploadedImage = {
  name: string;
  subfolder?: string;
  type?: string;
};

function positiveIntEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptTraits(args: {
  customizationMode: string;
  gender: string;
  ageGroup: string;
  ethnicity: string;
  username: string;
  fullName: string;
  bio: string;
}) {
  if (args.customizationMode !== "Custom") return "";
  const traits = [];
  if (args.username) traits.push(`username: ${args.username}`);
  if (args.fullName) traits.push(`full name: ${args.fullName}`);
  if (args.bio) traits.push(`bio: ${args.bio}`);
  if (args.gender !== "Random") traits.push(`must have ${args.gender.toLowerCase()} gender presentation`);
  if (args.ageGroup !== "Random") traits.push(`must look like a ${args.ageGroup.toLowerCase()} person`);
  if (args.ethnicity !== "Random") traits.push(`must have ${args.ethnicity.toLowerCase()} visible ancestry / ethnicity cues`);
  return [
    "Selected visual constraints that must be followed exactly:",
    traits.join(", "),
    "Do not randomize or contradict these selected visual constraints.",
  ].join(" ");
}

function buildPrompt(args: {
  kind: AgentImageKind;
  agentName: string;
  prompt: string;
  customizationMode: string;
  gender: string;
  ageGroup: string;
  ethnicity: string;
  username: string;
  fullName: string;
  bio: string;
}) {
  const traits = promptTraits(args);
  if (args.kind === "avatar") {
    return [
      "close-up plush doll corporate avatar portrait preserving the same fictional AI agent identity from the reference face, centered face, looking directly at camera,",
      "preserve the reference face shape, eye spacing, nose shape, skin tone, hair color, hairline, facial proportions, age cues, and gender presentation,",
      "face and shoulders only, no arms, no hands, no full body, soft fabric texture, subtle stitched seams, button-like realistic eyes, clean light gray studio background,",
      "passport photo composition, high-end corporate badge avatar, polished collectible plush version, symmetrical framing, high quality,",
      traits,
      args.fullName ? `agent full name: ${args.fullName}` : `agent display name: ${args.agentName}`,
    ].join(" ");
  }
  return [
    args.prompt,
    traits,
    args.fullName ? `agent full name: ${args.fullName}` : `agent display name: ${args.agentName}`,
  ].join(" ");
}

function workflow(args: {
  positive: string;
  negative: string;
  seed: number;
  filenamePrefix: string;
  initImage?: ComfyUploadedImage;
  steps?: number;
}) {
  const modelInput = args.initImage ? ["13", 0] : ["1", 0];
  const nodes: Record<string, unknown> = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: CONFY_MODEL },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: args.positive, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: args.negative, clip: ["1", 1] },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: modelInput,
        seed: args.seed,
        steps: args.steps ?? STEPS,
        cfg: CFG,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
        denoise: 1.0,
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: args.filenamePrefix },
    },
  };
  if (args.initImage) {
    const imageName = args.initImage.subfolder ? `${args.initImage.subfolder}/${args.initImage.name}` : args.initImage.name;
    return {
      "4": {
        class_type: "EmptyLatentImage",
        inputs: { width: IMAGE_SIZE, height: IMAGE_SIZE, batch_size: 1 },
      },
      ...nodes,
      "8": {
        class_type: "LoadImage",
        inputs: { image: imageName },
      },
      "10": {
        class_type: "PulidFluxModelLoader",
        inputs: { pulid_file: PULID_FLUX_MODEL },
      },
      "11": {
        class_type: "PulidFluxInsightFaceLoader",
        inputs: { provider: "CUDA" },
      },
      "12": {
        class_type: "PulidFluxEvaClipLoader",
        inputs: {},
      },
      "13": {
        class_type: "ApplyPulidFlux",
        inputs: {
          model: ["1", 0],
          pulid_flux: ["10", 0],
          eva_clip: ["12", 0],
          face_analysis: ["11", 0],
          image: ["8", 0],
          weight: Number.isFinite(PULID_FLUX_WEIGHT) ? PULID_FLUX_WEIGHT : 1.15,
          start_at: 0,
          end_at: 1,
        },
      },
    };
  }
  return {
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: IMAGE_SIZE, height: IMAGE_SIZE, batch_size: 1 },
    },
    ...nodes,
  };
}

async function comfyFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${CONFY_BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Confy ${path} failed (${res.status}): ${body.slice(0, 400)}`);
  }
  return res;
}

async function submitWorkflow(args: { prompt: unknown; clientId: string }): Promise<string> {
  const res = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: args.prompt, client_id: args.clientId }),
  });
  const body = await res.json() as { prompt_id?: unknown; error?: unknown };
  if (typeof body.prompt_id !== "string") {
    throw new Error(`Confy did not return prompt_id: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body.prompt_id;
}

function findGeneratedImage(history: unknown, promptId: string): ComfyImageRef | null {
  const promptHistory = (history as Record<string, any>)[promptId];
  const outputs = promptHistory?.outputs;
  if (!outputs || typeof outputs !== "object") return null;
  for (const output of Object.values(outputs) as any[]) {
    const image = Array.isArray(output?.images) ? output.images[0] : null;
    if (image?.filename) {
      return {
        filename: String(image.filename),
        subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
        type: typeof image.type === "string" ? image.type : "output",
      };
    }
  }
  return null;
}

async function waitForImage(promptId: string): Promise<ComfyImageRef> {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await comfyFetch(`/history/${encodeURIComponent(promptId)}`);
    const body = await res.json();
    const image = findGeneratedImage(body, promptId);
    if (image) return image;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Confy generation timed out after ${Math.round(GENERATION_TIMEOUT_MS / 1000)}s`);
}

async function downloadImage(ref: ComfyImageRef): Promise<Buffer> {
  const params = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output",
  });
  const res = await comfyFetch(`/view?${params.toString()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadInputImage(args: { bytes: Buffer; filename: string }): Promise<ComfyUploadedImage> {
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(args.bytes)], { type: "image/png" }), args.filename);
  form.set("type", "input");
  form.set("overwrite", "true");
  const res = await comfyFetch("/upload/image", { method: "POST", body: form });
  const body = await res.json() as { name?: unknown; subfolder?: unknown; type?: unknown };
  if (typeof body.name !== "string" || !body.name) {
    throw new Error(`Confy upload did not return image name: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return {
    name: body.name,
    subfolder: typeof body.subfolder === "string" ? body.subfolder : "",
    type: typeof body.type === "string" ? body.type : "input",
  };
}

async function generateOne(args: {
  kind: AgentImageKind;
  agentSlug: string;
  agentName: string;
  prompt: string;
  customizationMode: string;
  gender: string;
  ageGroup: string;
  ethnicity: string;
  username: string;
  fullName: string;
  bio: string;
  initImageBytes?: Buffer;
  stageId?: string;
  steps?: number;
}) {
  const clientId = `pm-profile-images-${randomUUID()}`;
  const prompt = buildPrompt(args);
  const negative = args.kind === "avatar" && args.initImageBytes ? AVATAR_NEGATIVE_PROMPT : PROFILE_NEGATIVE_PROMPT;
  const initImage = args.initImageBytes
    ? await uploadInputImage({
        bytes: args.initImageBytes,
        filename: `pm_agent_${args.agentSlug}_${args.kind}_init.png`,
      })
    : undefined;
  const promptId = await submitWorkflow({
    clientId,
    prompt: workflow({
      positive: prompt,
      negative,
      seed: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      filenamePrefix: `pm_agent_${args.agentSlug}_${args.kind}`,
      initImage,
      steps: args.steps,
    }),
  });
  const ref = await waitForImage(promptId);
  const bytes = await downloadImage(ref);
  if (args.stageId) {
    await writeStagedGeneratedAgentImage({ agent: args.agentSlug, stageId: args.stageId, kind: args.kind, bytes });
  } else {
    await writeGeneratedAgentImage({ agent: args.agentSlug, kind: args.kind, bytes });
  }
  return { promptId, filename: ref.filename, bytes };
}

type NormalizedProfileImageRequest = {
  theme: string;
  customizationMode: string;
  prompt: string;
  gender: string;
  ageGroup: string;
  ethnicity: string;
  username: string;
  fullName: string;
  bio: string;
  newAgentSlug: string;
  newAgentName: string;
  requestedByUserId: string;
  stageId?: string;
  steps?: number;
};

async function runProfileImageGeneration(args: NormalizedProfileImageRequest) {
  try {
    const profile = await generateOne({
      kind: "profile",
      agentSlug: args.newAgentSlug,
      agentName: args.newAgentName,
      prompt: args.prompt,
      customizationMode: args.customizationMode,
      gender: args.gender,
      ageGroup: args.ageGroup,
      ethnicity: args.ethnicity,
      username: args.username,
      fullName: args.fullName,
      bio: args.bio,
      stageId: args.stageId,
      steps: args.steps,
    });
    await db.activityLog.create({
      data: {
        userId: args.requestedByUserId,
        kind: "agent.profile.image_request_completed",
        targetAgent: args.newAgentSlug,
        payload: JSON.stringify({
          generator: "confy",
          endpoint: CONFY_BASE_URL,
          promptId: profile.promptId,
          filename: profile.filename,
          kind: "profile",
          stageId: args.stageId ?? null,
          steps: args.steps ?? STEPS,
        }),
      },
    }).catch(() => undefined);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[agents/profile-images] Confy generation failed:", error);
    await db.activityLog.create({
      data: {
        userId: args.requestedByUserId,
        kind: "agent.profile.image_request_failed",
        targetAgent: args.newAgentSlug,
        payload: JSON.stringify({
          imageSource: args.theme,
          customizationMode: args.customizationMode,
          gender: args.gender,
          ageGroup: args.ageGroup,
          ethnicity: args.ethnicity,
          username: args.username,
          fullName: args.fullName,
          bio: args.bio,
          generator: "confy",
          endpoint: CONFY_BASE_URL,
          error,
          stageId: args.stageId ?? null,
          steps: args.steps ?? STEPS,
        }),
      },
    }).catch(() => undefined);
  }
}

async function runPlushImageGeneration(args: NormalizedProfileImageRequest & { sourceProfileBytes: Buffer }) {
  try {
    const avatar = await generateOne({
      kind: "avatar",
      agentSlug: args.newAgentSlug,
      agentName: args.newAgentName,
      prompt: args.prompt,
      customizationMode: args.customizationMode,
      gender: args.gender,
      ageGroup: args.ageGroup,
      ethnicity: args.ethnicity,
      username: args.username,
      fullName: args.fullName,
      bio: args.bio,
      initImageBytes: args.sourceProfileBytes,
      stageId: args.stageId,
      steps: args.steps,
    });
    await db.activityLog.create({
      data: {
        userId: args.requestedByUserId,
        kind: "agent.profile.plush_image_request_completed",
        targetAgent: args.newAgentSlug,
        payload: JSON.stringify({
          generator: "confy",
          endpoint: CONFY_BASE_URL,
          promptId: avatar.promptId,
          filename: avatar.filename,
          avatarUsedProfileReference: true,
          stageId: args.stageId ?? null,
          steps: args.steps ?? STEPS,
        }),
      },
    }).catch(() => undefined);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[agents/profile-images] Confy plush generation failed:", error);
    await db.activityLog.create({
      data: {
        userId: args.requestedByUserId,
        kind: "agent.profile.plush_image_request_failed",
        targetAgent: args.newAgentSlug,
        payload: JSON.stringify({
          imageSource: args.theme,
          customizationMode: args.customizationMode,
          gender: args.gender,
          ageGroup: args.ageGroup,
          ethnicity: args.ethnicity,
          username: args.username,
          fullName: args.fullName,
          bio: args.bio,
          generator: "confy",
          endpoint: CONFY_BASE_URL,
          error,
          stageId: args.stageId ?? null,
          steps: args.steps ?? STEPS,
        }),
      },
    }).catch(() => undefined);
  }
}

export async function queueProfileImageGenerationRequest(args: {
  newAgentSlug: string;
  newAgentName: string;
  theme?: string;
  customizationMode?: string;
  prompt?: string;
  gender?: string;
  ageGroup?: string;
  ethnicity?: string;
  username?: string;
  fullName?: string;
  bio?: string;
  requestedByUserId: string;
  requestedByName: string;
  stageId?: string;
  steps?: number;
}) {
  const theme = args.theme ?? "Generated by Confy";
  const customizationMode = normalizeProfileImageCustomizationMode(args.customizationMode);
  const prompt = normalizeProfileImagePrompt(args.prompt);
  const gender = normalizeProfileImageGender(args.gender);
  const ageGroup = normalizeProfileImageAgeGroup(args.ageGroup);
  const ethnicity = normalizeProfileImageEthnicity(args.ethnicity);
  const username = normalizeProfileImageContextText(args.username) || args.newAgentSlug;
  const fullName = normalizeProfileImageContextText(args.fullName) || args.newAgentName;
  const bio = normalizeProfileImageContextText(args.bio, 500);
  const stageId = args.stageId;
  const steps = args.steps ?? (stageId ? PREVIEW_STEPS : STEPS);
  if (theme === MANUAL_IMAGE_THEME) {
    return { requested: false, reason: "manual_upload" };
  }

  await db.activityLog.create({
    data: {
      userId: args.requestedByUserId,
      kind: "agent.profile.image_request",
      targetAgent: args.newAgentSlug,
      payload: JSON.stringify({
        imageSource: theme,
        customizationMode,
        gender,
        ageGroup,
        ethnicity,
        username,
        fullName,
        bio,
        generator: "confy",
        endpoint: CONFY_BASE_URL,
        model: CONFY_MODEL,
        size: `${IMAGE_SIZE}x${IMAGE_SIZE}`,
        steps,
        stageId: stageId ?? null,
      }),
    },
  }).catch(() => undefined);

  void runProfileImageGeneration({
    theme,
    customizationMode,
    prompt,
    gender,
    ageGroup,
    ethnicity,
    username,
    fullName,
    bio,
    newAgentSlug: args.newAgentSlug,
    newAgentName: args.newAgentName,
    requestedByUserId: args.requestedByUserId,
    stageId,
    steps,
  });

  return { requested: true, completed: false, generatorAgent: "confy", stageId };
}

export async function queuePlushImageGenerationRequest(args: {
  newAgentSlug: string;
  newAgentName: string;
  theme?: string;
  customizationMode?: string;
  prompt?: string;
  gender?: string;
  ageGroup?: string;
  ethnicity?: string;
  username?: string;
  fullName?: string;
  bio?: string;
  requestedByUserId: string;
  requestedByName: string;
  stageId: string;
  sourceProfileBytes: Buffer;
  steps?: number;
}) {
  const theme = args.theme ?? "Generated by Confy";
  const customizationMode = normalizeProfileImageCustomizationMode(args.customizationMode);
  const prompt = normalizeProfileImagePrompt(args.prompt);
  const gender = normalizeProfileImageGender(args.gender);
  const ageGroup = normalizeProfileImageAgeGroup(args.ageGroup);
  const ethnicity = normalizeProfileImageEthnicity(args.ethnicity);
  const username = normalizeProfileImageContextText(args.username) || args.newAgentSlug;
  const fullName = normalizeProfileImageContextText(args.fullName) || args.newAgentName;
  const bio = normalizeProfileImageContextText(args.bio, 500);
  const steps = args.steps ?? PREVIEW_STEPS;
  if (theme === MANUAL_IMAGE_THEME) {
    return { requested: false, reason: "manual_upload" };
  }
  if (args.sourceProfileBytes.byteLength <= 0) {
    return { requested: false, reason: "missing_profile_source" };
  }

  await db.activityLog.create({
    data: {
      userId: args.requestedByUserId,
      kind: "agent.profile.plush_image_request",
      targetAgent: args.newAgentSlug,
      payload: JSON.stringify({
        imageSource: theme,
        customizationMode,
        gender,
        ageGroup,
        ethnicity,
        username,
        fullName,
        bio,
        generator: "confy",
        endpoint: CONFY_BASE_URL,
        model: CONFY_MODEL,
        size: `${IMAGE_SIZE}x${IMAGE_SIZE}`,
        steps,
        stageId: args.stageId,
        source: "photoreal_profile",
      }),
    },
  }).catch(() => undefined);

  void runPlushImageGeneration({
    theme,
    customizationMode,
    prompt,
    gender,
    ageGroup,
    ethnicity,
    username,
    fullName,
    bio,
    newAgentSlug: args.newAgentSlug,
    newAgentName: args.newAgentName,
    requestedByUserId: args.requestedByUserId,
    stageId: args.stageId,
    sourceProfileBytes: args.sourceProfileBytes,
    steps,
  });

  return { requested: true, completed: false, generatorAgent: "confy", stageId: args.stageId, kind: "avatar" as const };
}
