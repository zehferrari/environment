const MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".avi": "video/x-msvideo",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".text": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
};

export function normalizeAttachmentMimeType(
  filename: string,
  suppliedType: string | null | undefined,
): string {
  const supplied = suppliedType?.trim();
  if (supplied && supplied !== "application/octet-stream") return supplied;

  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) {
    const inferred = MIME_BY_EXTENSION[lower.slice(dot)];
    if (inferred) return inferred;
  }

  return supplied || "application/octet-stream";
}
