"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { ActorKind } from "@/lib/workflow";
import { normalizeWorkItemKeyPrefix } from "@/lib/work-items/keys";

async function requireActor(): Promise<{ id: string; kind: ActorKind }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, kind };
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function setProjectSettings(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  if (!slug) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, deletedAt: true, workItemKeyPrefix: true },
  });
  if (!project || project.deletedAt) return;

  const name = trimOrNull(formData.get("name"));
  if (!name) throw new Error("Project name is required");

  const newSlug = trimOrNull(formData.get("slug"));
  if (!newSlug) throw new Error("Project slug is required");
  if (!/^[a-zA-Z0-9\-_]+$/.test(newSlug)) {
    throw new Error("Slug must only contain letters, numbers, hyphens, and underscores");
  }

  const slugChanged = newSlug !== slug;
  if (slugChanged) {
    const existing = await db.project.findUnique({
      where: { slug: newSlug },
      select: { id: true },
    });
    if (existing) {
      throw new Error("Slug is already in use by another project");
    }
  }

  const repositoryPath = trimOrNull(formData.get("repositoryPath"));
  if (!repositoryPath) throw new Error("Repository folder is required");
  const defaultGitUserName = trimOrNull(formData.get("defaultGitUserName"));
  const defaultGitUserEmail = trimOrNull(formData.get("defaultGitUserEmail"));
  const rawWorkItemKeyPrefix = trimOrNull(formData.get("workItemKeyPrefix"));
  if (!rawWorkItemKeyPrefix) {
    throw new Error("Project key is required");
  }
  const workItemKeyPrefix = normalizeWorkItemKeyPrefix(rawWorkItemKeyPrefix);
  if (!workItemKeyPrefix) {
    throw new Error("Project key must start with a letter and contain only 2-10 letters or numbers.");
  }
  if (workItemKeyPrefix && workItemKeyPrefix !== project.workItemKeyPrefix) {
    const existing = await db.project.findUnique({
      where: { workItemKeyPrefix },
      select: { id: true },
    });
    if (existing && existing.id !== project.id) {
      throw new Error("Project key is already in use by another project.");
    }
  }
  const onlyReportersCanApproveActionPlans = formData.get("onlyReportersCanApproveActionPlans") === "on";
  const onlyReportersCanSetTasksDone = formData.get("onlyReportersCanSetTasksDone") === "on";
  const defaultAssigneeId = trimOrNull(formData.get("defaultAssigneeId"));
  const defaultReviewerId = trimOrNull(formData.get("defaultReviewerId"));
  // Blank automatic archive age inherits the system default (resolved on read).
  const doneTtlDaysRaw = String(formData.get("doneTtlDays") ?? "").trim();
  const doneTtlDays =
    doneTtlDaysRaw === "" ? null : Math.max(1, Math.min(365, Number(doneTtlDaysRaw) || 5));

  await db.$transaction([
    db.project.update({
      where: { id: project.id },
      data: {
        name,
        slug: newSlug,
        repositoryPath,
        defaultGitUserName,
        defaultGitUserEmail,
        workItemKeyPrefix,
        onlyReportersCanApproveActionPlans,
        onlyReportersCanSetTasksDone,
        defaultAssigneeId,
        defaultReviewerId,
        doneTtlDays,
      },
    }),
    db.activityLog.create({
      data: {
        projectId: project.id,
        userId: actor.id,
        kind: "project.settings",
        payload: JSON.stringify({
          name,
          slug: newSlug,
          repositoryPath,
          defaultGitUserName,
          defaultGitUserEmail,
          workItemKeyPrefix,
          onlyReportersCanApproveActionPlans,
          onlyReportersCanSetTasksDone,
          defaultAssigneeId,
          defaultReviewerId,
          doneTtlDays,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects`);
  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/settings`);
  if (slugChanged) {
    revalidatePath(`/projects/${newSlug}`);
    revalidatePath(`/projects/${newSlug}/settings`);
    redirect(`/projects/${newSlug}/settings`);
  }
}

export async function deleteProject(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  if (!slug) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!project || project.deletedAt) return;

  const now = new Date();
  // Single timestamp anchors the cascade — same trick as Epic→Task
  // delete in lib/bin/actions.ts. Restoring the project will only
  // re-surface children whose deletedAt matches this exact moment.
  await db.$transaction([
    db.project.update({
      where: { id: project.id },
      data: { deletedAt: now, deletedById: actor.id },
    }),
    db.epic.updateMany({
      where: { projectId: project.id, deletedAt: null },
      data: { deletedAt: now, deletedById: actor.id },
    }),
    db.task.updateMany({
      where: { projectId: project.id, deletedAt: null },
      data: { deletedAt: now, deletedById: actor.id },
    }),
    db.activityLog.create({
      data: {
        projectId: project.id,
        userId: actor.id,
        kind: "project.delete",
        payload: JSON.stringify({ name: project.name }),
      },
    }),
  ]);

  redirect(`/projects/bin`);
}

export async function restoreProject(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  if (!slug) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, deletedAt: true },
  });
  if (!project || !project.deletedAt) return;

  // Restore only the rows that share the project's exact deletedAt
  // (the cascade-batch anchor). Children deleted independently before
  // the project delete stay in the bin.
  await db.$transaction([
    db.project.update({
      where: { id: project.id },
      data: { deletedAt: null, deletedById: null },
    }),
    db.epic.updateMany({
      where: { projectId: project.id, deletedAt: project.deletedAt },
      data: { deletedAt: null, deletedById: null },
    }),
    db.task.updateMany({
      where: { projectId: project.id, deletedAt: project.deletedAt },
      data: { deletedAt: null, deletedById: null },
    }),
    db.activityLog.create({
      data: {
        projectId: project.id,
        userId: actor.id,
        kind: "project.restore",
        payload: null,
      },
    }),
  ]);

  revalidatePath(`/projects`);
  revalidatePath(`/projects/bin`);
  revalidatePath(`/projects/${slug}`);
}

export async function clearDescriptionDraftAction(id: string, scope: "task" | "epic") {
  // Rollback / explicit clear from the description-field UI. Only the
  // current session user can clear their own draft — never another
  // viewer's. If the session can't be resolved, no-op silently.
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  const requesterUserId = session?.user?.id;
  if (!requesterUserId) return;
  const { deleteDescriptionDraft } = await import("@/lib/description-drafts");
  await deleteDescriptionDraft({ scope, targetId: id, requesterUserId });
}
