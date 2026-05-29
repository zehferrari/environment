import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

export default async function ProjectLibraryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  if (!project) notFound();

  // All attachments under this project — Attachment.projectId is the
  // direct FK, so a single query covers both task- and epic-anchored
  // files. Filter out attachments whose parent is soft-deleted; they
  // still appear in the bin, not the library.
  const attachments = await db.attachment.findMany({
    where: {
      projectId: project.id,
      OR: [
        { task: { deletedAt: null } },
        { epic: { deletedAt: null } },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: {
      uploader: { select: { username: true } },
      task: { select: { id: true, title: true, deletedAt: true } },
      epic: { select: { id: true, title: true, deletedAt: true } },
    },
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide">
          Library ({attachments.length})
        </h2>
      </div>
      {attachments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-sm text-[var(--color-text-muted)]">
          No attachments anywhere on this project yet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)] rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
          {attachments.map((a) => {
            const parentLabel = a.task
              ? `Task · ${a.task.title}`
              : a.epic
                ? `Epic · ${a.epic.title}`
                : "Project";
            const parentHref = a.task
              ? `/projects/${slug}/tasks/${a.task.id}`
              : a.epic
                ? `/projects/${slug}/epics/${a.epic.id}`
                : `/projects/${slug}`;
            return (
              <li key={a.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <a
                    href={`/api/attachments/${a.id}`}
                    className="truncate font-medium hover:underline"
                  >
                    {a.filename}
                  </a>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {formatBytes(a.sizeBytes)} · {a.mimeType} · uploaded by{" "}
                    @{a.uploader.username} ·{" "}
                    <time
                      dateTime={a.createdAt.toISOString()}
                      title={a.createdAt.toISOString()}
                    >
                      {timeAgo(a.createdAt)}
                    </time>
                  </div>
                </div>
                <Link
                  href={parentHref}
                  className="shrink-0 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                  title={parentLabel}
                >
                  {parentLabel}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
