import { readFile } from "node:fs/promises";
import path from "node:path";
import { attachmentAbsolutePath } from "@/lib/attachments/storage";
import { db } from "@/lib/db";

const EXTRACTOR_VERSION = "text-v1";
const DEFAULT_TEXT_MAX_BYTES = 96 * 1024;

export type AttachmentContext = {
  id: string;
  scope: "task" | "epic";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  uploader: { username: string; kind: string };
  downloadPath: string;
  extract: {
    status: "ready" | "unsupported" | "failed";
    text: string | null;
    summary: string | null;
    error: string | null;
    extractorVersion: string;
  };
};

export type AttachmentForContext = {
  id: string;
  filename: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  uploader: { username: string; kind: string };
};

function intEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function maxTextBytes() {
  return intEnv(
    "PM_AGENT_CONTEXT_ATTACHMENT_TEXT_MAX_BYTES",
    DEFAULT_TEXT_MAX_BYTES,
    1024,
    1024 * 1024,
  );
}

function isTextLike(filename: string, mimeType: string) {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (
    [
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/csv",
      "application/javascript",
      "application/typescript",
      "application/x-ndjson",
      "application/sql",
      "application/x-sh",
    ].includes(mime)
  ) {
    return true;
  }

  const ext = path.extname(filename).toLowerCase();
  return [
    ".c",
    ".cc",
    ".conf",
    ".cpp",
    ".cs",
    ".css",
    ".csv",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
  ].includes(ext);
}

function compact(value: string, max: number) {
  const text = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[truncated]`;
}

function summarizeText(value: string) {
  return compact(value.replace(/\s+/g, " "), 1200);
}

function looksBinary(buffer: Buffer) {
  if (buffer.includes(0)) return true;
  const decoded = buffer.toString("utf8");
  if (!decoded) return false;
  const replacements = decoded.match(/\uFFFD/g)?.length ?? 0;
  return replacements / decoded.length > 0.01;
}

async function computeExtract(row: AttachmentForContext) {
  const cap = maxTextBytes();
  if (!isTextLike(row.filename, row.mimeType)) {
    return {
      status: "unsupported" as const,
      text: null,
      summary: null,
      error: `unsupported inline type: ${row.mimeType || "unknown"}`,
    };
  }
  if (row.sizeBytes > cap) {
    return {
      status: "unsupported" as const,
      text: null,
      summary: null,
      error: `text attachment is larger than inline cap (${row.sizeBytes} > ${cap} bytes)`,
    };
  }

  try {
    const bytes = await readFile(attachmentAbsolutePath(row));
    if (looksBinary(bytes)) {
      return {
        status: "unsupported" as const,
        text: null,
        summary: null,
        error: "file appears to be binary or non-UTF-8 text",
      };
    }
    const text = compact(bytes.toString("utf8"), cap);
    if (!text) {
      return {
        status: "unsupported" as const,
        text: null,
        summary: null,
        error: "text attachment is empty",
      };
    }
    return {
      status: "ready" as const,
      text,
      summary: summarizeText(text),
      error: null,
    };
  } catch (err) {
    return {
      status: "failed" as const,
      text: null,
      summary: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getAttachmentContext(
  row: AttachmentForContext,
  scope: "task" | "epic",
): Promise<AttachmentContext> {
  const cached = await db.attachmentExtract.findUnique({
    where: {
      sha256_extractorVersion: {
        sha256: row.sha256,
        extractorVersion: EXTRACTOR_VERSION,
      },
    },
  });
  const computed = cached ? null : await computeExtract(row);
  const extract = cached ?? (await db.attachmentExtract.upsert({
    where: {
      sha256_extractorVersion: {
        sha256: row.sha256,
        extractorVersion: EXTRACTOR_VERSION,
      },
    },
    update: { sourceAttachmentId: row.id },
    create: {
      sourceAttachmentId: row.id,
      sha256: row.sha256,
      extractorVersion: EXTRACTOR_VERSION,
      ...computed!,
    },
  }));

  return {
    id: row.id,
    scope,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    createdAt: row.createdAt,
    uploader: row.uploader,
    downloadPath: `/api/attachments/${row.id}`,
    extract: {
      status: extract.status as "ready" | "unsupported" | "failed",
      text: extract.text,
      summary: extract.summary,
      error: extract.error,
      extractorVersion: extract.extractorVersion,
    },
  };
}
