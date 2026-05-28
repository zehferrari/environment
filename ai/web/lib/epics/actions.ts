"use server";

// Epic server actions (HOMELAB-47).
//
// Mirrors the Task action conventions: scope every write by the URL
// slug + epic project, call the rule layer (lib/workflow) before
// persisting, write an ActivityLog row per change. The same human-only
// agent-self-set rules apply to Epic.actingManager / Epic.assignee per
// HOMELAB-47 product call — agents can own an Epic by human assignment
// but cannot self-assign.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  checkAssignment,
  checkActingManager,
  type ActorKind,
} from "@/lib/workflow";

const EPIC_STATUSES = ["Backlog", "Open", "Done", "Archive"] as const;
type EpicStatus = (typeof EPIC_STATUSES)[number];

function isEpicStatus(value: unknown): value is EpicStatus {
  return (
    typeof value === "string" &&
    (EPIC_STATUSES as readonly string[]).includes(value)
  );
}

async function requireActor(): Promise<{ id: string; kind: ActorKind }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, kind };
}

async function loadEpicScoped(epicId: string, slug: string) {
  return db.epic.findUnique({
    where: { id: epicId },
    include: {
      project: { select: { id: true, slug: true } },
      assignee: { select: { username: true } },
      actingManager: { select: { username: true } },
      reporter: { select: { username: true } },
    },
  });
}

export async function createEpic(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const actingManagerRaw = String(formData.get("actingManagerId") ?? "");
  const actingManagerId = actingManagerRaw === "" ? null : actingManagerRaw;
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const assigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const branchName = branchRaw === "" ? null : branchRaw;
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const commitPrefix = commitRaw === "" ? null : commitRaw;
  if (!slug || !title) return;
  if (title.length > 200) return;
  if (branchName !== null && branchName.length > 200) return;
  if (commitPrefix !== null && commitPrefix.length > 200) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!project) return;

  // Acting manager picker on the create form follows the same
  // server-side rule as the edit picker — agents can't self-set.
  if (actingManagerId !== null) {
    const check = checkActingManager({
      actor,
      newActingManagerId: actingManagerId,
    });
    if (!check.ok) throw new Error(check.message);
    const target = await db.user.findUnique({
      where: { id: actingManagerId },
      select: { status: true },
    });
    if (!target || target.status !== "active") {
      throw new Error("Acting manager not found or inactive");
    }
  }

  // Assignee picker follows the same rule as the edit picker —
  // agents can't self-assign.
  if (assigneeId !== null) {
    const check = checkAssignment({ actor, newAssigneeId: assigneeId });
    if (!check.ok) throw new Error(check.message);
    const target = await db.user.findUnique({
      where: { id: assigneeId },
      select: { status: true },
    });
    if (!target || target.status !== "active") {
      throw new Error("Assignee not found or inactive");
    }
  }

  const epic = await db.epic.create({
    data: {
      projectId: project.id,
      title,
      description: description || null,
      actingManagerId,
      assigneeId,
      reporterId: actor.id,
      branchName,
      commitPrefix,
      statusChangedAt: new Date(),
    },
    select: { id: true, title: true },
  });

  await db.activityLog.create({
    data: {
      projectId: project.id,
      userId: actor.id,
      kind: "epic.create",
      payload: JSON.stringify({
        epicId: epic.id,
        title: epic.title,
        actingManagerId,
        assigneeId,
        reporterId: actor.id,
        branchName,
        commitPrefix,
      }),
    },
  });

  revalidatePath(`/projects/${slug}/epics`);
  revalidatePath(`/projects/${slug}`);
  // Redirect into the new epic's detail page so attachments + other
  // fields are immediately reachable. redirect() throws a special
  // signal Next consumes — must run after all DB work.
  redirect(`/projects/${slug}/epics/${epic.id}`);
}

