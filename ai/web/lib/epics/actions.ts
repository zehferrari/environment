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
import type { CreateResult } from "@/lib/create/result";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { randomUUID } from "crypto";
import { sendAgentChatMessage } from "@/lib/agents/chat/actions";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import {
  checkActingManager,
} from "@/lib/workflow";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { buildDeploymentApproved } from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import { isPublicEpic } from "@/lib/pm-events/visibility";
import { checkDeploymentStatusWrite, isDeploymentStatus } from "@/lib/deploy/deployment-status";
import { enqueueEpicDoneCleanup } from "@/lib/deploy/epic-merge";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { assignOpenEpicTasks } from "@/lib/epics/assignment";
import { submitEpicChildUpdateInTransaction } from "@/lib/epics/task-workflow-adapter";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { submitWorkflowCommandInTransaction } from "@/lib/tasks/orchestrator";
import type { MoveTaskResult } from "@/lib/tasks/move-status";
import { newTaskWorkflowOwnership } from "@/lib/tasks/orchestrator/ownership";
import { resetEpicActionPlanForDeployReview, triggerDeployReview } from "@/lib/epics/deploy-review";
import { canApplySubmittedEpicStatus } from "@/lib/epics/status-concurrency";
import {
  isTaskWorkflowStatus,
} from "@/lib/tasks/transition-kernel";
import {
  accessibleEpicWhere,
  accessibleTaskWhere,
  assertAgentAssignmentAllowed,
  requireEpicAccess,
  requireProjectAccess,
  requireViewer,
  type Viewer,
} from "@/lib/auth/permissions";

const EPIC_STATUSES = ["Backlog", "To Do", "In Progress", "Review", "Done"] as const;
type EpicStatus = (typeof EPIC_STATUSES)[number];

function isEpicStatus(value: unknown): value is EpicStatus {
  return (
    typeof value === "string" &&
    (EPIC_STATUSES as readonly string[]).includes(value)
  );
}

async function cascadeEpicTasks(
  tx: Prisma.TransactionClient,
  args: {
    actor: Viewer;
    epicId: string;
    projectId: string;
    target: "Backlog" | "To Do";
    source: "epic_update" | "epic_status";
    clearAssignee: boolean;
  },
) {
  const tasks = await tx.task.findMany({
    where: accessibleTaskWhere(args.actor, {
      epicId: args.epicId,
      archivedAt: null,
      deletedAt: null,
      status: { not: "Done" },
    }),
    select: { id: true, status: true, workflowVersion: true, activeWorkflowCycleId: true },
    orderBy: { id: "asc" },
  });
  for (const task of tasks) {
    if (!isTaskWorkflowStatus(task.status)) {
      throw new Error(`Task ${task.id} has unsupported workflow status ${task.status}.`);
    }
    if (task.status === args.target || task.status === "Done") continue;
    await submitEpicChildUpdateInTransaction(tx, {
      taskId: task.id,
      workflowVersion: task.workflowVersion,
      workflowCycleId: task.activeWorkflowCycleId,
      actor: {
        id: args.actor.id,
        kind: args.actor.kind,
        username: args.actor.username,
      },
      source: args.actor.kind === "human" ? "browser" : "agent",
      idempotencyKey: `${args.source}:${args.epicId}:${task.id}:${args.target}:v${task.workflowVersion}`,
      payload: {
        epicId: args.epicId,
        targetStatus: args.target,
        reason: args.source,
        rank: "back",
        clearAssignee: args.clearAssignee,
        clearArchive: true,
        archive: false,
        resetPlanApproval: false,
        comment: null,
        notification: null,
      },
      evidence: { epicId: args.epicId, projectId: args.projectId },
    });
  }
}

