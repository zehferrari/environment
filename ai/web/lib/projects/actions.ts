"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { ActorKind } from "@/lib/workflow";
import type { Prisma } from "@prisma/client";
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

const DEPLOYMENT_PROVIDERS = new Set(["bitbucket"]);
const DEPLOYMENT_MODES = new Set(["pr-only", "script", "pipeline", "manual"]);

function deploymentChoice(value: unknown, allowed: Set<string>, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return allowed.has(raw) ? raw : fallback;
}

function branchOrNull(value: unknown): string | null {
  const branch = trimOrNull(value);
  if (!branch) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("Deployment branches may only contain letters, numbers, dot, underscore, slash, and hyphen.");
  }
  return branch;
}

function jsonObjectTextOrNull(value: unknown): string | null {
  const raw = trimOrNull(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return JSON.stringify(parsed, null, 2);
  } catch {
    throw new Error("Integration defaults must be a JSON object.");
  }
}

export async function setProjectSettings(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  if (!slug) return;
  const rawScope = String(formData.get("settingsScope") ?? "all");
  const scope = rawScope === "general" || rawScope === "deployment" ? rawScope : "all";

  const project = await db.project.findUnique({
    where: { slug },
    select: {
      id: true,
      deletedAt: true,
      workItemKeyPrefix: true,
      deploymentProvider: true,
      deploymentProductionBranch: true,
      deploymentPrTargetBranch: true,
      deploymentMode: true,
      deploymentOnMerge: true,
      deploymentPipelineName: true,
      deploymentHost: true,
      deploymentEnvironment: true,
      deploymentBitbucketWorkspace: true,
      deploymentBitbucketRepoSlug: true,
      members: { where: { userId: actor.id }, select: { role: true } },
    },
  });
  if (!project || project.deletedAt) return;

  const actorUser = await db.user.findUnique({ where: { id: actor.id }, select: { username: true } });
  const canEditDeployment =
    actor.kind === "human" ||
    actorUser?.username === "zeh" ||
    project.members.some((member) => member.role === "owner");
  const data: Prisma.ProjectUpdateInput = {};
  const payload: Record<string, unknown> = { scope };
  let slugChanged = false;
  let newSlug = slug;
  let managerAssignableAgentIds: string[] | null = null;

  if (scope === "general" || scope === "all") {
    const name = trimOrNull(formData.get("name"));
    if (!name) throw new Error("Project name is required");

    const parsedSlug = trimOrNull(formData.get("slug"));
    if (!parsedSlug) throw new Error("Project slug is required");
    if (!/^[a-zA-Z0-9\-_]+$/.test(parsedSlug)) {
      throw new Error("Slug must only contain letters, numbers, hyphens, and underscores");
    }

    newSlug = parsedSlug;
    slugChanged = newSlug !== slug;
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
    const onlyReportersCanApprovePullRequests = formData.get("onlyReportersCanApprovePullRequests") === "on";
    const defaultAssigneeId = trimOrNull(formData.get("defaultAssigneeId"));
    const defaultReviewerId = trimOrNull(formData.get("defaultReviewerId"));
    const rawManagerAssignableAgentIds = formData
      .getAll("managerAssignableAgentId")
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    managerAssignableAgentIds = [...new Set(rawManagerAssignableAgentIds)];
    if (managerAssignableAgentIds.length > 0) {
      const validUsers = await db.user.findMany({
        where: {
          id: { in: managerAssignableAgentIds },
          status: "active",
          kind: "agent",
          agent: { is: { role: "coding", deactivatedAt: null } },
        },
        select: { id: true },
      });
      const valid = new Set(validUsers.map((user) => user.id));
      const invalid = managerAssignableAgentIds.filter((id) => !valid.has(id));
      if (invalid.length > 0) {
        throw new Error("Manager assignment pool can only include active coding agents.");
      }
    }
    // Blank automatic archive age inherits the system default (resolved on read).
    const doneTtlDaysRaw = String(formData.get("doneTtlDays") ?? "").trim();
    const doneTtlDays =
      doneTtlDaysRaw === "" ? null : Math.max(1, Math.min(365, Number(doneTtlDaysRaw) || 5));
    const integrationDefaults = jsonObjectTextOrNull(formData.get("integrationDefaults"));

    Object.assign(data, {
      name,
      slug: newSlug,
      repositoryPath,
      defaultGitUserName,
      defaultGitUserEmail,
      workItemKeyPrefix,
      onlyReportersCanApproveActionPlans,
      onlyReportersCanSetTasksDone,
      onlyReportersCanApprovePullRequests,
      defaultAssigneeId,
      defaultReviewerId,
      doneTtlDays,
      integrationDefaults,
    });
    Object.assign(payload, data);
    payload.managerAssignableAgentCount = managerAssignableAgentIds.length;
  }

  if (scope === "deployment" || scope === "all") {
    if (!canEditDeployment) {
      throw new Error("Only project owners can edit deployment settings.");
    }
    const deploymentMode = deploymentChoice(formData.get("deploymentMode"), DEPLOYMENT_MODES, project.deploymentMode);
    const deploymentData = {
      deploymentProvider: deploymentChoice(formData.get("deploymentProvider"), DEPLOYMENT_PROVIDERS, project.deploymentProvider),
      deploymentProductionBranch: branchOrNull(formData.get("deploymentProductionBranch")) ?? "main",
      deploymentPrTargetBranch: branchOrNull(formData.get("deploymentPrTargetBranch")) ?? branchOrNull(formData.get("deploymentProductionBranch")) ?? "main",
      deploymentMode,
      deploymentOnMerge: deploymentMode === "script" ? trimOrNull(formData.get("deploymentOnMerge")) : null,
      deploymentPipelineName: deploymentMode === "pipeline" ? trimOrNull(formData.get("deploymentPipelineName")) : null,
      deploymentHost: trimOrNull(formData.get("deploymentHost")),
      deploymentEnvironment: trimOrNull(formData.get("deploymentEnvironment")),
      deploymentBitbucketWorkspace: trimOrNull(formData.get("deploymentBitbucketWorkspace")),
      deploymentBitbucketRepoSlug: trimOrNull(formData.get("deploymentBitbucketRepoSlug")),
    };
    Object.assign(data, deploymentData);
    payload.deployment = deploymentData;
  }

  await db.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: project.id },
      data,
    });
    if (managerAssignableAgentIds) {
      await tx.projectManagerAssignableAgent.deleteMany({
        where: {
          projectId: project.id,
          userId: { notIn: managerAssignableAgentIds },
        },
      });
      for (const userId of managerAssignableAgentIds) {
        await tx.projectManagerAssignableAgent.upsert({
          where: { projectId_userId: { projectId: project.id, userId } },
          create: { projectId: project.id, userId },
          update: {},
        });
      }
    }
    await tx.activityLog.create({
      data: {
        projectId: project.id,
        userId: actor.id,
        kind: "project.settings",
        payload: JSON.stringify(payload),
      },
    });
  });

  revalidatePath(`/projects`);
  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/settings`);
  if (slugChanged) {
    revalidatePath(`/projects/${newSlug}`);
    revalidatePath(`/projects/${newSlug}/settings`);
    redirect(`/projects/${newSlug}/settings?tab=general`);
  }
}

export async function deleteProject(formData: FormData) {
  const actor = await requireActor();
  if (actor.kind !== "human") throw new Error("Only human users can move projects to the bin");
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

export async function archiveProject(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  if (!slug) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, name: true, archivedAt: true, deletedAt: true },
  });
  if (!project || project.deletedAt || project.archivedAt) return;

  // Archive is project-level only: the board/epics/tasks stay intact, the
  // project just drops out of the active lists until it is unarchived. This
  // is distinct from the 30-day delete bin (which cascades + auto-purges).
  await db.$transaction([
    db.project.update({
      where: { id: project.id },
      data: { archivedAt: new Date() },
    }),
    db.activityLog.create({
      data: {
        projectId: project.id,
        userId: actor.id,
        kind: "project.archive",
        payload: JSON.stringify({ name: project.name }),
      },
    }),
  ]);

  redirect(`/projects/archive`);
}

export async function unarchiveProject(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  if (!slug) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, name: true, archivedAt: true },
  });
  if (!project || !project.archivedAt) return;

  await db.$transaction([
    db.project.update({
      where: { id: project.id },
      data: { archivedAt: null },
    }),
    db.activityLog.create({
      data: {
        projectId: project.id,
        userId: actor.id,
        kind: "project.unarchive",
        payload: JSON.stringify({ name: project.name }),
      },
    }),
  ]);

  revalidatePath(`/projects`);
  revalidatePath(`/projects/archive`);
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