export async function renameEpic(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!slug || !epicId || !title) return;
  if (title.length > 200) return;

  const epic = await loadEpicScoped(epicId, slug);
  if (!epic || epic.project.slug !== slug) return;

  const newDescription = description === "" ? null : description;
  if (epic.title === title && (epic.description ?? null) === newDescription) {
    return;
  }

  await db.$transaction([
    db.epic.update({
      where: { id: epicId },
      data: { title, description: newDescription },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.project.id,
        userId: actor.id,
        kind: "epic.update",
        payload: JSON.stringify({
          epicId,
          from: { title: epic.title, description: epic.description },
          to: { title, description: newDescription },
        }),
      },
    }),
  ]);

  try {
    const { deleteDescriptionDraft } = await import("@/lib/description-drafts");
    // Save applied — clear THIS user's draft only.
    await deleteDescriptionDraft({ scope: "epic", targetId: epicId, requesterUserId: actor.id });
  } catch (e) {
    console.error("Failed to delete description draft:", e);
  }

  revalidatePath(`/projects/${slug}/epics`);
  revalidatePath(`/projects/${slug}/epics/${epicId}`);
}

export async function setEpicAssignee(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const raw = String(formData.get("assigneeId") ?? "");
  const newAssigneeId = raw === "" ? null : raw;
  if (!slug || !epicId) return;

  const epic = await loadEpicScoped(epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  if (epic.assigneeId === newAssigneeId) return;

  const check = checkAssignment({ actor, newAssigneeId });
  if (!check.ok) throw new Error(check.message);

  let toUsername: string | null = null;
  if (newAssigneeId !== null) {
    const row = await db.user.findUnique({
      where: { id: newAssigneeId },
      select: { username: true, status: true },
    });
    if (!row || row.status !== "active") {
      throw new Error("Assignee not found or inactive");
    }
    toUsername = row.username;
  }

  await db.$transaction([
    db.epic.update({
      where: { id: epicId },
      data: { assigneeId: newAssigneeId },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.project.id,
        userId: actor.id,
        kind: "epic.assign",
        payload: JSON.stringify({
          epicId,
          from: epic.assignee?.username ?? null,
          to: toUsername,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}/epics`);
}

export async function setEpicActingManager(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const raw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = raw === "" ? null : raw;
  if (!slug || !epicId) return;

  const epic = await loadEpicScoped(epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  if (epic.actingManagerId === newActingManagerId) return;

  const check = checkActingManager({ actor, newActingManagerId });
  if (!check.ok) throw new Error(check.message);

  let toUsername: string | null = null;
  if (newActingManagerId !== null) {
    const row = await db.user.findUnique({
      where: { id: newActingManagerId },
      select: { username: true, status: true },
    });
    if (!row || row.status !== "active") {
      throw new Error("Acting manager not found or inactive");
    }
    toUsername = row.username;
  }

  await db.$transaction([
    db.epic.update({
      where: { id: epicId },
      data: { actingManagerId: newActingManagerId },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.project.id,
        userId: actor.id,
        kind: "epic.acting_manager",
        payload: JSON.stringify({
          epicId,
          from: epic.actingManager?.username ?? null,
          to: toUsername,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}/epics`);
}

// Single epic-form save (mirrors the task form's unified updateTask):
// persists title, description, status, assignee and acting manager in one
// transaction, each keeping the validation its standalone action did
// (epic status enum, no agent self-assign / self-acting-manager). Only
// changed fields are written + activity-logged; a rule violation throws.
export async function updateEpic(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  if (!slug || !epicId) return;

  const title = String(formData.get("title") ?? "").trim();
  if (!title || title.length > 200) return;
  const descriptionRaw = String(formData.get("description") ?? "");
  const newDescription = descriptionRaw.trim() === "" ? null : descriptionRaw;
  const status = String(formData.get("status") ?? "");
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const newAssigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const acmRaw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = acmRaw === "" ? null : acmRaw;
  const reporterRaw = String(formData.get("reporterId") ?? "");
  const newReporterId = reporterRaw === "" ? null : reporterRaw;
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const newBranchName = branchRaw === "" ? null : branchRaw;
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const newCommitPrefix = commitRaw === "" ? null : commitRaw;

  if (status !== "" && !isEpicStatus(status)) return;
  if (newBranchName !== null && newBranchName.length > 200) return;
  if (newCommitPrefix !== null && newCommitPrefix.length > 200) return;

  const epic = await loadEpicScoped(epicId, slug);
  if (!epic || epic.project.slug !== slug) return;

  const data: Prisma.EpicUpdateInput = {};
  const activity: { kind: string; payload: string }[] = [];

  // Title / description
  if (
    epic.title !== title ||
    (epic.description ?? null) !== newDescription
  ) {
    data.title = title;
    data.description = newDescription;
    activity.push({
      kind: "epic.update",
      payload: JSON.stringify({
        epicId,
        from: { title: epic.title, description: epic.description },
        to: { title, description: newDescription },
      }),
    });
  }

  // Status
  const statusChangedAt = new Date();
  const statusChanged = status !== "" && status !== epic.status;
  const taskCascade = statusChanged
    ? status === "Backlog"
      ? "Backlog"
      : status === "Open"
        ? "To Do"
        : null
    : null;
  if (statusChanged) {
    data.status = status;
    data.statusChangedAt = statusChangedAt;
    activity.push({
      kind: "epic.status",
      payload: JSON.stringify({ epicId, from: epic.status, to: status }),
    });
  }

  // Assignee (no agent self-assign; target must be active)
  if (newAssigneeId !== epic.assigneeId) {
    const check = checkAssignment({ actor, newAssigneeId });
    if (!check.ok) throw new Error(check.message);
    let toUsername: string | null = null;
    if (newAssigneeId !== null) {
      const row = await db.user.findUnique({
        where: { id: newAssigneeId },
        select: { username: true, status: true },
      });
      if (!row || row.status !== "active") {
        throw new Error("Assignee not found or inactive");
      }
      toUsername = row.username;
    }
    data.assignee =
      newAssigneeId === null
        ? { disconnect: true }
        : { connect: { id: newAssigneeId } };
    activity.push({
      kind: "epic.assign",
      payload: JSON.stringify({
        epicId,
        from: epic.assignee?.username ?? null,
        to: toUsername,
      }),
    });
  }

  // Acting manager (no agent self-set; target must be active)
  if (newActingManagerId !== epic.actingManagerId) {
    const check = checkActingManager({ actor, newActingManagerId });
    if (!check.ok) throw new Error(check.message);
    let toUsername: string | null = null;
    if (newActingManagerId !== null) {
      const row = await db.user.findUnique({
        where: { id: newActingManagerId },
        select: { username: true, status: true },
      });
      if (!row || row.status !== "active") {
        throw new Error("Acting manager not found or inactive");
      }
      toUsername = row.username;
    }
    data.actingManager =
      newActingManagerId === null
        ? { disconnect: true }
        : { connect: { id: newActingManagerId } };
    activity.push({
      kind: "epic.acting_manager",
      payload: JSON.stringify({
        epicId,
        from: epic.actingManager?.username ?? null,
        to: toUsername,
      }),
    });
  }

  // Reporter (active User/Agent row; defaults to creator on new epics)
  if (newReporterId !== epic.reporterId) {
    let toUsername: string | null = null;
    if (newReporterId !== null) {
      const row = await db.user.findUnique({
        where: { id: newReporterId },
        select: { username: true, status: true },
      });
      if (!row || row.status !== "active") {
        throw new Error("Reporter not found or inactive");
      }
      toUsername = row.username;
    }
    data.reporter =
      newReporterId === null
        ? { disconnect: true }
        : { connect: { id: newReporterId } };
    activity.push({
      kind: "epic.reporter",
      payload: JSON.stringify({
        epicId,
        from: epic.reporter?.username ?? null,
        to: toUsername,
      }),
    });
  }

  // Epic git defaults inherited by child tasks while their own values are blank.
  if ((epic.branchName ?? null) !== newBranchName) {
    data.branchName = newBranchName;
    activity.push({
      kind: "epic.branch",
      payload: JSON.stringify({ from: epic.branchName ?? null, to: newBranchName }),
    });
  }
  if ((epic.commitPrefix ?? null) !== newCommitPrefix) {
    data.commitPrefix = newCommitPrefix;
    activity.push({
      kind: "epic.commit_prefix",
      payload: JSON.stringify({
        from: epic.commitPrefix ?? null,
        to: newCommitPrefix,
      }),
    });
  }

  if (activity.length === 0) return;

  await db.$transaction([
    db.epic.update({ where: { id: epicId }, data }),
    ...(taskCascade
      ? [db.task.updateMany({
          where: { epicId, deletedAt: null, status: { not: "Done" } },
          data: { status: taskCascade, statusChangedAt },
        })]
      : []),
    ...activity.map((a) =>
      db.activityLog.create({
        data: {
          projectId: epic.project.id,
          userId: actor.id,
          kind: a.kind,
          payload: a.payload,
        },
      }),
    ),
  ]);

  try {
    const { deleteDescriptionDraft } = await import("@/lib/description-drafts");
    // Save applied — clear THIS user's draft only.
    await deleteDescriptionDraft({ scope: "epic", targetId: epicId, requesterUserId: actor.id });
  } catch (e) {
    console.error("Failed to delete description draft:", e);
  }

  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}/epics`);
  revalidatePath(`/projects/${slug}`);
}

export async function createTaskInEpic(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  if (!slug || !epicId || !title) return;
  if (title.length > 200) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      projectId: true,
      branchName: true,
      commitPrefix: true,
      deletedAt: true,
      project: {
        select: {
          slug: true,
          defaultAssigneeId: true,
          defaultReviewerId: true,
        },
      },
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) return;

  const maxRank = await db.task.aggregate({
    where: { projectId: epic.projectId, status: "Backlog", deletedAt: null },
    _max: { rank: true },
  });

  const task = await db.task.create({
    data: {
      projectId: epic.projectId,
      epicId: epic.id,
      title,
      description,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      assigneeId: epic.project.defaultAssigneeId ?? null,
      actingManagerId: epic.project.defaultReviewerId ?? null,
      reporterId: actor.id,
      branchName: epic.branchName ?? null,
      commitPrefix: epic.commitPrefix ?? null,
    },
    select: { id: true, title: true },
  });

  await db.activityLog.create({
    data: {
      projectId: epic.projectId,
      taskId: task.id,
      userId: actor.id,
      kind: "task.create",
      payload: JSON.stringify({ title: task.title, epicId: epic.id }),
    },
  });

  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}`);
}

export async function setEpicStatus(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!slug || !epicId || !isEpicStatus(status)) return;

  const epic = await loadEpicScoped(epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  if (epic.status === status) return;

  const statusChangedAt = new Date();
  const taskCascade =
    status === "Backlog"
      ? "Backlog"
      : status === "Open"
        ? "To Do"
        : null;

  await db.$transaction([
    db.epic.update({
      where: { id: epicId },
      data: { status, statusChangedAt },
    }),
    ...(taskCascade
      ? [db.task.updateMany({
          where: { epicId, deletedAt: null, status: { not: "Done" } },
          data: { status: taskCascade, statusChangedAt },
        })]
      : []),
    db.activityLog.create({
      data: {
        projectId: epic.project.id,
        userId: actor.id,
        kind: "epic.status",
        payload: JSON.stringify({
          epicId,
          from: epic.status,
          to: status,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}/epics`);
}

// Epic comments (Comment.epicId, XOR with taskId). Mirrors the task
// comment actions but without agent dispatch — epic comments are notes,
// they don't wake agents.
export async function createEpicComment(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!slug || !epicId || !body) return;
  if (body.length > 8000) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      projectId: true,
      deletedAt: true,
      project: { select: { slug: true } },
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) return;

  await db.$transaction([
    db.comment.create({ data: { epicId, userId: actor.id, body } }),
    db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: actor.id,
        kind: "epic.comment",
        payload: JSON.stringify({ epicId }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/epics/${epicId}`);
}

export async function deleteEpicComment(formData: FormData) {
  const actor = await requireActor();
  // Comment delete is a human-only control (mirrors the task rule).
  if (actor.kind !== "human") return;
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const commentId = String(formData.get("commentId") ?? "");
  if (!slug || !epicId || !commentId) return;

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      epicId: true,
      deletedAt: true,
      epic: { select: { projectId: true, project: { select: { slug: true } } } },
    },
  });
  if (!comment || comment.epicId !== epicId || comment.epic?.project.slug !== slug) {
    return;
  }
  if (comment.deletedAt) return; // already soft-deleted

  // Soft delete (HOMELAB-41 / item 2). Mirrors the task page rule:
  // the row stays so humans see a collapsed dotted divider; agent
  // context filters deletedAt: null so the body never reaches an agent.
  await db.$transaction([
    db.comment.update({
      where: { id: commentId },
      data: { deletedAt: new Date(), deletedById: actor.id },
    }),
    db.activityLog.create({
      data: {
        projectId: comment.epic!.projectId,
        userId: actor.id,
        kind: "epic.comment.delete",
        payload: JSON.stringify({ commentId, epicId, soft: true }),
      },
    }),
  ]);
  revalidatePath(`/projects/${slug}/epics/${epicId}`);
}