async function archiveEpicTasks(
  tx: Prisma.TransactionClient,
  args: { actor: Viewer; epicId: string; source: "epic_update" | "epic_status" },
) {
  const tasks = await tx.task.findMany({
    where: accessibleTaskWhere(args.actor, {
      epicId: args.epicId,
      archivedAt: null,
      deletedAt: null,
    }),
    select: { id: true, status: true, workflowVersion: true, activeWorkflowCycleId: true },
    orderBy: { id: "asc" },
  });
  for (const task of tasks) {
    if (!isTaskWorkflowStatus(task.status)) {
      throw new Error(`Task ${task.id} has unsupported workflow status ${task.status}.`);
    }
    await submitEpicChildUpdateInTransaction(tx, {
      taskId: task.id,
      workflowVersion: task.workflowVersion,
      workflowCycleId: task.activeWorkflowCycleId,
      actor: { id: args.actor.id, kind: args.actor.kind, username: args.actor.username },
      source: args.actor.kind === "human" ? "browser" : "agent",
      idempotencyKey: `${args.source}:archive:${args.epicId}:${task.id}:v${task.workflowVersion}`,
      payload: {
        epicId: args.epicId,
        targetStatus: task.status,
        reason: `${args.source}_done_archive`,
        rank: "back",
        clearAssignee: false,
        clearArchive: false,
        archive: true,
        resetPlanApproval: false,
        comment: null,
        notification: null,
      },
      evidence: { epicId: args.epicId },
    });
  }
}

async function assertEpicTaskCascadeAllowed(
  actor: Viewer,
  where: Prisma.TaskWhereInput,
): Promise<void> {
  if (actor.isOwner || actor.kind === "agent") return;
  const [allCount, visibleCount] = await Promise.all([
    db.task.count({ where }),
    db.task.count({ where: accessibleTaskWhere(actor, where) }),
  ]);
  if (allCount !== visibleCount) throw new Error("Not authorized");
}

async function requireActor(): Promise<Viewer> {
  return requireViewer();
}

class BrowserEpicStatusBatchError extends Error {
  constructor(
    readonly status: "stale" | "invalid" | "forbidden" | "operational",
    message: string,
  ) {
    super(message);
  }
}

/** Atomic bulk status override for the Epic task table. */
export async function overrideEpicTaskStatuses(
  taskIds: string[],
  targetStatus: string,
  slug: string,
  epicId: string,
): Promise<MoveTaskResult> {
  const actor = await requireActor();
  if (actor.kind !== "human") {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Only an authenticated human can override task status from the Epic table.",
    };
  }
  if (!isTaskWorkflowStatus(targetStatus)) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: `Unknown column: ${targetStatus}` };
  }
  const uniqueIds = [...new Set(taskIds)];
  if (uniqueIds.length === 0) return { ok: true };
  if (uniqueIds.length > 100) {
    return { ok: false, code: "EXPLICIT_USER_ACTION_REQUIRED", message: "At most 100 Epic tasks can be updated at once." };
  }
  const epic = await loadEpicScoped(actor, epicId, slug);
  if (!epic) return { ok: false, code: "UNKNOWN_COLUMN", message: "Epic not found" };

  const tasks = await db.task.findMany({
    where: accessibleTaskWhere(actor, {
      id: { in: uniqueIds },
      epicId,
      deletedAt: null,
    }),
    select: { id: true, status: true, workflowVersion: true, activeWorkflowCycleId: true },
    orderBy: { id: "asc" },
  });
  if (tasks.length !== uniqueIds.length) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: "One or more Epic tasks were not found." };
  }

  try {
    await db.$transaction(async (tx) => {
      for (const task of tasks) {
        if (!isTaskWorkflowStatus(task.status)) {
          throw new BrowserEpicStatusBatchError("invalid", `Task ${task.id} has an unsupported workflow status.`);
        }
        if (task.status === targetStatus) continue;
        const result = await submitWorkflowCommandInTransaction(tx, {
          taskId: task.id,
          intent: "override_status",
          actor: { id: actor.id, kind: "human", username: actor.username },
          expectedWorkflowVersion: task.workflowVersion,
          workflowCycleId: task.activeWorkflowCycleId,
          source: "browser",
          idempotencyKey: `epic-table-status:${epicId}:${actor.id}:v${task.workflowVersion}:${targetStatus}`,
          payload: {
            targetStatus,
            reason: `Authenticated human status change from Epic task table ${epicId}.`,
          },
        });
        if (result.status !== "accepted" && result.status !== "replayed") {
          throw new BrowserEpicStatusBatchError(result.status, result.reason);
        }
        await syncEpicOnHumanTaskStatus(tx, {
          epicId,
          projectId: epic.project.id,
          taskId: task.id,
          actorId: actor.id,
          actorKind: "human",
          targetStatus,
          via: "epic-table-status",
        });
      }
    });
  } catch (error) {
    if (error instanceof BrowserEpicStatusBatchError) {
      return {
        ok: false,
        code: error.status === "stale" ? "STALE_VERSION" : "EXPLICIT_USER_ACTION_REQUIRED",
        message: error.status === "stale"
          ? "An Epic task changed while this update was pending. Refresh and try again."
          : error.message,
      };
    }
    throw error;
  }

  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(epic.project.id);
  return { ok: true };
}

