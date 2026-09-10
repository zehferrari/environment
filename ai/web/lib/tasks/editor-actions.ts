"use server";

import { COLUMN_IDS } from "@/app/(app)/projects/[slug]/columns";
import {
  sendTaskWorkflowNotification
} from "@/lib/agents/workflow/notifications/task";
import {
  accessibleEpicWhere,
  accessibleTaskWhere,
  assertAgentAssignmentAllowed,
  canAccessTask,
  requireProjectAccess,
  requireTaskAccess,
  requireViewer
} from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { checkDeploymentStatusWrite, isDeploymentStatus } from "@/lib/deploy/deployment-status";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { notifyDispatch } from "@/lib/pm-dispatch";
import {
  buildDeploymentApproved,
  buildTaskAssigned,
} from "@/lib/pm-events";
import { isEffectivelyPublicTask } from "@/lib/pm-events/visibility";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { validateBlockedBy } from "@/lib/tasks/blocking";
import {
  revalidateTaskReplyScope,
  revalidateTaskShell
} from "@/lib/tasks/cache";
import {
  isTaskWorkflowStatus,
  submitBrowserStatusOverride,
} from "@/lib/tasks/orchestrator/browser-status-adapter";
import {
  checkActingManager,
  checkAssignment,
} from "@/lib/workflow";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";

async function requireActor() { return requireViewer(); }

