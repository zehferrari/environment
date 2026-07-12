import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { intEnv } from "@/lib/agents/context/caps";

const AGENT_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const CHAT_FOLDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const DEFAULT_AGENT_SAMBA_ROOT = "/srv/samba/shared/[agent]";

function requireAgentSlug(agentSlug: string) {
  if (!AGENT_SLUG_PATTERN.test(agentSlug)) {
    throw new Error("invalid agent slug");
  }
}

function requireChatFolderId(folderId: string) {
  if (!CHAT_FOLDER_ID_PATTERN.test(folderId)) {
    throw new Error("invalid direct chat folder id");
  }
}

function resolveContainedPath(root: string, folderId: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, folderId);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("direct chat folder escapes the configured chats root");
  }
  return resolvedPath;
}

function getAgentChatsRoot(agentSlug: string) {
  requireAgentSlug(agentSlug);
  const basePattern = process.env.PM_AGENT_SAMBA_ROOT ?? DEFAULT_AGENT_SAMBA_ROOT;
  if (!path.isAbsolute(basePattern) || !basePattern.includes("[agent]")) {
    throw new Error("PM_AGENT_SAMBA_ROOT must be an absolute path containing [agent]");
  }
  return path.resolve(basePattern.replaceAll("[agent]", agentSlug), "chats");
}

export async function getAgentChatUploadDir(agentSlug: string, chatId: string): Promise<string> {
  requireChatFolderId(chatId);
  return resolveContainedPath(getAgentChatsRoot(agentSlug), chatId);
}

export async function getConversationFolderIds(agentSlug: string, baseArchiveId: string | null): Promise<string[]> {
  requireAgentSlug(agentSlug);
  if (baseArchiveId !== null) requireChatFolderId(baseArchiveId);

  const folders: string[] = [];
  let currentId = baseArchiveId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    requireChatFolderId(currentId);
    seen.add(currentId);
    const archive = await db.directAgentChatArchive.findFirst({
      where: { id: currentId, agentSlug, deletedAt: null },
      select: { id: true, parentArchiveId: true },
    });
    if (!archive) break;
    folders.push(archive.id);
    currentId = archive.parentArchiveId;
  }
  return folders;
}

export async function appendFilesContext(agentSlug: string, folderIds: string[]): Promise<string> {
  requireAgentSlug(agentSlug);
  const lines: string[] = [];
  const limit = intEnv("PM_AGENT_CONTEXT_ATTACHMENT_TEXT_MAX_BYTES", 98304, 1024, 512 * 1024);
  let totalBytes = 0;

  for (const folderId of folderIds) {
    const dir = await getAgentChatUploadDir(agentSlug, folderId);
    if (!existsSync(dir)) continue;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        const stats = await stat(filePath);

        lines.push(`- File: ${entry.name} (${stats.size} bytes)`);
        lines.push(`  Path: ${filePath}`);

        const ext = path.extname(entry.name).toLowerCase();
        const isText = [".txt", ".md", ".js", ".ts", ".py", ".json", ".csv", ".yml", ".yaml", ".sh", ".html", ".css"].includes(ext);
        if (isText && stats.size < 50000 && totalBytes + stats.size < limit) {
          try {
            const content = await readFile(filePath, "utf8");
            lines.push("  Content:");
            lines.push("  ```");
            lines.push(content.slice(0, 10000));
            lines.push("  ```");
            totalBytes += stats.size;
          } catch {
            lines.push("  [Error reading content]");
          }
        }
        lines.push("");
      }
    } catch (error) {
      console.error(`Error reading files context for ${dir}`, error);
    }
  }

  if (lines.length === 0) return "";
  return [
    "ATTACHED CONTEXT FILES (accessible in your local environment):",
    ...lines,
    "",
  ].join("\n");
}
