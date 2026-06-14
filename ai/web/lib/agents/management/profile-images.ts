import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { canEditProfile } from "@/lib/agents/management/profile";
import {
  normalizeProfileImageAgeGroup,
  normalizeProfileImageCustomizationMode,
  normalizeProfileImageContextText,
  normalizeProfileImageEthnicity,
  normalizeProfileImageGender,
} from "@/lib/agents/management/profile-image-options";
import { GENERATED_IMAGE_THEME, isManualProfileImageTheme, MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/management/profile-image-themes";

const execFileAsync = promisify(execFile);

const PICTURES_ROOT = "/srv/agents/Pictures";
const STAGING_ROOT = path.join(tmpdir(), "pm-agent-profile-image-staging");
const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const STAGE_RE = /^[a-zA-Z0-9_-]{12,80}$/;
const IMAGE_KINDS = ["profile", "avatar"] as const;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const OUTPUT_SIZE = 256;
const LEGACY_IMAGE_THEME = "Legacy images";

export type AgentImageKind = (typeof IMAGE_KINDS)[number];

export type AgentImageMeta = {
  kind: AgentImageKind;
  exists: boolean;
  bytes: number | null;
  mtimeMs: number | null;
  url: string;
};

export type AgentImagesState = {
  theme: string;
  customizationMode: string;
  gender: string;
  ageGroup: string;
  ethnicity: string;
  prompt: string;
  username: string;
  fullName: string;
  bio: string;
  manual: boolean;
  images: Record<AgentImageKind, AgentImageMeta>;
};

export class AgentImageError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertAgentImageKind(kind: string): asserts kind is AgentImageKind {
  if (!(IMAGE_KINDS as readonly string[]).includes(kind)) {
    throw new AgentImageError(400, "Image kind is not allowlisted");
  }
}

function capitalizedAgentFolder(agent: string) {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

export function agentPicturesDir(agent: string): string {
  if (!AGENT_RE.test(agent)) throw new AgentImageError(400, "Invalid agent id");
  return path.resolve(PICTURES_ROOT, capitalizedAgentFolder(agent));
}

function imageFilename(kind: AgentImageKind) {
  return `${kind}.png`;
}

export function agentImagePath(agent: string, kind: AgentImageKind): string {
  const dir = agentPicturesDir(agent);
  const filePath = path.resolve(dir, imageFilename(kind));
  if (!filePath.startsWith(dir + path.sep)) {
    throw new AgentImageError(400, "Image path escapes picture directory");
  }
  return filePath;
}

function assertStageId(stageId: string) {
  if (!STAGE_RE.test(stageId)) throw new AgentImageError(400, "Invalid staged image id");
}

function stagedAgentImagesDir(agent: string, stageId: string): string {
  if (!AGENT_RE.test(agent)) throw new AgentImageError(400, "Invalid agent id");
  assertStageId(stageId);
  return path.resolve(STAGING_ROOT, agent, stageId);
}

function stagedAgentImagePath(agent: string, stageId: string, kind: AgentImageKind): string {
  const dir = stagedAgentImagesDir(agent, stageId);
  const filePath = path.resolve(dir, imageFilename(kind));
  if (!filePath.startsWith(dir + path.sep)) {
    throw new AgentImageError(400, "Staged image path escapes staging directory");
  }
  return filePath;
}

function imageUrl(agent: string, kind: AgentImageKind, mtimeMs: number | null) {
  const stamp = mtimeMs ? `?v=${Math.floor(mtimeMs)}` : "";
  return `/api/agents/${encodeURIComponent(agent)}/images/${kind}${stamp}`;
}

function stagedImageUrl(agent: string, stageId: string, kind: AgentImageKind, mtimeMs: number | null) {
  const stamp = mtimeMs ? `?v=${Math.floor(mtimeMs)}` : "";
  return `/api/agents/${encodeURIComponent(agent)}/images/staged/${encodeURIComponent(stageId)}/${kind}${stamp}`;
}

function normalizeStoredPrompt(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseProfileImages(rawJson: string | null | undefined): {
  theme: string;
  customizationMode: string;
  gender: string;
  ageGroup: string;
  ethnicity: string;
  prompt: string;
  username: string;
  fullName: string;
  bio: string;
  manual: boolean;
} {
  if (!rawJson) {
    return {
      theme: LEGACY_IMAGE_THEME,
      customizationMode: normalizeProfileImageCustomizationMode(null),
      gender: normalizeProfileImageGender(null),
      ageGroup: normalizeProfileImageAgeGroup(null),
      ethnicity: normalizeProfileImageEthnicity(null),
      prompt: "",
      username: "",
      fullName: "",
      bio: "",
      manual: false,
    };
  }
  try {
    const parsed = JSON.parse(rawJson) as {
      profileImages?: {
        theme?: unknown;
        customizationMode?: unknown;
        gender?: unknown;
        ageGroup?: unknown;
        ethnicity?: unknown;
        prompt?: unknown;
        username?: unknown;
        fullName?: unknown;
        bio?: unknown;
      };
    };
    if (typeof parsed.profileImages?.theme !== "string" || !parsed.profileImages.theme.trim()) {
      return {
        theme: LEGACY_IMAGE_THEME,
        customizationMode: normalizeProfileImageCustomizationMode(parsed.profileImages?.customizationMode),
        gender: normalizeProfileImageGender(parsed.profileImages?.gender),
        ageGroup: normalizeProfileImageAgeGroup(parsed.profileImages?.ageGroup),
        ethnicity: normalizeProfileImageEthnicity(parsed.profileImages?.ethnicity),
        prompt: normalizeStoredPrompt(parsed.profileImages?.prompt),
        username: normalizeProfileImageContextText(parsed.profileImages?.username),
        fullName: normalizeProfileImageContextText(parsed.profileImages?.fullName),
        bio: normalizeProfileImageContextText(parsed.profileImages?.bio, 500),
        manual: false,
      };
    }
    const theme = normalizeProfileImageTheme(parsed.profileImages.theme);
    return {
      theme,
      customizationMode: normalizeProfileImageCustomizationMode(parsed.profileImages.customizationMode),
      gender: normalizeProfileImageGender(parsed.profileImages.gender),
      ageGroup: normalizeProfileImageAgeGroup(parsed.profileImages.ageGroup),
      ethnicity: normalizeProfileImageEthnicity(parsed.profileImages.ethnicity),
      prompt: normalizeStoredPrompt(parsed.profileImages.prompt),
      username: normalizeProfileImageContextText(parsed.profileImages.username),
      fullName: normalizeProfileImageContextText(parsed.profileImages.fullName),
      bio: normalizeProfileImageContextText(parsed.profileImages.bio, 500),
      manual: isManualProfileImageTheme(theme),
    };
  } catch {
    return {
      theme: LEGACY_IMAGE_THEME,
      customizationMode: normalizeProfileImageCustomizationMode(null),
      gender: normalizeProfileImageGender(null),
      ageGroup: normalizeProfileImageAgeGroup(null),
      ethnicity: normalizeProfileImageEthnicity(null),
      prompt: "",
      username: "",
      fullName: "",
      bio: "",
      manual: false,
    };
  }
}

async function assertKnownAgent(agent: string) {
  const row = await db.agent.findUnique({
    where: { slug: agent },
    select: { slug: true, name: true, rawJson: true, deactivatedAt: true },
  });
  if (!row || row.deactivatedAt) throw new AgentImageError(404, "Agent not found");
  return row;
}

export async function readAgentImagesState(agent: string): Promise<AgentImagesState> {
  const row = await assertKnownAgent(agent);
  const profileImages = parseProfileImages(row.rawJson);
  const entries = await Promise.all(
    IMAGE_KINDS.map(async (kind) => {
      const filePath = agentImagePath(agent, kind);
      const st = await stat(filePath).catch(() => null);
      return [
        kind,
        {
          kind,
          exists: Boolean(st?.isFile()),
          bytes: st?.isFile() ? st.size : null,
          mtimeMs: st?.isFile() ? st.mtimeMs : null,
          url: imageUrl(agent, kind, st?.isFile() ? st.mtimeMs : null),
        },
      ] as const;
    }),
  );
  const images = Object.fromEntries(entries) as Record<AgentImageKind, AgentImageMeta>;
  const hasExistingImages = Object.values(images).some((image) => image.exists);
  const inferredTheme =
    profileImages.theme === LEGACY_IMAGE_THEME
      ? hasExistingImages
        ? MANUAL_IMAGE_THEME
        : GENERATED_IMAGE_THEME
      : profileImages.theme;
  const manual = inferredTheme === MANUAL_IMAGE_THEME;
  return {
    theme: inferredTheme,
    customizationMode: profileImages.customizationMode,
    gender: profileImages.gender,
    ageGroup: profileImages.ageGroup,
    ethnicity: profileImages.ethnicity,
    prompt: profileImages.prompt,
    username: profileImages.username || agent,
    fullName: profileImages.fullName || row.name,
    bio: profileImages.bio,
    manual,
    images,
  };
}

export async function assertCanManageManualAgentImages(args: {
  actor: { name?: string | null; kind?: string | null } | undefined;
  agent: string;
}) {
  const allowed = await canEditProfile(args.actor, args.agent);
  if (!allowed) throw new AgentImageError(403, "Forbidden");
  const state = await readAgentImagesState(args.agent);
  if (!state.manual) {
    throw new AgentImageError(403, "Image uploads are enabled only for Manually Uploaded agents");
  }
  return state;
}

export async function readAgentImage(agent: string, kind: AgentImageKind): Promise<{ bytes: Buffer; mtimeMs: number; size: number }> {
  await assertKnownAgent(agent);
  const filePath = agentImagePath(agent, kind);
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) throw new AgentImageError(404, "Image not found");
  return { bytes: await readFile(filePath), mtimeMs: st.mtimeMs, size: st.size };
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resizeUploadToPng(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-agent-image-"));
  const src = path.join(dir, "source");
  const dst = path.join(dir, "image.png");
  try {
    await writeFile(src, input);
    await execFileAsync("/usr/bin/magick", [
      src,
      "-auto-orient",
      "-thumbnail",
      `${OUTPUT_SIZE}x${OUTPUT_SIZE}^`,
      "-gravity",
      "center",
      "-background",
      "none",
      "-extent",
      `${OUTPUT_SIZE}x${OUTPUT_SIZE}`,
      "-strip",
      `PNG32:${dst}`,
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });
    return await readFile(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeAgentImage(args: {
  agent: string;
  kind: AgentImageKind;
  file: File;
  actorUserId: string;
  actorName: string;
}) {
  if (args.file.size <= 0) throw new AgentImageError(400, "Image file is required");
  if (args.file.size > MAX_UPLOAD_BYTES) throw new AgentImageError(413, "Image exceeds 12 MiB limit");
  const input = Buffer.from(await args.file.arrayBuffer());
  const output = await resizeUploadToPng(input).catch((err) => {
    throw new AgentImageError(400, err instanceof Error ? `Image conversion failed: ${err.message}` : "Image conversion failed");
  });
  const dir = agentPicturesDir(args.agent);
  const filePath = agentImagePath(args.agent, args.kind);
  await mkdir(dir, { recursive: true, mode: 0o2775 });
  await access(dir, constants.W_OK).catch(() => {
    throw new AgentImageError(403, "Agent picture directory is not writable by PM process");
  });

  const before = await readFile(filePath).catch(() => null);
  const tmp = path.join(dir, `.${imageFilename(args.kind)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, output, { mode: 0o664 });
  await rename(tmp, filePath).catch(async (err) => {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  });

  const st = await stat(filePath);
  await db.activityLog.create({
    data: {
      userId: args.actorUserId,
      kind: "agent.profile.image_update",
      targetAgent: args.agent,
      targetFile: imageFilename(args.kind),
      payload: JSON.stringify({
        actor: args.actorName,
        agent: args.agent,
        file: imageFilename(args.kind),
        bytesBefore: before?.byteLength ?? 0,
        bytesAfter: output.byteLength,
        shaBefore: before ? sha256(before) : null,
        shaAfter: sha256(output),
      }),
    },
  });

  return {
    kind: args.kind,
    exists: true,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    url: imageUrl(args.agent, args.kind, st.mtimeMs),
  } satisfies AgentImageMeta;
}

export async function writeGeneratedAgentImage(args: {
  agent: string;
  kind: AgentImageKind;
  bytes: Buffer;
}) {
  if (args.bytes.byteLength <= 0) throw new AgentImageError(400, "Generated image is empty");
  const output = await resizeUploadToPng(args.bytes).catch((err) => {
    throw new AgentImageError(400, err instanceof Error ? `Image conversion failed: ${err.message}` : "Image conversion failed");
  });
  const dir = agentPicturesDir(args.agent);
  const filePath = agentImagePath(args.agent, args.kind);
  await mkdir(dir, { recursive: true, mode: 0o2775 });
  await access(dir, constants.W_OK).catch(() => {
    throw new AgentImageError(403, "Agent picture directory is not writable by PM process");
  });

  const tmp = path.join(dir, `.${imageFilename(args.kind)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, output, { mode: 0o664 });
  await rename(tmp, filePath).catch(async (err) => {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  });
  return readAgentImage(args.agent, args.kind);
}

export async function writeStagedGeneratedAgentImage(args: {
  agent: string;
  stageId: string;
  kind: AgentImageKind;
  bytes: Buffer;
}) {
  await assertKnownAgent(args.agent);
  assertStageId(args.stageId);
  if (args.bytes.byteLength <= 0) throw new AgentImageError(400, "Generated image is empty");
  const output = await resizeUploadToPng(args.bytes).catch((err) => {
    throw new AgentImageError(400, err instanceof Error ? `Image conversion failed: ${err.message}` : "Image conversion failed");
  });
  const dir = stagedAgentImagesDir(args.agent, args.stageId);
  const filePath = stagedAgentImagePath(args.agent, args.stageId, args.kind);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${imageFilename(args.kind)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, output, { mode: 0o600 });
  await rename(tmp, filePath).catch(async (err) => {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  });
  return readStagedAgentImage(args.agent, args.stageId, args.kind);
}

export async function readStagedAgentImage(agent: string, stageId: string, kind: AgentImageKind): Promise<{ bytes: Buffer; mtimeMs: number; size: number }> {
  await assertKnownAgent(agent);
  assertStageId(stageId);
  const filePath = stagedAgentImagePath(agent, stageId, kind);
  const st = await stat(filePath).catch(() => null);
  if (!st?.isFile()) throw new AgentImageError(404, "Staged image not found");
  return { bytes: await readFile(filePath), mtimeMs: st.mtimeMs, size: st.size };
}

export async function readStagedAgentImagesState(agent: string, stageId: string): Promise<{ stageId: string; images: Record<AgentImageKind, AgentImageMeta> }> {
  await assertKnownAgent(agent);
  assertStageId(stageId);
  const entries = await Promise.all(
    IMAGE_KINDS.map(async (kind) => {
      const filePath = stagedAgentImagePath(agent, stageId, kind);
      const st = await stat(filePath).catch(() => null);
      return [
        kind,
        {
          kind,
          exists: Boolean(st?.isFile()),
          bytes: st?.isFile() ? st.size : null,
          mtimeMs: st?.isFile() ? st.mtimeMs : null,
          url: stagedImageUrl(agent, stageId, kind, st?.isFile() ? st.mtimeMs : null),
        },
      ] as const;
    }),
  );
  return { stageId, images: Object.fromEntries(entries) as Record<AgentImageKind, AgentImageMeta> };
}

export async function commitStagedAgentImages(args: {
  agent: string;
  stageId: string;
  actorUserId: string;
  actorName: string;
  useProfileAsAvatar?: boolean;
}) {
  await assertKnownAgent(args.agent);
  assertStageId(args.stageId);
  const dir = agentPicturesDir(args.agent);
  await mkdir(dir, { recursive: true, mode: 0o2775 });
  await access(dir, constants.W_OK).catch(() => {
    throw new AgentImageError(403, "Agent picture directory is not writable by PM process");
  });

  const stagedProfile = stagedAgentImagePath(args.agent, args.stageId, "profile");
  const profileOutput = await readFile(stagedProfile).catch(() => null);
  if (!profileOutput) throw new AgentImageError(404, "Staged profile image is not ready");

  const committed: Record<AgentImageKind, AgentImageMeta> = {} as Record<AgentImageKind, AgentImageMeta>;
  for (const kind of IMAGE_KINDS) {
    const staged = stagedAgentImagePath(args.agent, args.stageId, kind);
    const output =
      kind === "profile"
        ? profileOutput
        : args.useProfileAsAvatar
          ? null
          : await readFile(staged).catch(() => null);
    if (!output && kind === "avatar") {
      committed.avatar = await linkAvatarToProfile({
        agent: args.agent,
        actorUserId: args.actorUserId,
        actorName: args.actorName,
        source: args.useProfileAsAvatar ? "staged_profile_generation" : "missing_staged_avatar",
        stageId: args.stageId,
      });
      continue;
    }
    if (!output) throw new AgentImageError(404, `Staged ${kind} image is not ready`);
    const filePath = agentImagePath(args.agent, kind);
    const before = await readFile(filePath).catch(() => null);
    const tmp = path.join(dir, `.${imageFilename(kind)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, output, { mode: 0o664 });
    await rename(tmp, filePath).catch(async (err) => {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    });
    const st = await stat(filePath);
    committed[kind] = {
      kind,
      exists: true,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      url: imageUrl(args.agent, kind, st.mtimeMs),
    };
    await db.activityLog.create({
      data: {
        userId: args.actorUserId,
        kind: "agent.profile.image_update",
        targetAgent: args.agent,
        targetFile: imageFilename(kind),
        payload: JSON.stringify({
          actor: args.actorName,
          agent: args.agent,
          file: imageFilename(kind),
          source: "staged_generation",
          stageId: args.stageId,
          bytesBefore: before?.byteLength ?? 0,
          bytesAfter: output.byteLength,
          shaBefore: before ? sha256(before) : null,
          shaAfter: sha256(output),
        }),
      },
    });
  }
  await rm(stagedAgentImagesDir(args.agent, args.stageId), { recursive: true, force: true }).catch(() => undefined);
  return committed;
}

export async function linkAvatarToProfile(args: {
  agent: string;
  actorUserId: string;
  actorName: string;
  source?: string;
  stageId?: string;
}) {
  await assertKnownAgent(args.agent);
  const dir = agentPicturesDir(args.agent);
  const profilePath = agentImagePath(args.agent, "profile");
  const avatarPath = agentImagePath(args.agent, "avatar");
  const profileStat = await stat(profilePath).catch(() => null);
  if (!profileStat?.isFile()) throw new AgentImageError(404, "Profile image is not ready");
  await access(dir, constants.W_OK).catch(() => {
    throw new AgentImageError(403, "Agent picture directory is not writable by PM process");
  });

  const before = await readFile(avatarPath).catch(() => null);
  await unlink(avatarPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await symlink("profile.png", avatarPath);
  const st = await stat(avatarPath);
  await db.activityLog.create({
    data: {
      userId: args.actorUserId,
      kind: "agent.profile.image_update",
      targetAgent: args.agent,
      targetFile: imageFilename("avatar"),
      payload: JSON.stringify({
        actor: args.actorName,
        agent: args.agent,
        file: imageFilename("avatar"),
        source: args.source ?? "profile_symlink",
        stageId: args.stageId ?? null,
        symlinkTarget: "profile.png",
        bytesBefore: before?.byteLength ?? 0,
        bytesAfter: st.size,
        shaBefore: before ? sha256(before) : null,
        shaAfter: null,
      }),
    },
  });
  return {
    kind: "avatar",
    exists: true,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    url: imageUrl(args.agent, "avatar", st.mtimeMs),
  } satisfies AgentImageMeta;
}

export async function deleteAgentImage(args: {
  agent: string;
  kind: AgentImageKind;
  actorUserId: string;
  actorName: string;
}) {
  const filePath = agentImagePath(args.agent, args.kind);
  const before = await readFile(filePath).catch(() => null);
  await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await db.activityLog.create({
    data: {
      userId: args.actorUserId,
      kind: "agent.profile.image_remove",
      targetAgent: args.agent,
      targetFile: imageFilename(args.kind),
      payload: JSON.stringify({
        actor: args.actorName,
        agent: args.agent,
        file: imageFilename(args.kind),
        bytesBefore: before?.byteLength ?? 0,
        shaBefore: before ? sha256(before) : null,
      }),
    },
  });
  return {
    kind: args.kind,
    exists: false,
    bytes: null,
    mtimeMs: null,
    url: imageUrl(args.agent, args.kind, null),
  } satisfies AgentImageMeta;
}
