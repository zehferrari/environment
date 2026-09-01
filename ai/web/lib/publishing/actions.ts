"use server";

// ENV-166 — server actions for the Customer-safe publishing path. Both
// actions re-run the service-layer permission checks (the service is the
// single enforcement point) and then revalidate the task shell, comments
// and attachments cache tags plus the project/task paths, so publish and
// unpublish state propagates immediately across open surfaces.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth/permissions";
import {
  revalidateTaskAttachments,
  revalidateTaskReplyScope,
  revalidateTaskShell,
} from "@/lib/tasks/cache";
import {
  publishInternalItem,
  unpublishPublishedItem,
} from "@/lib/publishing/service";

async function revalidatePublishedSurfaces(projectId: string, taskId: string | null) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { slug: true },
  });
  if (taskId) {
    revalidateTaskShell(taskId);
    revalidateTaskAttachments(taskId);
    revalidateTaskReplyScope(taskId, "comment");
  }
  if (project?.slug) {
    revalidatePath(`/projects/${project.slug}`);
    if (taskId) {
      revalidatePath(`/projects/${project.slug}/tasks/${taskId}`);
    }
  }
}

export async function publishItem(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  const projectId = String(formData.get("projectId") ?? "");
  const taskIdRaw = String(formData.get("taskId") ?? "");
  const taskId = taskIdRaw === "" ? null : taskIdRaw;
  const title = String(formData.get("title") ?? "");
  const body = String(formData.get("body") ?? "");
  const sourceCommentIdRaw = String(formData.get("sourceCommentId") ?? "");
  const sourceCommentId = sourceCommentIdRaw === "" ? null : sourceCommentIdRaw;
  const sourceAttachmentIds = formData
    .getAll("sourceAttachmentIds")
    .map(String)
    .filter((value) => value !== "");

  const result = await publishInternalItem({
    actorUserId: viewer.id,
    projectId,
    taskId,
    title,
    body,
    sourceCommentId,
    sourceAttachmentIds,
  });
  await revalidatePublishedSurfaces(result.projectId, result.taskId);
}

export async function unpublishItem(formData: FormData): Promise<void> {
  const viewer = await requireViewer();
  const publishedItemId = String(formData.get("publishedItemId") ?? "");
  const result = await unpublishPublishedItem({
    actorUserId: viewer.id,
    publishedItemId,
  });
  await revalidatePublishedSurfaces(result.projectId, result.taskId);
}
