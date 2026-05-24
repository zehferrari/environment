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
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  checkAssignment,
  checkActingManager,
  type ActorKind,
} from "@/lib/workflow";

const EPIC_STATUSES = ["open", "done", "archived"] as const;
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
  if (!slug || !title) return;
  if (title.length > 200) return;

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

export async function createTaskInEpic(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!slug || !epicId || !title) return;
  if (title.length > 200) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      projectId: true,
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
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      assigneeId: epic.project.defaultAssigneeId ?? null,
      actingManagerId: epic.project.defaultReviewerId ?? null,
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

  await db.$transaction([
    db.epic.update({
      where: { id: epicId },
      data: { status },
    }),
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
