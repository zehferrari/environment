import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { canEditProfile } from "@/lib/agents/profile";
import { isManualProfileImageTheme, MANUAL_IMAGE_THEME, normalizeProfileImageTheme } from "@/lib/agents/profile-image-themes";

const execFileAsync = promisify(execFile);

const PICTURES_ROOT = "/srv/agents/Pictures";
const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const IMAGE_KINDS = ["profile", "avatar"] as const;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const OUTPUT_SIZE = 1024;
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

function imageUrl(agent: string, kind: AgentImageKind, mtimeMs: number | null) {
  const stamp = mtimeMs ? `?v=${Math.floor(mtimeMs)}` : "";
  return `/api/agents/${encodeURIComponent(agent)}/images/${kind}${stamp}`;
}

function parseTheme(rawJson: string | null | undefined): { theme: string; manual: boolean } {
  if (!rawJson) return { theme: LEGACY_IMAGE_THEME, manual: false };
  try {
    const parsed = JSON.parse(rawJson) as { profileImages?: { theme?: unknown } };
    if (typeof parsed.profileImages?.theme !== "string" || !parsed.profileImages.theme.trim()) {
      return { theme: LEGACY_IMAGE_THEME, manual: false };
    }
    const theme = normalizeProfileImageTheme(parsed.profileImages.theme);
    return { theme, manual: isManualProfileImageTheme(theme) };
  } catch {
    return { theme: LEGACY_IMAGE_THEME, manual: false };
  }
}

async function assertKnownAgent(agent: string) {
  const row = await db.agent.findUnique({
    where: { slug: agent },
    select: { slug: true, rawJson: true, deactivatedAt: true },
  });
  if (!row || row.deactivatedAt) throw new AgentImageError(404, "Agent not found");
  return row;
}

export async function readAgentImagesState(agent: string): Promise<AgentImagesState> {
  const row = await assertKnownAgent(agent);
  const parsedTheme = parseTheme(row.rawJson);
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
  return {
    theme: parsedTheme.theme,
    manual: parsedTheme.manual,
    images: Object.fromEntries(entries) as Record<AgentImageKind, AgentImageMeta>,
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
