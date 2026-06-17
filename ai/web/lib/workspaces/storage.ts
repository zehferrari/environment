import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOGO_DIR = path.join(process.cwd(), ".data", "workspace-logos");
export const MAX_WORKSPACE_LOGO_BYTES = 2 * 1024 * 1024;
const SAFE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

export function workspaceLogoPath(workspaceId: string, mimeType: string) {
  const ext = SAFE_EXTENSIONS[mimeType];
  if (!ext) throw new Error("Unsupported logo MIME type");
  return path.join(LOGO_DIR, `${workspaceId}.${ext}`);
}

export function workspaceLogoPublicUrl(slug: string, updatedAt?: Date | string | null) {
  const v = updatedAt ? `?v=${encodeURIComponent(new Date(updatedAt).getTime().toString())}` : "";
  return `/api/workspaces/${encodeURIComponent(slug)}/logo${v}`;
}

export async function writeWorkspaceLogo(workspaceId: string, mimeType: string, bytes: Buffer) {
  await mkdir(LOGO_DIR, { recursive: true });
  const filePath = workspaceLogoPath(workspaceId, mimeType);
  await writeFile(filePath, bytes);
  return filePath;
}

export async function deleteWorkspaceLogo(filePath: string | null | undefined) {
  if (!filePath) return;
  await rm(filePath, { force: true });
}

export function validateLogoMimeType(mimeType: string) {
  return Object.prototype.hasOwnProperty.call(SAFE_EXTENSIONS, mimeType);
}

export function normalizeLogoMimeType(mimeType: string | null | undefined, fileName?: string | null) {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (validateLogoMimeType(normalized)) return normalized;

  const ext = fileName?.split(".").pop()?.trim().toLowerCase();
  if (!ext) return "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  return "";
}
