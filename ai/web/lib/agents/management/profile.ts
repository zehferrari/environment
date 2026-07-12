import { createHash, randomBytes } from "crypto";
import { constants } from "fs";
import { access, copyFile, lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { readAgentIndex } from "@/lib/agents/management/index-loader";

export const PROFILE_FILES = [
  "SOUL.md",
  "MEMORY.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

export type ProfileFileName = (typeof PROFILE_FILES)[number];

export const PROFILE_MAX_BYTES = 256 * 1024;
const BACKUP_KEEP = 20;
const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export type ProfileFilePayload = {
  file: ProfileFileName;
  content: string;
  sha: string;
  bytes: number;
  modifiedAt: string | null;
};

export class ProfileError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertProfileFile(file: string): asserts file is ProfileFileName {
  if (!(PROFILE_FILES as readonly string[]).includes(file)) {
    throw new ProfileError(400, "Profile file is not allowlisted");
  }
}

export async function agentProfileDir(agent: string): Promise<string> {
  if (!AGENT_RE.test(agent)) throw new ProfileError(400, "Invalid agent id");
  const index = await readAgentIndex();
  const row = index.agents.find((a) => a.user === agent && a.enabled !== false);
  if (!row) throw new ProfileError(404, "Agent not found");
  return path.resolve("/srv/agents/openclaw", agent);
}

async function safeProfilePath(agent: string, file: ProfileFileName): Promise<{ profileDir: string; filePath: string }> {
  const profileDir = await agentProfileDir(agent);
  const filePath = path.resolve(profileDir, file);
  if (!filePath.startsWith(profileDir + path.sep)) {
    throw new ProfileError(400, "Profile path escapes profile directory");
  }
  const st = await lstat(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (st?.isSymbolicLink()) throw new ProfileError(400, "Refusing to read or write symlinked profile file");
  return { profileDir, filePath };
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readProfileFile(agent: string, file: ProfileFileName): Promise<ProfileFilePayload> {
  const { filePath } = await safeProfilePath(agent, file);
  const buf = await readFile(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return Buffer.from("");
    throw err;
  });
  if (buf.byteLength > PROFILE_MAX_BYTES) {
    throw new ProfileError(413, "Profile file exceeds 256 KiB limit");
  }
  const st = await stat(filePath).catch(() => null);
  const content = buf.toString("utf8");
  return {
    file,
    content,
    sha: sha256(buf),
    bytes: buf.byteLength,
    modifiedAt: st?.mtime ? st.mtime.toISOString() : null,
  };
}

export async function readAgentProfile(agent: string): Promise<{ agent: string; files: ProfileFilePayload[] }> {
  return { agent, files: await Promise.all(PROFILE_FILES.map((file) => readProfileFile(agent, file))) };
}

export async function canEditProfile(actor: { name?: string | null; kind?: string | null } | undefined, agent: string): Promise<boolean> {
  if (!actor?.name) return false;
  const owner = await db.user.findUnique({
    where: { username: actor.name },
    select: { kind: true, status: true, isOwner: true },
  });
  if (owner?.kind === "human" && owner.status === "active" && owner.isOwner) return true;
  if (actor.kind === "agent" && actor.name === agent) return true;
  return false;
}

function unifiedDiff(oldText: string, newText: string, file: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let changes = 0;
  for (let i = 0; i < max; i += 1) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) continue;
    if (changes === 0) out.push(`@@ line ${i + 1} @@`);
    if (a !== undefined) out.push(`-${a}`);
    if (b !== undefined) out.push(`+${b}`);
    changes += 1;
    if (out.join("\n").length > 12000) {
      out.push("… diff truncated …");
      break;
    }
  }
  return changes === 0 ? "" : out.join("\n");
}

async function rotateBackups(dir: string, file: ProfileFileName) {
  const entries = await readdir(dir).catch(() => []);
  const prefix = `${file}.`;
  const backups = entries.filter((e) => e.startsWith(prefix) && e.endsWith(".bak")).sort().reverse();
  await Promise.all(backups.slice(BACKUP_KEEP).map((entry) => unlink(path.join(dir, entry)).catch(() => undefined)));
}

async function writeFileAtomic(filePath: string, content: string) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const handle = await open(tmp, "wx", 0o664);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, filePath).catch(async (err) => {
    await unlink(tmp).catch(() => undefined);
    throw err;
  });
}

export async function writeProfileFile(input: {
  agent: string;
  file: ProfileFileName;
  content: string;
  expectedSha: string;
  actorUserId: string;
  actorName: string;
}) {
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > PROFILE_MAX_BYTES) throw new ProfileError(413, "Profile content exceeds 256 KiB limit");
  const { profileDir, filePath } = await safeProfilePath(input.agent, input.file);
  await access(profileDir, constants.W_OK).catch(() => {
    throw new ProfileError(403, "Profile directory is not writable by PM process");
  });

  const before = await readProfileFile(input.agent, input.file);
  if (before.sha !== input.expectedSha) {
    throw new ProfileError(412, "Profile file changed since it was loaded");
  }

  const backupDir = path.join(profileDir, ".backups");
  await mkdir(backupDir, { recursive: true, mode: 0o775 });
  const backupPath = path.join(backupDir, `${input.file}.${Date.now()}.bak`);
  await copyFile(filePath, backupPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await writeFileAtomic(filePath, input.content);
  await rotateBackups(backupDir, input.file);

  const afterSha = sha256(input.content);
  const diff = unifiedDiff(before.content, input.content, input.file);
  await db.activityLog.create({
    data: {
      userId: input.actorUserId,
      kind: "agent.profile.update",
      targetAgent: input.agent,
      targetFile: input.file,
      payload: JSON.stringify({
        actor: input.actorName,
        agent: input.agent,
        file: input.file,
        shaBefore: before.sha,
        shaAfter: afterSha,
        bytesBefore: before.bytes,
        bytesAfter: bytes,
        byteDelta: bytes - before.bytes,
        diff: diff.slice(0, 12000),
        diffTruncated: diff.length > 12000,
      }),
    },
  });

  return readProfileFile(input.agent, input.file);
}