export async function updateTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  if (!taskId || !slug) throw new Error("Task and project are required.");

  const titleRaw = String(formData.get("title") ?? "").trim();
  if (!titleRaw || titleRaw.length > 200) throw new Error("Title must contain 1–200 characters.");
  const descriptionRaw = String(formData.get("description") ?? "");
  const newDescription = descriptionRaw.trim() === "" ? null : descriptionRaw;
  const newStatus = String(formData.get("status") ?? "");
  const epicRaw = String(formData.get("epicId") ?? "");
  const newEpicId = epicRaw === "" ? null : epicRaw;
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const newBranch = branchRaw === "" ? null : branchRaw;
  const hasBranchField = formData.has("branchName");
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const newCommitPrefix = commitRaw === "" ? null : commitRaw;
  const hasCommitPrefixField = formData.has("commitPrefix");
  const hasAssigneeField = formData.has("assigneeId");
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const newAssigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const hasReviewerField = formData.has("actingManagerId");
  const reviewerRaw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = reviewerRaw === "" ? null : reviewerRaw;
  const hasReporterField = formData.has("reporterId");
  const reporterRaw = String(formData.get("reporterId") ?? "");
  const newReporterId = reporterRaw === "" ? null : reporterRaw;
  const hasBlockedByField = formData.has("blockedById");
  const blockedRaw = String(formData.get("blockedById") ?? "");
  const newBlockedById = blockedRaw === "" ? null : blockedRaw;
  const deploymentRaw = String(formData.get("deploymentStatus") ?? "");
  const hasPrivateField = formData.has("privateSubmitted");
  const hasAttachmentRequirementField = formData.has("reviewAttachmentRequiredSubmitted");
  const newReviewAttachmentRequired = formData.get("reviewAttachmentRequired") === "on";
  if (!actor.canAccessOwnerFeatures && (hasAssigneeField || hasReviewerField || hasReporterField)) {
    throw new Error("Only the Mission Control owner can change task roles.");
  }
  if ((hasPrivateField || formData.has("private")) && !actor.canAccessOwnerFeatures) throw new Error("Not authorized");
  if (hasAttachmentRequirementField && !actor.canAccessOwnerFeatures) throw new Error("Not authorized");
  const newPrivate = formData.get("private") === "on";

  if (newStatus !== "" && !COLUMN_IDS.includes(newStatus)) throw new Error("Invalid task status.");
  if (deploymentRaw !== "" && !isDeploymentStatus(deploymentRaw)) throw new Error("Invalid deployment status.");
  if (newBranch !== null && newBranch.length > 200) throw new Error("Branch name must be at most 200 characters.");
  if (newCommitPrefix !== null && newCommitPrefix.length > 200) throw new Error("Commit prefix must be at most 200 characters.");

  const task = await db.task.findFirst({
    where: accessibleTaskWhere(actor, { id: taskId }),
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      private: true,
      reviewAttachmentRequired: true,
      status: true,
      workflowVersion: true,
      activeWorkflowCycleId: true,
      epicId: true,
      branchName: true,
      commitPrefix: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      deploymentStatus: true,
      parentTaskId: true,
      blockedById: true,
      blockedBy: { select: { workItemKey: true } },
      approvedOn: true,
      workItemKey: true,
      project: {
        select: {
          slug: true,
          onlyReportersCanApproveActionPlans: true,
          onlyReportersCanApprovePullRequests: true,
          deploymentProductionBranch: true,
        },
      },
      epic: { select: { id: true, title: true, status: true, actingManagerId: true } },
      assignee: { select: { id: true, username: true, kind: true } },
      actingManager: { select: { username: true } },
      reporter: { select: { username: true } },
    },
  });
  if (!task || task.project.slug !== slug) throw new Error("Task not found or access denied.");
  await requireProjectAccess(actor, { id: task.projectId });

  const data: Prisma.TaskUpdateInput = {};
  const activity: { kind: string; payload: string }[] = [];
  const canTriggerAgents = actor.canAccessOwnerFeatures;
  let assignmentTarget: { id: string; kind: string; username: string } | null =
    null;
  let assignmentChanged = false;
  let reviewerPlanTargetId: string | null = null;
  let statusChangedTo: string | null = null;

  if (hasPrivateField && newPrivate !== task.private) {
    data.private = newPrivate;
    activity.push({
      kind: "task.privacy",
      payload: JSON.stringify({ from: task.private, to: newPrivate }),
    });
  }

  if (hasAttachmentRequirementField && newReviewAttachmentRequired !== task.reviewAttachmentRequired) {
    data.reviewAttachmentRequired = newReviewAttachmentRequired;
    activity.push({
      kind: "task.review_attachment_requirement",
      payload: JSON.stringify({ from: task.reviewAttachmentRequired, to: newReviewAttachmentRequired }),
    });
  }

  // Title / description
  const titleChanged = task.title !== titleRaw;
  const descChanged = (task.description ?? null) !== newDescription;
  if (titleChanged || descChanged) {
    data.title = titleRaw;
    data.description = newDescription;
    activity.push({
      kind: "task.update",
      payload: JSON.stringify({
        titleChanged,
        descChanged,
        from: { title: task.title, hasDescription: task.description !== null },
        to: { title: titleRaw, hasDescription: newDescription !== null },
      }),
    });
  }

  // Status (workflow-validated, recomputes rank like the board move)
  if (newStatus !== "" && newStatus !== task.status) {
    // The editor is only a transport. The authoritative human override command
    // owns and audits the workflow transition atomically.
    statusChangedTo = newStatus;
  }

  // Epic (must belong to the same project)
  if (newEpicId !== task.epicId) {
    let newEpicTitle: string | null = null;
    if (newEpicId !== null) {
      const target = await db.epic.findFirst({
        where: accessibleEpicWhere(actor, { id: newEpicId }),
        select: { id: true, title: true, projectId: true },
      });
      if (!target || target.projectId !== task.projectId) {
        throw new Error("Epic not found in this project");
      }
      newEpicTitle = target.title;
    }
    data.epic =
      newEpicId === null ? { disconnect: true } : { connect: { id: newEpicId } };
    activity.push({
      kind: "task.epic",
      payload: JSON.stringify({
        from: task.epic?.title ?? null,
        to: newEpicTitle,
      }),
    });
  }

  // Blocked-by dependency (ENV-62): same-project, cycle-guarded.
  const canEditBlockedBy = !task.blockedById || await canAccessTask(actor, task.blockedById);
  if (hasBlockedByField && canEditBlockedBy && newBlockedById !== task.blockedById) {
    let toKey: string | null = null;
    if (newBlockedById !== null) {
      await requireTaskAccess(actor, newBlockedById);
      const check = await validateBlockedBy({
        taskId: task.id,
        projectId: task.projectId,
        blockerId: newBlockedById,
      });
      if (!check.ok) throw new Error(check.message);
      const blocker = await db.task.findFirst({
        where: accessibleTaskWhere(actor, { id: newBlockedById }),
        select: { workItemKey: true },
      });
      toKey = blocker?.workItemKey ?? null;
    }
    data.blockedBy =
      newBlockedById === null ? { disconnect: true } : { connect: { id: newBlockedById } };
    activity.push({
      kind: "task.blocked_by",
      payload: JSON.stringify({ from: task.blockedBy?.workItemKey ?? null, to: toKey }),
    });
  }

  // Null is intentional: it means inherit the current Epic override or fall
  // back to this Task's work-item key at read/use time.
  if (actor.agentVisibility !== "hidden" && hasBranchField && (task.branchName ?? null) !== newBranch) {
    data.branchName = newBranch;
    activity.push({
      kind: "task.branch",
      payload: JSON.stringify({ from: task.branchName ?? null, to: newBranch }),
    });
  }

  // Commit prefix (HOMELAB task-form redesign)
  if (actor.agentVisibility !== "hidden" && hasCommitPrefixField && (task.commitPrefix ?? null) !== newCommitPrefix) {
    data.commitPrefix = newCommitPrefix;
    activity.push({
      kind: "task.commit_prefix",
      payload: JSON.stringify({
        from: task.commitPrefix ?? null,
        to: newCommitPrefix,
      }),
    });
  }

  // Assignee (no agent self-assign; target must be active)
  if (hasAssigneeField && newAssigneeId !== task.assigneeId) {
    await assertAgentAssignmentAllowed(actor, [task.assigneeId, newAssigneeId]);
    const check = checkAssignment({ actor, newAssigneeId });
    if (!check.ok) throw new Error(check.message);
    if (newAssigneeId !== null) {
      const row = await db.user.findUnique({
        where: { id: newAssigneeId },
        select: { id: true, username: true, kind: true, status: true },
      });
      if (!row || row.status !== "active") {
        throw new Error("Assignee not found or inactive");
      }
      assignmentTarget = { id: row.id, username: row.username, kind: row.kind };
    }
    data.assignee =
      newAssigneeId === null
        ? { disconnect: true }
        : { connect: { id: newAssigneeId } };
    data.approvedOn = null;
    data.approvedBy = { disconnect: true };
    assignmentChanged = true;
    activity.push({
      kind: "task.assign",
      payload: JSON.stringify({
        from: task.assignee?.username ?? null,
        to: assignmentTarget?.username ?? null,
        assignedBy: "human-edit",
      }),
    });
    activity.push({
      kind: "task.action_plan.reset",
      payload: JSON.stringify({
        reason: "assignee_changed",
        from: task.assignee?.username ?? null,
        to: assignmentTarget?.username ?? null,
      }),
    });
  }

  // Reviewer / acting manager (no agent self-review; target must be active)
  if (hasReviewerField && newActingManagerId !== task.actingManagerId) {
    await assertAgentAssignmentAllowed(actor, [task.actingManagerId, newActingManagerId]);
    const check = checkActingManager({ actor, newActingManagerId });
    if (!check.ok) throw new Error(check.message);
    let toUsername: string | null = null;
    if (newActingManagerId !== null) {
      const target = await db.user.findUnique({
        where: { id: newActingManagerId },
        select: { username: true, status: true },
      });
      if (!target || target.status !== "active") {
        throw new Error("Reviewer not found or inactive");
      }
      toUsername = target.username;
      reviewerPlanTargetId = newActingManagerId;
    }
    data.actingManager =
      newActingManagerId === null
        ? { disconnect: true }
        : { connect: { id: newActingManagerId } };
    activity.push({
      kind: "task.acting_manager",
      payload: JSON.stringify({
        from: task.actingManager?.username ?? null,
        to: toUsername,
      }),
    });
  }

  // Deployment status: only top-level Tasks (no Epic / sub-task parent) expose it.
  const deploymentAllowed = task.epicId == null && task.parentTaskId == null;
  if (deploymentAllowed && deploymentRaw !== "" && deploymentRaw !== task.deploymentStatus) {
    const actorAgent = actor.kind === "agent"
      ? await db.user.findUnique({ where: { id: actor.id }, select: { agent: { select: { role: true } } } })
      : null;
    const check = checkDeploymentStatusWrite({
      actor,
      actorAgentRole: actorAgent?.agent?.role ?? null,
      from: task.deploymentStatus,
      to: deploymentRaw,
    });
    if (!check.ok) throw new Error(check.message);
    data.deploymentStatus = deploymentRaw;
    activity.push({
      kind: "task.deployment_status",
      payload: JSON.stringify({ from: task.deploymentStatus, to: deploymentRaw }),
    });
  }

  // Reporter (active User/Agent row; defaults to creator on new tasks)
  if (hasReporterField && newReporterId !== task.reporterId) {
    await assertAgentAssignmentAllowed(actor, [task.reporterId, newReporterId]);
    let toUsername: string | null = null;
    if (newReporterId !== null) {
      const target = await db.user.findUnique({
        where: { id: newReporterId },
        select: { username: true, status: true },
      });
      if (!target || target.status !== "active") {
        throw new Error("Reporter not found or inactive");
      }
      toUsername = target.username;
    }
    data.reporter =
      newReporterId === null
        ? { disconnect: true }
        : { connect: { id: newReporterId } };
    activity.push({
      kind: "task.reporter",
      payload: JSON.stringify({
        from: task.reporter?.username ?? null,
        to: toUsername,
      }),
    });
  }

  if (activity.length === 0 && !statusChangedTo) return; // nothing changed

  if (activity.length > 0) {
    await db.$transaction([
      db.task.update({ where: { id: taskId }, data }),
      ...activity.map((a) =>
        db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId,
            userId: actor.id,
            kind: a.kind,
            payload: a.payload,
          },
        }),
      ),
    ]);
  }

  if (statusChangedTo) {
    if (!isTaskWorkflowStatus(task.status) || !isTaskWorkflowStatus(statusChangedTo)) {
      throw new Error("Task has an invalid workflow status.");
    }
    const moved = await submitBrowserStatusOverride({
      actor,
      taskId,
      currentStatus: task.status,
      targetStatus: statusChangedTo,
      expectedWorkflowVersion: task.workflowVersion,
      activeWorkflowCycleId: task.activeWorkflowCycleId,
      surface: "task-detail",
    });
    if (!moved.ok) throw new Error(moved.message);
    revalidateTaskReplyScope(taskId, "comment");
  } else {
    await syncEpicOnHumanTaskStatus(db, {
      epicId: newEpicId,
      projectId: task.projectId,
      taskId,
      actorId: actor.id,
      actorKind: actor.kind,
      targetStatus: task.status,
      via: "task-edit",
    });
  }

  try {
    const { deleteDescriptionDraft } = await import("@/lib/description-drafts");
    // Save applied — clear THIS user's draft (others viewing the same
    // task with their own drafts keep them).
    await deleteDescriptionDraft({ scope: "task", targetId: taskId, requesterUserId: actor.id });
  } catch (e) {
    console.error("Failed to delete description draft:", e);
  }

  revalidateTaskShell(taskId);
  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(task.projectId);

  const shouldEmitLegacyTaskEvent = canTriggerAgents && (
    (deploymentAllowed && deploymentRaw === "Deployment Approved" && task.deploymentStatus !== "Deployment Approved")
    || assignmentChanged
  );
  const canEmitLegacyTaskEvent = shouldEmitLegacyTaskEvent
    ? await isEffectivelyPublicTask(task.id)
    : false;

  if (canEmitLegacyTaskEvent && deploymentAllowed && deploymentRaw === "Deployment Approved" && task.deploymentStatus !== "Deployment Approved") {
    await notifyDispatch(
      buildDeploymentApproved(
        {
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          actor,
          task: { id: task.id, key: task.workItemKey ?? task.id, projectKey: slug, title: titleRaw },
        },
        { scope: "task", scopeId: task.id, deploymentStatus: "Deployment Approved" },
      ),
    );
  }

  // Assignment wake fires after the commit, non-throwing (mirrors the old
  // standalone assignTask path).
  if (canEmitLegacyTaskEvent && assignmentChanged) {
    await notifyDispatch(
      buildTaskAssigned(
        {
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          actor,
          task: { id: task.id, key: task.workItemKey ?? task.id, projectKey: slug, title: titleRaw },
        },
        {
          assignee: assignmentTarget
            ? {
                id: assignmentTarget.id,
                kind: assignmentTarget.kind === "agent" ? "agent" : "human",
                name: assignmentTarget.username,
              }
            : null,
          previousAssignee: task.assignee
            ? {
                id: task.assignee.id,
                kind: task.assignee.kind === "agent" ? "agent" : "human",
                name: task.assignee.username,
              }
            : null,
        },
      ),
    );
  }

  const finalStatus = statusChangedTo ?? task.status;
  const finalAssigneeId = assignmentChanged ? newAssigneeId : task.assigneeId;
  if (
    finalAssigneeId &&
    (assignmentChanged || statusChangedTo === "To Do") &&
    (finalStatus === "Backlog" || finalStatus === "To Do")
  ) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: finalAssigneeId,
      actor,
      reason: finalStatus === "Backlog" ? "backlog_plan_requested" : "todo_start_required",
      body: finalStatus === "Backlog"
        ? [
            `You have been assigned to "${titleRaw}" while it is in Backlog.`,
            "Read the full task context and existing comments. Call action=submit_plan with one concise structured technical Action Plan; plain chat text is discussion only.",
            "Do not change task status and do not start work until the task is moved to To Do.",
          ].join("\n")
        : [
            `Task "${titleRaw}" is now in To Do and assigned to you.`,
            "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. Plain chat text is discussion only.",
            "Do not move it to In Progress until approved_on is set.",
          ].join("\n"),
    });
  }

  if (reviewerPlanTargetId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: reviewerPlanTargetId,
      actor,
      reason: "reviewer_assignment_requested",
      body: [
        `You have been set as Reviewer for "${titleRaw}".`,
        "If the task has no assignee, call action=assign_task so PM can select an eligible coding agent.",
        "The assignee authors the implementation plan. Review it after submission; do not start implementation yourself.",
      ].join("\n"),
    });
  }

}