async function loadEpicScoped(actor: Viewer, epicId: string, slug: string) {
  return db.epic.findFirst({
    where: accessibleEpicWhere(actor, { id: epicId }),
    include: {
      project: { select: { id: true, slug: true } },
      workers: { select: { userId: true, user: { select: { username: true } } } },
      actingManager: { select: { username: true } },
      deployReviewer: { select: { username: true } },
      reporter: { select: { username: true } },
    },
  });
}

function getWorkerIds(formData: FormData) {
  return [...new Set(formData.getAll("assigneeId")
    .map((value) => String(value).trim())
    .filter(Boolean))];
}

async function validateEpicWorkerIds(actor: Viewer, workerIds: string[]) {
  if (workerIds.length === 0) return [];
  await assertAgentAssignmentAllowed(actor, workerIds);
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

async function validateDeployReviewerId(actor: Viewer, deployReviewerId: string | null) {
  if (deployReviewerId === null) return null;
  await assertAgentAssignmentAllowed(actor, [deployReviewerId]);
  const row = await db.user.findUnique({
    where: { id: deployReviewerId },
    select: {
      username: true,
      status: true,
      kind: true,
      agent: { select: { role: true, deactivatedAt: true } },
    },
  });
  if (
    !row ||
    row.status !== "active" ||
    row.kind !== "agent" ||
    row.agent?.role !== "coding" ||
    row.agent.deactivatedAt !== null
  ) {
    throw new Error("Deploy reviewer must be an active coding agent.");
  }
  return row.username;
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
    "Never change Epic status. When the Epic is moved to In Progress by a human, assign work only from the Epic worker pool, one task per project per agent, and never assign yourself as task assignee/reporter/acting manager.",
    "Do not post an acknowledgement-only response.",
  ].join("\n"));

  try {
    await sendAgentChatMessage(notify);
  } catch (err) {
    console.error("Failed to notify Epic acting manager assignment:", err);
  }
}

