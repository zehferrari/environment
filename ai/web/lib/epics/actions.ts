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
import { randomUUID } from "crypto";
import { sendAgentChatMessage } from "@/lib/agents/chat/actions";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import {
  checkActingManager,
  type ActorKind,
} from "@/lib/workflow";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { buildDeploymentApproved } from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import { checkDeploymentStatusWrite, isDeploymentStatus } from "@/lib/deploy/deployment-status";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { assignFirstOpenEpicTask } from "@/lib/epics/assignment";

const EPIC_STATUSES = ["Backlog", "Open", "Done"] as const;
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
      workers: { select: { userId: true, user: { select: { username: true } } } },
      actingManager: { select: { username: true } },
      reporter: { select: { username: true } },
    },
  });
}

function getWorkerIds(formData: FormData) {
  return [...new Set(formData.getAll("assigneeId")
    .map((value) => String(value).trim())
    .filter(Boolean))];
}

async function validateEpicWorkerIds(actor: { id: string; kind: ActorKind }, workerIds: string[]) {
  if (workerIds.length === 0) return [];
  if (actor.kind === "agent" && workerIds.includes(actor.id)) {
    throw new Error("Agents cannot add themselves to an Epic worker pool.");
  }
  const rows = await db.user.findMany({
    where: {
      id: { in: workerIds },
      status: "active",
      kind: "agent",
      agent: { is: { role: "coding", deactivatedAt: null } },
    },
    select: { id: true, username: true },
  });
  if (rows.length !== workerIds.length) {
    throw new Error("Epic workers must be active coding agents.");
  }
  const byId = new Map(rows.map((row) => [row.id, row.username]));
  return workerIds.map((id) => ({ id, username: byId.get(id)! }));
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

async function notifyEpicActingManagerAssigned(args: {
  projectSlug: string;
  epicId: string;
  epicTitle: string;
  managerUserId: string | null;
}) {
  if (!args.managerUserId) return;

  const manager = await db.user.findUnique({
    where: { id: args.managerUserId },
    select: {
      kind: true,
      status: true,
      agent: { select: { slug: true, deactivatedAt: true } },
    },
  });
  const managerSlug = manager?.kind === "agent" &&
    manager.status === "active" &&
    manager.agent &&
    !manager.agent.deactivatedAt
      ? manager.agent.slug
      : null;
  if (!managerSlug) return;

  const notify = new FormData();
  notify.set("projectSlug", args.projectSlug);
  notify.set("epicId", args.epicId);
  notify.set("discussionTarget", `agent:${managerSlug}`);
  notify.set("body", [
    `PM workflow notification for @${managerSlug}:`,
    "",
    `You have been assigned as Acting Manager for Epic "${args.epicTitle}".`,
    "Read the Epic description, Action Plan thread, comments, current tasks, and Epic attachment section before replying.",
    "Do not fetch or summarize the whole project library. Use attachments only when the Epic text/comments/action plan explicitly reference them or the plan cannot be made safely without them; say which attachment you used.",
    "If the Epic has no description, use the description endpoint to write a concise description directly from the available Epic/project context. No human Save is required for this empty-description manager write.",
    "If the Epic needs implementation tasks, create the ordered Backlog task breakdown through the Epic manager workflow. Include a concise summary explaining why the tasks are needed.",
    "Creating descriptions/tasks is allowed before Epic approval. Starting the plan is not: only advance the queue or assign workers after a human opens/approves the Epic.",
    "Never change Epic status. When the Epic is opened by a human, assign work only from the Epic worker pool, one task per project per agent, and never assign yourself as task assignee/reporter/acting manager.",
    "Do not post an acknowledgement-only response.",
  ].join("\n"));

  try {
    await sendAgentChatMessage(notify);
  } catch (err) {
    console.error("Failed to notify Epic acting manager assignment:", err);
  }
}

export async function createEpic(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const actingManagerRaw = String(formData.get("actingManagerId") ?? "");
  const actingManagerId = actingManagerRaw === "" ? null : actingManagerRaw;
  const workerIds = getWorkerIds(formData);
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

  const workers = await validateEpicWorkerIds(actor, workerIds);

  const epic = await db.epic.create({
    data: {
      projectId: project.id,
      workItemKey: await allocateWorkItemKey(project.id),
      title,
      description: description || null,
      actingManagerId,
      workers: {
        create: workerIds.map((userId) => ({ userId })),
      },
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
        workerUsernames: workers.map((worker) => worker.username),
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
      data: { actingManagerId: newActingManagerId, approvedOn: null, approvedById: null },
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
    db.activityLog.create({
      data: {
        projectId: epic.project.id,
        userId: actor.id,
        kind: "epic.action_plan.reset",
        payload: JSON.stringify({
          epicId,
          reason: "acting_manager_changed",
          from: epic.actingManager?.username ?? null,
          to: toUsername,
        }),
      },
    }),
  ]);

  await notifyEpicActingManagerAssigned({
    projectSlug: slug,
    epicId,
    epicTitle: epic.title,
    managerUserId: newActingManagerId,
  });

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
  const hasAssigneeField = formData.has("assigneeId") || formData.has("workerPoolSubmitted");
  const workerIds = getWorkerIds(formData);
  const acmRaw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = acmRaw === "" ? null : acmRaw;
  const reporterRaw = String(formData.get("reporterId") ?? "");
  const newReporterId = reporterRaw === "" ? null : reporterRaw;
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const newBranchName = branchRaw === "" ? null : branchRaw;
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const newCommitPrefix = commitRaw === "" ? null : commitRaw;
  const deploymentRaw = String(formData.get("deploymentStatus") ?? "");

  if (status !== "" && !isEpicStatus(status)) return;
  if (deploymentRaw !== "" && !isDeploymentStatus(deploymentRaw)) return;
  if (newBranchName !== null && newBranchName.length > 200) return;
  if (newCommitPrefix !== null && newCommitPrefix.length > 200) return;

  const epic = await loadEpicScoped(epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  const existingWorkerIds = epic.workers.map((worker) => worker.userId);
  const newWorkerIds = hasAssigneeField
    ? workerIds
    : existingWorkerIds;

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

  // Worker pool. Epics can list multiple workers; Task assignee remains single.
  const workerPoolChanged = hasAssigneeField && !sameIds(existingWorkerIds, newWorkerIds);
  let newWorkers: Array<{ id: string; username: string }> = [];
  if (workerPoolChanged) {
    newWorkers = await validateEpicWorkerIds(actor, newWorkerIds);
    data.approvedOn = null;
    data.approvedBy = { disconnect: true };
    activity.push({
      kind: "epic.assign",
      payload: JSON.stringify({
        epicId,
        from: epic.workers.map((worker) => worker.user.username),
        to: newWorkers.map((worker) => worker.username),
        mode: "worker_pool",
      }),
    });
    activity.push({
      kind: "epic.action_plan.reset",
      payload: JSON.stringify({
        epicId,
        reason: "worker_pool_changed",
        from: epic.workers.map((worker) => worker.user.username),
        to: newWorkers.map((worker) => worker.username),
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
    data.approvedOn = null;
    data.approvedBy = { disconnect: true };
    activity.push({
      kind: "epic.acting_manager",
      payload: JSON.stringify({
        epicId,
        from: epic.actingManager?.username ?? null,
        to: toUsername,
      }),
    });
    activity.push({
      kind: "epic.action_plan.reset",
      payload: JSON.stringify({
        epicId,
        reason: "acting_manager_changed",
        from: epic.actingManager?.username ?? null,
        to: toUsername,
      }),
    });
  }

  // Deployment status
  if (deploymentRaw !== "" && deploymentRaw !== epic.deploymentStatus) {
    const actorAgent = actor.kind === "agent"
      ? await db.user.findUnique({ where: { id: actor.id }, select: { agent: { select: { role: true } } } })
      : null;
    const check = checkDeploymentStatusWrite({
      actor,
      actorAgentRole: actorAgent?.agent?.role ?? null,
      from: epic.deploymentStatus,
      to: deploymentRaw,
    });
    if (!check.ok) throw new Error(check.message);
    data.deploymentStatus = deploymentRaw;
    activity.push({
      kind: "epic.deployment_status",
      payload: JSON.stringify({ epicId, from: epic.deploymentStatus, to: deploymentRaw }),
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

  // When an epic moves to Done, archive all of its live child tasks.
  const archiveChildrenOnDone = statusChanged && status === "Done";

  let openAssignment: any = null;
  await db.$transaction(async (tx) => {
    await tx.epic.update({ where: { id: epicId }, data });
    if (workerPoolChanged) {
      await tx.epicWorker.deleteMany({
        where: { epicId, userId: { notIn: newWorkerIds } },
      });
      for (const userId of newWorkerIds) {
        await tx.epicWorker.upsert({
          where: { epicId_userId: { epicId, userId } },
          update: {},
          create: { epicId, userId },
        });
      }
    }
    if (taskCascade) {
      await tx.task.updateMany({
        where: { epicId, archivedAt: null, deletedAt: null, status: { not: "Done" } },
        data: {
          status: taskCascade,
          statusChangedAt,
          ...(status === "Open" ? { assigneeId: null } : {}),
        },
      });
      if (status === "Open") {
        openAssignment = await assignFirstOpenEpicTask(tx, {
          epicId,
          projectId: epic.project.id,
          actorUserId: actor.id,
          excludeUserIds: [newActingManagerId ?? epic.actingManagerId, newReporterId],
          via: "epic_open",
        });
      }
    }
    if (archiveChildrenOnDone) {
      await tx.task.updateMany({
        where: { epicId, archivedAt: null, deletedAt: null },
        data: { archivedAt: statusChangedAt, archivedById: actor.id },
      });
    }
    for (const a of activity) {
      await tx.activityLog.create({
        data: {
          projectId: epic.project.id,
          userId: actor.id,
          kind: a.kind,
          payload: a.payload,
        },
      });
    }
  });

  if (openAssignment?.task && openAssignment.worker) {
    await sendTaskWorkflowNotification({
      taskId: openAssignment.task.id,
      targetUserId: openAssignment.worker.id,
      actor,
      reason: "todo_start_required",
      body: [
        `Epic "${title}" was opened and task "${openAssignment.task.title}" is assigned to you.`,
        "Read the task context and attachments first. Post one concise technical Action Plan and wait for reviewer/manager/reporter approval before starting implementation.",
        "Use task attachments first; only inspect Epic attachments when the task context explicitly references them or is insufficient.",
      ].join("\n"),
    });
  }

  await notifyEpicActingManagerAssigned({
    projectSlug: slug,
    epicId,
    epicTitle: title,
    managerUserId: newActingManagerId !== epic.actingManagerId ? newActingManagerId : null,
  });

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

  if (deploymentRaw === "Deployment Approved" && epic.deploymentStatus !== "Deployment Approved") {
    await notifyDispatch(
      buildDeploymentApproved(
        {
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          actor,
          task: { id: epic.id, key: epic.workItemKey ?? epic.id, projectKey: slug, title },
        },
        { scope: "epic", scopeId: epic.id, deploymentStatus: "Deployment Approved" },
      ),
    );
  }
}

export async function createTaskInEpic(
  _previousState: { ok: boolean; error: string | null },
  formData: FormData,
): Promise<{ ok: boolean; error: string | null }> {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  if (!slug || !epicId || !title) return { ok: false, error: "Task title is required." };
  if (title.length > 200) return { ok: false, error: "Task title must be 200 characters or fewer." };

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      projectId: true,
      branchName: true,
      commitPrefix: true,
      approvedOn: true,
      actingManagerId: true,
      reporterId: true,
      deletedAt: true,
      _count: {
        select: {
          tasks: { where: { deletedAt: null, parentTaskId: null } },
        },
      },
      project: {
        select: {
          slug: true,
          defaultReviewerId: true,
        },
      },
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) {
    return { ok: false, error: "Epic is no longer available." };
  }
  if (actor.kind !== "human" && actor.id !== epic.actingManagerId) {
    return { ok: false, error: "Only the Epic acting manager can create the initial Epic task breakdown." };
  }
  if (actor.kind !== "human" && epic._count.tasks > 0) {
    return { ok: false, error: "Epic tasks can only be created when the Epic has no top-level child tasks yet." };
  }

  const maxRank = await db.task.aggregate({
    where: { projectId: epic.projectId, status: "Backlog", archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });
  const numberedTitle = await nextEpicTaskTitle(epic.id, title);

  const task = await db.task.create({
    data: {
      projectId: epic.projectId,
      workItemKey: await allocateWorkItemKey(epic.projectId),
      epicId: epic.id,
      title: numberedTitle,
      description,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      assigneeId: null,
      actingManagerId: actor.kind === "human" ? epic.project.defaultReviewerId ?? null : null,
      reporterId: actor.kind === "human" ? actor.id : epic.reporterId ?? null,
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
  publishBoardTouch(epic.projectId);
  return { ok: true, error: null };
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

  let openAssignment: any = null;
  await db.$transaction(async (tx) => {
    await tx.epic.update({
      where: { id: epicId },
      data: { status, statusChangedAt },
    });
    if (taskCascade) {
      await tx.task.updateMany({
        where: { epicId, archivedAt: null, deletedAt: null, status: { not: "Done" } },
        data: {
          status: taskCascade,
          statusChangedAt,
          ...(status === "Open" ? { assigneeId: null } : {}),
        },
      });
      if (status === "Open") {
        openAssignment = await assignFirstOpenEpicTask(tx, {
          epicId,
          projectId: epic.project.id,
          actorUserId: actor.id,
          excludeUserIds: [epic.actingManagerId, epic.reporterId],
          via: "epic_status",
        });
      }
    }
    // Moving an epic to Done archives all of its live child tasks.
    if (status === "Done") {
      await tx.task.updateMany({
        where: { epicId, archivedAt: null, deletedAt: null },
        data: { archivedAt: statusChangedAt, archivedById: actor.id },
      });
    }
    await tx.activityLog.create({
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
    });
  });

  if (openAssignment?.task && openAssignment.worker) {
    await sendTaskWorkflowNotification({
      taskId: openAssignment.task.id,
      targetUserId: openAssignment.worker.id,
      actor,
      reason: "todo_start_required",
      body: [
        `Epic "${epic.title}" was opened and task "${openAssignment.task.title}" is assigned to you.`,
        "Read the task context and attachments first. Post one concise technical Action Plan and wait for reviewer/manager/reporter approval before starting implementation.",
        "Use task attachments first; only inspect Epic attachments when the task context explicitly references them or is insufficient.",
      ].join("\n"),
    });
  }

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

// Restore a soft-deleted epic comment (HOMELAB-41 / item 2 follow-up).
// Inverse of deleteEpicComment. Human-only, idempotent.
export async function restoreEpicComment(formData: FormData) {
  const actor = await requireActor();
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
  if (!comment.deletedAt) return; // already restored

  await db.$transaction([
    db.comment.update({
      where: { id: commentId },
      data: { deletedAt: null, deletedById: null },
    }),
    db.activityLog.create({
      data: {
        projectId: comment.epic!.projectId,
        userId: actor.id,
        kind: "epic.comment.restore",
        payload: JSON.stringify({ commentId, epicId }),
      },
    }),
  ]);
  revalidatePath(`/projects/${slug}/epics/${epicId}`);
}
