import Link from "next/link";
import type { ReactNode } from "react";
import AttachmentRemoveForm from "@/components/attachment-remove-form";
import { normalizeAttachmentMimeType } from "@/lib/attachments/mime";

type AttachmentRow = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date | string;
  uploader: { username: string } | null;
  contextLabel?: string | null;
  contextHref?: string | null;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function timeAgo(value: Date | string): string {
  const d = toDate(value);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function canPreview(mimeType: string) {
  return mimeType.startsWith("image/") ||
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "image/svg+xml";
}

function fileKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return "Text";
  }
  return "File";
}

function AttachmentPreviewTile({
  attachment,
  downloadUrl,
  previewUrl,
}: {
  attachment: AttachmentRow;
  downloadUrl: string;
  previewUrl: string;
}) {
  const mimeType = normalizeAttachmentMimeType(
    attachment.filename,
    attachment.mimeType,
  );
  const previewable = canPreview(mimeType);

  let preview: ReactNode;
  if (mimeType.startsWith("image/")) {
    preview = (
      <img
        src={previewUrl}
        alt={attachment.filename}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
    );
  } else {
    preview = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-[var(--color-panel-soft)] to-[var(--color-bg)] text-[var(--color-text-muted)]">
        <span className="text-xl font-semibold text-[var(--color-text)]">
          {fileKind(mimeType)}
        </span>
        <span className="max-w-full truncate px-2 text-[9px] uppercase tracking-wider">
          {mimeType || "unknown"}
        </span>
      </div>
    );
  }

  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-bg)]">
      {preview}
      <div className="absolute bottom-1 right-1 flex items-center gap-1">
        {previewable ? (
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Preview ${attachment.filename}`}
            title="Preview"
            className="grid h-7 w-7 place-items-center rounded-full border border-white/30 bg-black/55 text-sm font-semibold text-white shadow-sm backdrop-blur hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)]"
          >
            <span aria-hidden="true">↗</span>
          </a>
        ) : null}
        <a
          href={downloadUrl}
          download={attachment.filename}
          aria-label={`Download ${attachment.filename}`}
          title="Download"
          className="grid h-7 w-7 place-items-center rounded-full border border-white/30 bg-black/55 text-sm font-semibold text-white shadow-sm backdrop-blur hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)]"
        >
          <span aria-hidden="true">↓</span>
        </a>
      </div>
    </div>
  );
}

export default function AttachmentList({
  attachments,
  projectSlug,
  deleteAction,
  emptyMessage = "No attachments yet.",
}: {
  attachments: AttachmentRow[];
  projectSlug: string;
  deleteAction: (formData: FormData) => Promise<void>;
  emptyMessage?: string;
}) {
  if (attachments.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-sm text-[var(--color-text-muted)]">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {attachments.map((attachment) => {
        const createdAt = toDate(attachment.createdAt);
        const mimeType = normalizeAttachmentMimeType(
          attachment.filename,
          attachment.mimeType,
        );
        const previewUrl = `/api/attachments/${attachment.id}?inline=1`;
        const downloadUrl = `/api/attachments/${attachment.id}?download=1`;

        return (
          <li
            key={attachment.id}
            className="relative min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-2 text-xs shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--color-accent)]/60 hover:shadow-md"
          >
            <AttachmentRemoveForm
              attachmentId={attachment.id}
              deleteAction={deleteAction}
              filename={attachment.filename}
              projectSlug={projectSlug}
            />

            <AttachmentPreviewTile
              attachment={attachment}
              downloadUrl={downloadUrl}
              previewUrl={previewUrl}
            />

            <div className="mt-2 min-w-0 space-y-1">
              <div
                className="truncate font-medium text-[var(--color-text)]"
                title={attachment.filename}
              >
                {attachment.filename}
              </div>
              <div className="flex min-w-0 items-center justify-between gap-2 text-[10px] text-[var(--color-text-muted)]">
                <span className="truncate">{fileKind(mimeType)}</span>
                <span className="shrink-0">{formatBytes(attachment.sizeBytes)}</span>
              </div>
              <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                @{attachment.uploader?.username ?? "unknown"} ·{" "}
                <time
                  dateTime={createdAt.toISOString()}
                  title={createdAt.toISOString()}
                >
                  {timeAgo(createdAt)}
                </time>
              </div>
              {attachment.contextHref && attachment.contextLabel ? (
                <Link
                  href={attachment.contextHref}
                  className="block truncate text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                  title={attachment.contextLabel}
                >
                  {attachment.contextLabel}
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