export async function createEpic(formData: FormData): Promise<CreateResult> {
  const actor = await requireActor();
  if (!actor.isOwner && (
    formData.has("reporterId") ||
    formData.has("assigneeId") ||
    formData.has("workerPoolSubmitted") ||
    formData.has("actingManagerId") ||
    formData.has("deployReviewerId")
  )) {
    throw new Error("Only the Mission Control owner can set Epic roles.");
  }
  const slug = String(formData.get("projectSlug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const actingManagerRaw = String(formData.get("actingManagerId") ?? "");
  const actingManagerId = actingManagerRaw === "" ? null : actingManagerRaw;
  const deployReviewerRaw = String(formData.get("deployReviewerId") ?? "");
  const deployReviewerId = deployReviewerRaw === "" ? null : deployReviewerRaw;
  const workerIds = getWorkerIds(formData);
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const branchName = branchRaw === "" ? null : branchRaw;
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const commitPrefix = commitRaw === "" ? null : commitRaw;
  if (formData.has("private") && !actor.isOwner) throw new Error("Not authorized");
  const isPrivate = actor.isOwner && formData.get("private") === "on";
  if (!slug || !title) return { ok: false, error: "An Epic title and project are required." };
  if (title.length > 200) return { ok: false, error: "Epic title must be 200 characters or fewer." };
  if (branchName !== null && branchName.length > 200) return { ok: false, error: "Branch name is too long." };
  if (commitPrefix !== null && commitPrefix.length > 200) return { ok: false, error: "Commit prefix is too long." };

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!project) return { ok: false, error: "Project not found." };
  await requireProjectAccess(actor, { id: project.id });

  // Acting manager picker on the create form follows the same
  // server-side rule as the edit picker — agents can't self-set.
  if (actingManagerId !== null) {
    await assertAgentAssignmentAllowed(actor, [actingManagerId]);
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
  await validateDeployReviewerId(actor, deployReviewerId);

  const epic = await db.epic.create({
    data: {
      projectId: project.id,
      workItemKey: await allocateWorkItemKey(project.id),
      title,
      description: description || null,
      private: isPrivate,
      actingManagerId,
      deployReviewerId,
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
  // No redirect: the create FAB stays in place and shows a success toast that
  // links into the new epic.
  return {
    ok: true,
    message: `Epic "${epic.title}" created`,
    href: `/projects/${slug}/epics/${epic.id}`,
  };
}

export async function renameEpic(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!slug || !epicId || !title) return;
  if (title.length > 200) return;

  const epic = await loadEpicScoped(actor, epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: epic.project.id });

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
  if (!actor.isOwner) throw new Error("Only the Mission Control owner can set Epic roles.");
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const raw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = raw === "" ? null : raw;
  if (!slug || !epicId) return;

  const epic = await loadEpicScoped(actor, epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: epic.project.id });
  if (epic.actingManagerId === newActingManagerId) return;

  const check = checkActingManager({ actor, newActingManagerId });
  if (!check.ok) throw new Error(check.message);
  await assertAgentAssignmentAllowed(actor, [epic.actingManagerId, newActingManagerId]);

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
  const submittedStatusRevision = formData.has("statusRevision")
    ? String(formData.get("statusRevision") ?? "")
    : null;
  const hasAssigneeField = formData.has("assigneeId") || formData.has("workerPoolSubmitted");
  const workerIds = getWorkerIds(formData);
  const hasActingManagerField = formData.has("actingManagerId");
  const acmRaw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = acmRaw === "" ? null : acmRaw;
  const hasDeployReviewerField = formData.has("deployReviewerId");
  const deployReviewerRaw = String(formData.get("deployReviewerId") ?? "");
  const newDeployReviewerId = deployReviewerRaw === "" ? null : deployReviewerRaw;
  const hasReporterField = formData.has("reporterId");
  const reporterRaw = String(formData.get("reporterId") ?? "");
  const newReporterId = reporterRaw === "" ? null : reporterRaw;
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const newBranchName = branchRaw === "" ? null : branchRaw;
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const newCommitPrefix = commitRaw === "" ? null : commitRaw;
  const deploymentRaw = String(formData.get("deploymentStatus") ?? "");
  const hasPrivateField = formData.has("privateSubmitted");
  if (!actor.isOwner && (
    hasAssigneeField ||
    hasActingManagerField ||
    hasDeployReviewerField ||
    hasReporterField
  )) {
    throw new Error("Only the Mission Control owner can change Epic roles.");
  }
  if ((hasPrivateField || formData.has("private")) && !actor.isOwner) throw new Error("Not authorized");
  const newPrivate = formData.get("private") === "on";

  if (status !== "" && !isEpicStatus(status)) return;
  if (deploymentRaw !== "" && !isDeploymentStatus(deploymentRaw)) return;
  if (newBranchName !== null && newBranchName.length > 200) return;
  if (newCommitPrefix !== null && newCommitPrefix.length > 200) return;

  const epic = await loadEpicScoped(actor, epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: epic.project.id });
  const existingWorkerIds = epic.workers.map((worker) => worker.userId);
  const newWorkerIds = hasAssigneeField
    ? workerIds
    : existingWorkerIds;

  const data: Prisma.EpicUpdateInput = {};
  const activity: { kind: string; payload: string }[] = [];

  if (hasPrivateField && newPrivate !== epic.private) {
    data.private = newPrivate;
    activity.push({
      kind: "epic.privacy",
      payload: JSON.stringify({ epicId, from: epic.private, to: newPrivate }),
    });
  }

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
  // The Epic editor is a long-lived, uncontrolled form. A plan approval or
  // another tab can change status while the form remains open, so never let
  // an unrelated Save replay its stale status value over the newer workflow
  // state. Other edited fields still save normally.
  const statusSubmissionIsCurrent = canApplySubmittedEpicStatus({
    submittedRevision: submittedStatusRevision,
    currentStatusChangedAt: epic.statusChangedAt,
  });
  const statusChanged = statusSubmissionIsCurrent && status !== "" && status !== epic.status;
  if (statusChanged && status === "Review") {
    throw new Error("Epic Review is entered automatically after every child Task is accepted.");
  }
  if (statusChanged && status === "Done" && epic.completionReviewStatus !== "Approved") {
    const childCount = await db.task.count({
      where: { epicId, parentTaskId: null, deletedAt: null },
    });
    if (childCount > 0) {
      throw new Error("This Epic cannot enter Done until its whole-Epic acceptance review is approved.");
    }
  }
  // To Do and In Progress are both "activated" states: the epic is approved and
  // its child tasks should be To Do (approved to execute) and queued to workers.
  const epicActivated = status === "To Do" || status === "In Progress";
  const taskCascade = statusChanged
    ? status === "Backlog"
      ? "Backlog"
      : epicActivated
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
    if (epic.status === "Review" && status !== "Done") {
      data.completionReviewStatus = "Changes Requested";
      data.completionReviewCompletedAt = statusChangedAt;
      data.completionReviewLastError = null;
    }
  }

  // Worker pool. Epics can list multiple workers; Task assignee remains single.
  const workerPoolChanged = hasAssigneeField && !sameIds(existingWorkerIds, newWorkerIds);
  let newWorkers: Array<{ id: string; username: string }> = [];
  if (workerPoolChanged) {
    await assertAgentAssignmentAllowed(actor, existingWorkerIds);
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
  if (hasActingManagerField && newActingManagerId !== epic.actingManagerId) {
    await assertAgentAssignmentAllowed(actor, [epic.actingManagerId, newActingManagerId]);
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

  // One optional active coding agent owns both mandatory completion acceptance
  // and optional deployment review; each falls back to Monitor when unset.
  if (hasDeployReviewerField && newDeployReviewerId !== epic.deployReviewerId) {
    await assertAgentAssignmentAllowed(actor, [epic.deployReviewerId]);
    const toUsername = await validateDeployReviewerId(actor, newDeployReviewerId);
    data.deployReviewer =
      newDeployReviewerId === null
        ? { disconnect: true }
        : { connect: { id: newDeployReviewerId } };
    activity.push({
      kind: "epic.deploy_reviewer",
      payload: JSON.stringify({
        epicId,
        from: epic.deployReviewer?.username ?? null,
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
  if (hasReporterField && newReporterId !== epic.reporterId) {
    await assertAgentAssignmentAllowed(actor, [epic.reporterId, newReporterId]);
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
  const canTriggerAgents = actor.isOwner || actor.kind === "agent";
  // Deploy-review now hangs off the deployment field, not the workflow status:
  // opting a (Done) epic into deploymentStatus "Ready to Deploy" dispatches the
  // whole-contribution pre-merge review to its Deploy Reviewer (else monitor).
  const shouldStartDeployReview =
    deploymentRaw === "Ready to Deploy" &&
    deploymentRaw !== epic.deploymentStatus &&
    canTriggerAgents;

  if (taskCascade) {
    await assertEpicTaskCascadeAllowed(actor, {
      epicId,
      archivedAt: null,
      deletedAt: null,
      status: { not: "Done" },
    });
  }
  if (archiveChildrenOnDone) {
    await assertEpicTaskCascadeAllowed(actor, {
      epicId,
      archivedAt: null,
      deletedAt: null,
    });
  }

  let openAssignment: any = null;
  await db.$transaction(async (tx) => {
    await tx.epic.update({ where: { id: epicId }, data });
    if (shouldStartDeployReview) {
      await resetEpicActionPlanForDeployReview(tx, {
        projectId: epic.project.id,
        epicId,
        actorId: actor.id,
        now: statusChangedAt,
      });
    }
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
      await cascadeEpicTasks(tx, {
        actor,
        epicId,
        projectId: epic.project.id,
        target: taskCascade,
        source: "epic_update",
        clearAssignee: epicActivated && canTriggerAgents,
      });
      if (epicActivated && canTriggerAgents) {
        openAssignment = await assignOpenEpicTasks(tx, {
          epicId,
          projectId: epic.project.id,
          actorUserId: actor.id,
          excludeUserIds: [newActingManagerId ?? epic.actingManagerId, newReporterId],
          via: "epic_open",
        });
      }
    }
    if (archiveChildrenOnDone) {
      await archiveEpicTasks(tx, {
        actor,
        epicId,
        source: "epic_update",
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

  // Epic moved to Done by a human: queue local child-branch cleanup for the
  // pm-epic-merge-runner (P6). Runs after the transaction; the runner
  // re-verifies the Epic is still Done and that each branch is merged into
  // the pushed Epic branch before deleting anything.
  if (archiveChildrenOnDone) {
    await enqueueEpicDoneCleanup(epicId).catch((err) =>
      console.error("[pm] epic cleanup enqueue failed:", epicId, err),
    );
  }

  for (const assigned of openAssignment?.assignments ?? []) {
    await sendTaskWorkflowNotification({
      taskId: assigned.task.id,
      targetUserId: assigned.worker.id,
      actor,
      reason: "todo_start_required",
      body: [
        `Epic "${title}" is in progress and task "${assigned.task.title}" is assigned to you.`,
        "Read the task context and attachments first. Call action=submit_plan with one concise structured technical Action Plan and wait for reviewer/manager/reporter approval before starting implementation.",
        "Use task attachments first; only inspect Epic attachments when the task context explicitly references them or is insufficient.",
      ].join("\n"),
    });
  }

  if (shouldStartDeployReview) {
    await triggerDeployReview({ projectSlug: slug, epicId, actorId: actor.id });
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
  publishBoardTouch(epic.project.id);

  if (
    canTriggerAgents
    && deploymentRaw === "Deployment Approved"
    && epic.deploymentStatus !== "Deployment Approved"
    && await isPublicEpic(epic.id)
  ) {
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
  if (!actor.isOwner && (
    formData.has("reporterId") ||
    formData.has("assigneeId") ||
    formData.has("actingManagerId") ||
    formData.has("deployReviewerId") ||
    formData.has("workerPoolSubmitted")
  )) {
    return { ok: false, error: "Only the Mission Control owner can set task roles." };
  }
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  if (formData.has("private") && !actor.isOwner) {
    return { ok: false, error: "Only the Mission Control owner can create private tasks." };
  }
  if (!slug || !epicId || !title) return { ok: false, error: "Task title is required." };
  if (title.length > 200) return { ok: false, error: "Task title must be 200 characters or fewer." };

  const epic = await db.epic.findFirst({
    where: accessibleEpicWhere(actor, { id: epicId }),
    select: {
      id: true,
      title: true,
      projectId: true,
      branchName: true,
      commitPrefix: true,
      approvedOn: true,
      actingManagerId: true,
      reporterId: true,
      deletedAt: true,
      private: true,
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
  await requireProjectAccess(actor, { id: epic.projectId });
  if (actor.kind !== "human" && actor.id !== epic.actingManagerId) {
    return { ok: false, error: "Only the Epic acting manager can create the initial Epic task breakdown." };
  }
  if (actor.kind !== "human" && epic._count.tasks > 0) {
    return { ok: false, error: "Epic tasks can only be created when the Epic has no top-level child tasks yet." };
  }

  const defaultReviewer = epic.project.defaultReviewerId
    ? await db.user.findUnique({
        where: { id: epic.project.defaultReviewerId },
        select: { id: true, kind: true },
      })
    : null;
  const defaultReviewerId = defaultReviewer?.kind === "agent" && !actor.isOwner && actor.kind !== "agent"
    ? null
    : defaultReviewer?.id ?? null;

  const task = await db.$transaction(async (tx) => {
    const maxRank = await tx.task.aggregate({
      where: { projectId: epic.projectId, status: "Backlog", archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    const numberedTitle = await nextEpicTaskTitle(epic.id, title, tx);
    const createdTask = await tx.task.create({
      data: {
        ...newTaskWorkflowOwnership(),
        projectId: epic.projectId,
        workItemKey: await allocateWorkItemKey(epic.projectId, tx),
        epicId: epic.id,
        title: numberedTitle,
        description,
        private: actor.isOwner && formData.get("private") === "on",
        status: "Backlog",
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: new Date(),
        assigneeId: null,
        actingManagerId: actor.kind === "human" ? defaultReviewerId : null,
        reporterId: actor.kind === "human" ? actor.id : epic.reporterId ?? null,
        branchName: null,
        commitPrefix: null,
      },
      select: { id: true, title: true },
    });

    await tx.activityLog.create({
      data: {
        projectId: epic.projectId,
        taskId: createdTask.id,
        userId: actor.id,
        kind: "task.create",
        payload: JSON.stringify({ title: createdTask.title, epicId: epic.id }),
      },
    });
    return createdTask;
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

  const epic = await loadEpicScoped(actor, epicId, slug);
  if (!epic || epic.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: epic.project.id });
  if (epic.status === status) return;

  if (status === "Review") {
    throw new Error("Epic Review is entered automatically after every child Task is accepted.");
  }
  if (status === "Done" && epic.completionReviewStatus !== "Approved") {
    const childCount = await db.task.count({
      where: { epicId, parentTaskId: null, deletedAt: null },
    });
    if (childCount > 0) {
      throw new Error("This Epic cannot enter Done until its whole-Epic acceptance review is approved.");
    }
  }

  const statusChangedAt = new Date();
  const epicActivated = status === "To Do" || status === "In Progress";
  const taskCascade =
    status === "Backlog"
      ? "Backlog"
      : epicActivated
        ? "To Do"
        : null;

  if (taskCascade) {
    await assertEpicTaskCascadeAllowed(actor, {
      epicId,
      archivedAt: null,
      deletedAt: null,
      status: { not: "Done" },
    });
  }
  if (status === "Done") {
    await assertEpicTaskCascadeAllowed(actor, {
      epicId,
      archivedAt: null,
      deletedAt: null,
    });
  }

  let openAssignment: any = null;
  await db.$transaction(async (tx) => {
    await tx.epic.update({
      where: { id: epicId },
      data: {
        status,
        statusChangedAt,
        ...(epic.status === "Review" && status !== "Done"
          ? { completionReviewStatus: "Changes Requested", completionReviewCompletedAt: statusChangedAt, completionReviewLastError: null }
          : {}),
      },
    });
    if (taskCascade) {
      await cascadeEpicTasks(tx, {
        actor,
        epicId,
        projectId: epic.project.id,
        target: taskCascade,
        source: "epic_status",
        clearAssignee: epicActivated && (actor.isOwner || actor.kind === "agent"),
      });
      if (epicActivated && (actor.isOwner || actor.kind === "agent")) {
        openAssignment = await assignOpenEpicTasks(tx, {
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
      await archiveEpicTasks(tx, {
        actor,
        epicId,
        source: "epic_status",
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

  // Same epic-Done cleanup hook as updateEpic (P6 local branch removal).
  if (status === "Done") {
    await enqueueEpicDoneCleanup(epicId).catch((err) =>
      console.error("[pm] epic cleanup enqueue failed:", epicId, err),
    );
  }

  for (const assigned of openAssignment?.assignments ?? []) {
    await sendTaskWorkflowNotification({
      taskId: assigned.task.id,
      targetUserId: assigned.worker.id,
      actor,
      reason: "todo_start_required",
      body: [
        `Epic "${epic.title}" is in progress and task "${assigned.task.title}" is assigned to you.`,
        "Read the task context and attachments first. Call action=submit_plan with one concise structured technical Action Plan and wait for reviewer/manager/reporter approval before starting implementation.",
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

  const epic = await db.epic.findFirst({
    where: accessibleEpicWhere(actor, { id: epicId }),
    select: {
      id: true,
      projectId: true,
      deletedAt: true,
      project: { select: { slug: true } },
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) return;
  await requireProjectAccess(actor, { id: epic.projectId });

  await db.$transaction([
    db.comment.create({ data: { epicId, userId: actor.id, body, commentKind: "human", isGenerated: false, ...(actor.kind === "agent" ? { authorAgentSlug: actor.username } : {}) } }),
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
  // Moderation is owner-only so a member cannot mutate hidden agent context.
  if (!actor.isOwner) return;
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
  await requireEpicAccess(actor, epicId);
  await requireProjectAccess(actor, { id: comment.epic.projectId });
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
  if (!actor.isOwner) return;
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
  await requireEpicAccess(actor, epicId);
  await requireProjectAccess(actor, { id: comment.epic.projectId });
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
