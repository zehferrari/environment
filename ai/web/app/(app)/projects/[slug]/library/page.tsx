import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteAttachment } from "@/lib/attachments/actions";
import AttachmentList from "@/components/attachment-list";
import {
  accessibleEpicWhere,
  accessibleProjectWhere,
  accessibleTaskWhere,
  requireViewer,
} from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

export default async function ProjectLibraryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const viewer = await requireViewer();
  const { slug } = await params;
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug, deletedAt: null }),
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
        { task: accessibleTaskWhere(viewer, { deletedAt: null }) },
        { epic: accessibleEpicWhere(viewer, { deletedAt: null }) },
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
        <h2 className="text-body font-semibold tracking-wide">
          Library ({attachments.length})
        </h2>
      </div>
      {attachments.length === 0 ? (
        <p className="rounded-card border border-dashed border-line p-6 text-center text-body text-text-muted">
          No attachments anywhere on this project yet.
        </p>
      ) : (
        <AttachmentList
          projectSlug={slug}
          deleteAction={deleteAttachment}
          attachments={attachments.map((a) => {
            const contextLabel = a.task
              ? `Task · ${a.task.title}`
              : a.epic
                ? `Epic · ${a.epic.title}`
                : "Project";
            const contextHref = a.task
              ? `/projects/${slug}/tasks/${a.task.id}`
              : a.epic
                ? `/projects/${slug}/epics/${a.epic.id}`
                : `/projects/${slug}`;
            return {
              ...a,
              contextLabel,
              contextHref,
            };
          })}
        />
      )}
    </section>
  );
}
