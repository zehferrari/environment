import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  renderCommentBody,
  renderFullMarkdown,
  extractMentions,
} from "@/lib/markdown";
import {
  checkAssignment,
  checkActingManager,
} from "@/lib/workflow";
import { COLUMN_IDS } from "../../columns";
import {
  buildDeploymentApproved,
  buildTaskAssigned,
} from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import { isEffectivelyPublicTask } from "@/lib/pm-events/visibility";
import {
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
} from "@/lib/agents/workflow/notifications/task";
import {
  listAssignablePrincipals,
} from "@/lib/principals";
import { deleteAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { deleteTask } from "@/lib/bin/actions";
import { archiveTask, unarchiveTask } from "@/lib/archive/actions";
import { approveAndMergeDeploymentPullRequest, approveDeploymentLocalChanges } from "@/lib/deploy/actions";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { validateCheckpointAuthorizationText } from "@/lib/deploy/checkpoint-authorization";
import {
  activeFormalBlockersByTask,
  blockerPermissionGrantForComment,
} from "@/lib/tasks/formal-blocker";
import { applyBlockerPermissionGrant } from "@/lib/tasks/blocker-permission-grant";
import {
  createSubTaskItem,
  setSubTaskCompletion,
  deleteSubTaskItem,
  normalizeSubTaskKind,
  reorderSubTaskItems,
} from "@/lib/tasks/subtasks";
import { validateBlockedBy } from "@/lib/tasks/blocking";
import { publishBoardTouch } from "@/lib/pm/board-events";
import {
  canApproveActionPlanForActor,
  isActionableEpicStatus,
  resolveReviewOwnerId,
} from "@/lib/tasks/workflow-actors";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";
import { getTaskGitChanges, getTaskGitFileDiff } from "@/lib/tasks/git-changes";
import { createChecklistAndDelegatableTasksFromPlan } from "@/lib/tasks/action-plan-store";
import { moveTaskStatus as transitionTaskStatus } from "@/lib/tasks/move-status";
import { reserveTaskRepositoryState } from "@/lib/tasks/repository-state";
import { effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import {
  applyTaskTransition,
  enqueueWorkflowEffects,
  type WorkflowEffect,
} from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import {
  getCachedLatestRepoVerifyActivity,
  getCachedPendingTaskProposals,
  getCachedProjectEpics,
  getCachedRecentTaskChatMessages,
  getCachedTaskActivity,
  getCachedTaskAttachments,
  createdAtMs,
  getCachedTaskChatArchives,
  getCachedTaskComments,
  getCachedTaskDetailShell,
  getCachedTaskRoomMessages,
  revalidateTaskReplyScope,
  revalidateTaskShell,
} from "@/lib/tasks/cache";
import TaskChecklist from "@/components/task-checklist";
import { TaskExecutionStrip } from "@/components/task-execution-strip";
import AttachmentList from "@/components/attachment-list";
import AutoScrollToLatest from "@/components/auto-scroll-to-latest";
import FocusTaskComment from "@/components/focus-task-comment";
import TaskCommentStreams from "@/components/task-comment-streams";
import ChatRoom from "@/components/chat-room";
import ActivityTimeline, { type ActivityTimelineRow } from "@/components/activity-timeline";
import TaskChangesPanel from "@/components/task-changes-panel";
import CloseTaskButton from "@/components/close-task-button";
import TaskDirtyGuard from "@/components/task-dirty-guard";
import ConfirmedDeleteButton from "@/components/confirmed-delete-button";
import DeletedMessageDivider from "@/components/deleted-message-divider";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  syntheticRoleMeta,
} from "@/components/message-avatar";
import DescriptionField from "@/components/description-field";
import PrivateToggle from "@/components/private-toggle";
import { TabsProvider, TabsNav, TabPanel } from "@/components/task-tabs";
import StickyViewportSurface from "@/components/sticky-viewport-surface";
import PmOptions from "@/components/pm-options";
import { findPmOptionResolution, parsePmOptions, isPmOptionsTargetedAtCurrentUser } from "@/lib/pm-options";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import TaskEpicPicker from "./task-epic-picker";
import DeploymentTab, { DeploymentStatusSelect, canShowDeploymentAction, canShowDeploymentTab, type DeploymentPrRow } from "@/components/deployment-tab";
import { checkDeploymentStatusWrite, isDeploymentStatus } from "@/lib/deploy/deployment-status";
import {
  accessibleEpicWhere,
  accessibleTaskWhere,
  assertAgentAssignmentAllowed,
  canAccessTask,
  requireProjectAccess,
  requireTaskAccess,
  requireViewer,
  type Viewer,
} from "@/lib/auth/permissions";
import {
  getActorVisibility,
  serializeVisibleActor,
  serializeVisibleActorAs,
  visibleActivityRows,
  type ActorVisibility,
} from "@/lib/users/actor-visibility";
import { buildAgentRedactor } from "@/lib/users/redact-agents";

type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | string | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
};

function mentionedUsername(body: string, username: string | null | undefined) {
  if (!username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, "i").test(body);
}

function serializeActor(actor: ActorRow | null, visibility: ActorVisibility) {
  return serializeVisibleActor(actor, visibility);
}

async function requireActor(): Promise<Viewer> {
  return requireViewer();
}

async function requireActorId(): Promise<string> {
  return (await requireActor()).id;
}

// ---- Server actions -------------------------------------------------

// Single task-form save. Persists title, description, status, epic,
// branch, commit prefix, assignee and reviewer in one transaction, with
// each field keeping the validation its standalone action used to do
// (workflow transition rules, project-scoped epic, no agent self-assign /
// self-review). Only changed fields are written + activity-logged; a hard
// rule violation throws (whole save fails) the same way the old per-field
// actions did. The assignment wake fires after commit, non-throwing.
async function updateTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  if (!taskId || !slug) return;

  const titleRaw = String(formData.get("title") ?? "").trim();
  if (!titleRaw || titleRaw.length > 200) return;
  const descriptionRaw = String(formData.get("description") ?? "");
  const newDescription = descriptionRaw.trim() === "" ? null : descriptionRaw;
  const newStatus = String(formData.get("status") ?? "");
  const epicRaw = String(formData.get("epicId") ?? "");
  const newEpicId = epicRaw === "" ? null : epicRaw;
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const newBranch = branchRaw === "" ? null : branchRaw;
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const newCommitPrefix = commitRaw === "" ? null : commitRaw;
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
  if (!actor.isOwner && (hasAssigneeField || hasReviewerField || hasReporterField)) {
    throw new Error("Only the Mission Control owner can change task roles.");
  }
  if ((hasPrivateField || formData.has("private")) && !actor.isOwner) throw new Error("Not authorized");
  const newPrivate = formData.get("private") === "on";

  if (newStatus !== "" && !COLUMN_IDS.includes(newStatus)) return;
  if (deploymentRaw !== "" && !isDeploymentStatus(deploymentRaw)) return;
  if (newBranch !== null && newBranch.length > 200) return;
  if (newCommitPrefix !== null && newCommitPrefix.length > 200) return;

  const task = await db.task.findFirst({
    where: accessibleTaskWhere(actor, { id: taskId }),
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      private: true,
      status: true,
      workflowVersion: true,
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
      repositoryRun: { select: { phase: true } },
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
  if (!task || task.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: task.projectId });

  const data: Prisma.TaskUpdateInput = {};
  const activity: { kind: string; payload: string }[] = [];
  const canTriggerAgents = actor.isOwner;
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
    if (task.repositoryRun?.phase === "finalizing") {
      throw new Error("Repository finalization is running; wait for it to complete before changing status.");
    }
    if (newStatus === "In Progress") {
      if (newBranch !== task.branchName || newEpicId !== task.epicId) {
        throw new Error("Save the task branch/Epic change before moving it to In Progress so PM can provision the correct worktree.");
      }
    }
    // The editor is only an adapter. The shared move service owns every gate,
    // transition ledger row, repository handoff, and durable side effect.
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
  if ((task.branchName ?? null) !== newBranch) {
    data.branchName = newBranch;
    activity.push({
      kind: "task.branch",
      payload: JSON.stringify({ from: task.branchName ?? null, to: newBranch }),
    });
  }

  // Commit prefix (HOMELAB task-form redesign)
  if ((task.commitPrefix ?? null) !== newCommitPrefix) {
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
    const moved = await transitionTaskStatus(taskId, statusChangedTo, slug);
    if (!moved.ok) throw new Error(moved.message);
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

async function approveTaskActionPlan(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  if (!taskId || !slug) return;
  await requireTaskAccess(actor, taskId);

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      status: true,
      workflowVersion: true,
      projectId: true,
      approvedOn: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      deletedAt: true,
      actionPlan: { select: { id: true, steps: { select: { id: true }, take: 1 } } },
      project: { select: { slug: true, onlyReportersCanApproveActionPlans: true } },
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!task || task.deletedAt || task.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: task.projectId });
  if (!actor.isOwner) throw new Error("Not authorized");

  if (actor.kind !== "human" && !canApproveActionPlanForActor(task, actor.id)) {
    throw new Error(task.project.onlyReportersCanApproveActionPlans
      ? "Only the task reporter can approve the Action Plan for this project."
      : "Only the task reviewer or reporter can approve the Action Plan.");
  }
  if (task.approvedOn) return;
  if (task.status !== "Backlog" && task.status !== "To Do") {
    throw new Error("Action Plans can only be approved before implementation starts.");
  }
  if (!task.actionPlan || task.actionPlan.steps.length === 0) {
    throw new Error("A validated structured Action Plan must be submitted before approval.");
  }

  // Approval reserves the repository contract. Worktree provisioning belongs
  // to the In Progress transition so queued work has no writable tree.
  await reserveTaskRepositoryState(task.id);

  const approvedAt = new Date();
  const reviewerId = resolveReviewOwnerId(task);
  const effects: WorkflowEffect[] = [
    { type: "board_touch", key: "board-plan-approved", payload: {} },
  ];
  if (task.assigneeId) {
    effects.push({
      type: "task_notification",
      key: `plan-approved:${task.assigneeId}`,
      payload: {
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "todo_start_required",
        body: [
          `The Action Plan for "${task.title}" was approved.`,
          "PM will auto-start it if the execution lane and repository gates are free. Check the current status: implement immediately if In Progress, otherwise call action=start when it remains To Do.",
          "Keep visible replies concise; use a comment only if a blocker or material plan change appears.",
        ].join("\n"),
      },
    });
  } else if (reviewerId) {
    effects.push({
      type: "task_notification",
      key: `assignment-required:${reviewerId}`,
      payload: {
        taskId: task.id,
        targetUserId: reviewerId,
        actor,
        reason: "reviewer_assignment_requested",
        body: [
          `The Action Plan for "${task.title}" was approved, but the task has no assignee.`,
          "Call action=assign_task so PM can select an eligible coding agent. Do not start implementation yourself.",
        ].join("\n"),
      },
    });
  }

  await db.$transaction(async (tx) => {
    if (task.status === "Backlog") {
      await applyTaskTransition(tx, {
        taskId: task.id,
        projectId: task.projectId,
        actorUserId: actor.id,
        intent: "approve_plan",
        from: "Backlog",
        to: "To Do",
        source: "action-plan-approval",
        idempotencyKey: `human-plan-approval:v${task.workflowVersion + 1}`,
        expectedVersion: task.workflowVersion,
        taskData: { approvedOn: approvedAt, approvedById: actor.id },
        evidence: { actionPlanId: task.actionPlan!.id },
        effects,
      });
    } else {
      await tx.task.update({
        where: { id: task.id },
        data: { approvedOn: approvedAt, approvedById: actor.id },
      });
      await enqueueWorkflowEffects(tx, {
        taskId: task.id,
        projectId: task.projectId,
        aggregateVersion: task.workflowVersion,
        effects,
      });
    }
    await tx.actionPlan.update({
      where: { id: task.actionPlan!.id },
      data: { status: "approved", approvedOn: approvedAt, approvedById: actor.id },
    });
    await tx.actionPlanRevision.updateMany({
      where: { actionPlanId: task.actionPlan!.id, status: "draft" },
      data: { status: "approved", approvedOn: approvedAt, approvedById: actor.id },
    });
    await createChecklistAndDelegatableTasksFromPlan({
      taskId: task.id,
      approvedAt,
      approvedById: actor.id,
      client: tx,
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor.id,
        kind: "task.action_plan.approve",
        payload: JSON.stringify({
          taskId: task.id,
          previousStatus: task.status,
          status: task.status === "Backlog" ? "To Do" : task.status,
        }),
      },
    });
  });

  if (task.assigneeId) {
    await startApprovedTodoTaskIfIdle({
      taskId: task.id,
      actor,
      via: "action-plan-approval",
    });
  }
  await drainWorkflowOutbox({ limit: effects.length }).catch(() => {});

  revalidateTaskShell(task.id);
  revalidatePath(`/projects/${slug}/tasks/${task.id}`);
  revalidatePath(`/projects/${slug}`);
}

// Human-only comment removal (HOMELAB-41). Agents post comments but
// cannot delete them — moderation stays a human action. Scoped by the
// URL slug + task so a comment id from another project can't be removed.
async function deleteComment(formData: FormData) {
  "use server";
  const actor = await requireActor();
  if (!actor.isOwner) return;
  const commentId = String(formData.get("commentId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  if (!commentId || !slug || !taskId) return;
  await requireTaskAccess(actor, taskId);

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      deletedAt: true,
      task: {
        select: {
          id: true,
          projectId: true,
          project: { select: { slug: true } },
        },
      },
    },
  });
  if (
    !comment ||
    !comment.task ||
    comment.task.id !== taskId ||
    comment.task.project.slug !== slug
  ) {
    return;
  }
  await requireProjectAccess(actor, { id: comment.task.projectId });
  if (comment.deletedAt) return; // already soft-deleted

  // Soft delete (HOMELAB-41 / item 2): keep the row so the frontend can
  // show a collapsed dotted divider that a human reviewer can toggle
  // open. Agent context builders filter deletedAt: null so the agents
  // never see the deleted body.
  await db.$transaction([
    db.comment.update({
      where: { id: commentId },
      data: { deletedAt: new Date(), deletedById: actor.id },
    }),
    db.activityLog.create({
      data: {
        projectId: comment.task.projectId,
        taskId: comment.task.id,
        userId: actor.id,
        kind: "task.comment.delete",
        payload: JSON.stringify({ commentId, soft: true }),
      },
    }),
  ]);

  revalidateTaskReplyScope(taskId, "comment");
}

// Restore a soft-deleted task comment (HOMELAB-41 / item 2 follow-up).
// Inverse of deleteComment. Human-only, same gating. Idempotent.
async function restoreComment(formData: FormData) {
  "use server";
  const actor = await requireActor();
  if (!actor.isOwner) return;
  const commentId = String(formData.get("commentId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  if (!commentId || !slug || !taskId) return;
  await requireTaskAccess(actor, taskId);

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      deletedAt: true,
      task: { select: { id: true, projectId: true, project: { select: { slug: true } } } },
    },
  });
  if (
    !comment ||
    !comment.task ||
    comment.task.id !== taskId ||
    comment.task.project.slug !== slug
  ) {
    return;
  }
  await requireProjectAccess(actor, { id: comment.task.projectId });
  if (!comment.deletedAt) return; // already restored

  await db.$transaction([
    db.comment.update({
      where: { id: commentId },
      data: { deletedAt: null, deletedById: null },
    }),
    db.activityLog.create({
      data: {
        projectId: comment.task.projectId,
        taskId: comment.task.id,
        userId: actor.id,
        kind: "task.comment.restore",
        payload: JSON.stringify({ commentId }),
      },
    }),
  ]);

  revalidateTaskReplyScope(taskId, "comment");
}

// A formal blocker may explicitly declare that the only missing dependency is
// a narrowly scoped reporter permission. This action validates that durable
// request, records an auditable grant comment, and wakes the visible assignee.
// Granting makes the round agent-actionable. Non-checkpoint dependencies are
// still cleared by the assignee after verification; checkpoint success/failure
// consumes the grant and closes its exact round automatically.
async function grantBlockerPermission(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const blockerCommentId = String(formData.get("blockerCommentId") ?? "");
  if (!taskId || !slug || !blockerCommentId || actor.kind !== "human") return;
  await requireTaskAccess(actor, taskId);

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      reporterId: true,
      assigneeId: true,
      approvedOn: true,
      workItemKey: true,
      branchName: true,
      commitPrefix: true,
      deletedAt: true,
      assignee: { select: { username: true } },
      project: { select: { slug: true, repositoryPath: true } },
      epic: {
        select: {
          status: true,
          branchName: true,
          commitPrefix: true,
          workItemKey: true,
        },
      },
    },
  });
  if (!task || task.deletedAt || task.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: task.projectId });
  if (actor.id !== task.reporterId) throw new Error("Only the task reporter can grant this permission.");
  if (!task.assigneeId || !task.assignee) throw new Error("The task has no assignee to receive this permission.");

  const lifecycleRows = await db.activityLog.findMany({
    where: {
      taskId: task.id,
      kind: { in: [
        "task.blocker",
        "task.extra_work.blocker",
        "task.blocker.cleared",
        "task.blocker.permission.granted",
      ] },
    },
    orderBy: { createdAt: "desc" },
    select: { taskId: true, kind: true, payload: true },
  });
  const activeBlocker = activeFormalBlockersByTask(lifecycleRows).get(task.id);
  if (!activeBlocker || activeBlocker.commentId !== blockerCommentId || !activeBlocker.permissionRequest) {
    throw new Error("That comment is no longer the active permission-only blocker.");
  }
  if (blockerPermissionGrantForComment(lifecycleRows, blockerCommentId)) return;

  const blockerComment = await db.comment.findFirst({
    where: { id: blockerCommentId, taskId: task.id, deletedAt: null },
    select: { id: true },
  });
  if (!blockerComment) throw new Error("The blocker comment is no longer available.");

  const request = activeBlocker.permissionRequest;
  let body: string;
  if (request.kind === "publish_checkpoint") {
    if (!actor.isOwner) {
      throw new Error("Checkpoint publication still requires the active Mission Control owner.");
    }
    const taskBranch = effectiveTaskBranchName(task);
    const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
    if (
      task.status !== "In Progress" ||
      !task.approvedOn ||
      !task.project.repositoryPath ||
      !task.epic ||
      task.epic.status !== "In Progress" ||
      !taskBranch ||
      !epicBranch ||
      request.taskBranch !== taskBranch ||
      request.epicBranch !== epicBranch
    ) {
      throw new Error("The checkpoint permission request no longer matches the task's active repository state.");
    }
    body = [
      `@${task.assignee.username} I hereby authorize PM to publish and deploy the current checkpoint for ${task.workItemKey ?? taskBranch} / ${taskBranch} to the Epic branch ${epicBranch}.`,
      `This authorization is limited to the permission requested in blocker comment ${blockerCommentId}: ${request.scope}`,
      "Use this comment as authorizationCommentId and proceed now. PM closes this permission round automatically when the checkpoint attempt succeeds or fails; any later publication requires a fresh blocker and grant.",
    ].join("\n\n");
    const validation = validateCheckpointAuthorizationText({
      body,
      taskKey: task.workItemKey,
      taskBranch,
      epicBranch,
    });
    if (!validation.ok) throw new Error(validation.reason);
  } else {
    body = [
      `@${task.assignee.username} As the reporter for ${task.workItemKey ?? task.title}, I hereby authorize this exact requested action: ${request.scope}`,
      `This grant is limited to the active blocker comment ${blockerCommentId} and does not authorize unrelated changes. Proceed, verify the result, then clear the blocker with evidence.`,
    ].join("\n\n");
  }

  // ENV-120: the grant is one deterministic transaction — record, clear the
  // round it answers, supersede competing runs, reserve exactly one
  // continuation. The deterministic activity ids make simultaneous
  // double-clicks roll back; sequential clicks already returned above.
  const assigneeAgent = await db.agent.findFirst({
    where: { user: { id: task.assigneeId } },
    select: { slug: true },
  });
  const grant = await applyBlockerPermissionGrant({
    taskId: task.id,
    projectId: task.projectId,
    actorUserId: actor.id,
    assigneeSlug: assigneeAgent?.slug ?? null,
    blockerCommentId,
    permissionKind: request.kind,
    permissionScope: request.scope,
    authorizationBody: body,
  });
  if (!grant.granted) return;
  const authorization = { id: grant.authorizationCommentId };

  // Owner comments use the ordinary directed-comment path. A non-owner task
  // reporter's generic approval is delivered as a PM-validated workflow
  // capability, so it can wake the assignee without weakening the global rule
  // that arbitrary member comments are informational only.
  if (actor.isOwner) {
    await sendTaskCommentNotifications({
      taskId: task.id,
      commentId: authorization.id,
      body,
      actor: { id: actor.id, kind: actor.kind, username: actor.username },
    });
  } else {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor,
      reason: "blocker_response",
      body: [
        `PM validated the task reporter's narrowly scoped permission grant in comment ${authorization.id}.`,
        body,
        grant.blockerCleared
          ? "PM already cleared this blocker round and superseded any competing run for you. Resume implementation now; do not call clear_blocker for it."
          : "This permission round stays open until the authorized attempt settles; PM closes it automatically on success or failure.",
      ].join("\n\n"),
    });
  }

  revalidateTaskReplyScope(task.id, "comment");
  revalidateTaskReplyScope(task.id, "chat");
  revalidateTaskShell(task.id);
  revalidatePath(`/projects/${slug}/tasks/${task.id}`);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(task.projectId);
}

// Checklist (lightweight sub-task) management. A checklist item is text + a
// completion timestamp — not a child Task. The same actor model as comments
// applies: humans always; the assigned agent may add/tick/remove items so the
// board progress reflects how far it is from done (agents normally do this
// through the native workflow endpoint, but a browser-session agent may too).
async function resolveChecklistContext(taskId: string, slug: string) {
  const actor = await requireActor();
  await requireTaskAccess(actor, taskId);
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, assigneeId: true, project: { select: { slug: true } } },
  });
  if (!task || task.project.slug !== slug) return null;
  await requireProjectAccess(actor, { id: task.projectId });
  if (actor.kind !== "human" && actor.id !== task.assigneeId) return null;
  return { actor, task };
}

function revalidateChecklist(slug: string, taskId: string, projectId: string) {
  revalidateTaskShell(taskId);
  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(projectId);
}

async function addSubTaskItem(formData: FormData) {
  "use server";
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const text = String(formData.get("text") ?? "").trim();
  // "implementation" (default) or "review" — which checklist phase the item
  // belongs to; anything unexpected normalizes to "implementation".
  const kind = normalizeSubTaskKind(formData.get("kind"));
  if (!taskId || !slug || !text) return;
  const ctx = await resolveChecklistContext(taskId, slug);
  if (!ctx) return;
  await createSubTaskItem({ taskId, text, actorUserId: ctx.actor.id, kind });
  revalidateChecklist(slug, taskId, ctx.task.projectId);
}

async function toggleSubTaskItem(formData: FormData) {
  "use server";
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const subTaskId = String(formData.get("subTaskId") ?? "");
  const completed = String(formData.get("completed") ?? "") === "1";
  // "" = leave minutes unchanged; a number sets the self-reported effort.
  const minutesRaw = String(formData.get("minutesSpent") ?? "");
  const minutesSpent = minutesRaw === "" ? undefined : Number(minutesRaw);
  if (!taskId || !slug || !subTaskId) return;
  const ctx = await resolveChecklistContext(taskId, slug);
  if (!ctx) return;
  await setSubTaskCompletion({ subTaskId, completed, minutesSpent, actorUserId: ctx.actor.id, expectTaskId: taskId });
  revalidateChecklist(slug, taskId, ctx.task.projectId);
}

async function removeSubTaskItem(formData: FormData) {
  "use server";
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const subTaskId = String(formData.get("subTaskId") ?? "");
  if (!taskId || !slug || !subTaskId) return;
  const ctx = await resolveChecklistContext(taskId, slug);
  if (!ctx) return;
  await deleteSubTaskItem({ subTaskId, actorUserId: ctx.actor.id, expectTaskId: taskId });
  revalidateChecklist(slug, taskId, ctx.task.projectId);
}

// ---- Helpers --------------------------------------------------------

function LockIcon() {
  return (
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function dateValue(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateIso(value: Date | string | null | undefined): string | null {
  return dateValue(value)?.toISOString() ?? null;
}

function timeAgo(value: Date | string | null | undefined): string {
  const d = dateValue(value);
  if (!d) return "unknown";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function payloadValue(payload: string | null | undefined, key: string) {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  }))];
}

function taskWorkWindows(
  rows: Array<{ kind: string; payload: string | null; createdAt: Date | string }>,
  fallback: { status: string; statusChangedAt: Date | string | null },
) {
  const windows: Array<{ since: Date | string; until: Date | string | null }> = [];
  let openStart: Date | string | null = null;

  for (const row of [...rows].reverse()) {
    if (row.kind !== "task.move") continue;
    const to = payloadValue(row.payload, "to");
    if (to === "In Progress") {
      openStart = row.createdAt;
      continue;
    }
    if (openStart && (to === "Review" || to === "Done")) {
      windows.push({ since: openStart, until: row.createdAt });
      openStart = null;
    }
  }

  if (openStart) {
    windows.push({ since: openStart, until: null });
  }
  if (windows.length === 0 && fallback.status === "In Progress" && fallback.statusChangedAt) {
    windows.push({ since: fallback.statusChangedAt, until: null });
  }

  return windows;
}

function activityMessageIds(rows: Array<{ kind: string; payload: string | null }>) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as {
        inReplyToMessageId?: unknown;
        messageId?: unknown;
        target?: { messageId?: unknown };
      };
      if (typeof payload.inReplyToMessageId === "string") ids.add(payload.inReplyToMessageId);
      if (row.kind.endsWith(".dispatch_failed") && typeof payload.messageId === "string") {
        ids.add(payload.messageId);
      }
      if (row.kind.endsWith(".stream_error") && typeof payload.target?.messageId === "string") {
        ids.add(payload.target.messageId);
      }
    } catch {
      // Ignore old or malformed audit payloads.
    }
  }
  return ids;
}

type WorkflowBubbleActor = {
  username?: string | null;
  kind?: string | null;
  agent?: { slug?: string | null } | null;
} | null;

type WorkflowBubbleTask = {
  status: string;
  assignee?: WorkflowBubbleActor;
  actingManager?: WorkflowBubbleActor;
  reporter?: WorkflowBubbleActor;
  epic?: {
    status?: string | null;
    actingManager?: WorkflowBubbleActor;
  } | null;
};

type PendingCommentMessage = {
  id: string;
  agentSlug: string;
  originChannel: string;
  sender: { kind: string };
  body: string;
};

type PendingCommentRun = {
  messageId: string;
  agentSlug: string;
  status: string;
};

function workflowActorSlug(actor: WorkflowBubbleActor | undefined) {
  if (!actor) return null;
  if (actor.kind === "agent" && actor.agent?.slug) return actor.agent.slug;
  return actor.username ?? null;
}

function workflowNotificationStatus(body: string) {
  if (!body.startsWith("PM workflow notification for @")) return null;
  if (body.includes(" while it is in Backlog.")) return "Backlog";
  if (body.includes(" is now in To Do ")) return "To Do";
  if (body.includes(" was moved to Review")) return "Review";
  return null;
}

function workflowOwnerSlugs(task: WorkflowBubbleTask) {
  const slugs = new Set<string>();
  const add = (slug: string | null) => {
    if (slug) slugs.add(slug);
  };

  if (task.status === "Backlog" || task.status === "To Do" || task.status === "In Progress") {
    add(workflowActorSlug(task.assignee));
    return slugs;
  }

  if (task.status === "Review") {
    add(
      workflowActorSlug(task.actingManager)
        ?? (isActionableEpicStatus(task.epic?.status) ? workflowActorSlug(task.epic?.actingManager) : null)
        ?? workflowActorSlug(task.reporter),
    );
  }

  return slugs;
}

function isCurrentWorkflowNotification(task: WorkflowBubbleTask, message: PendingCommentMessage) {
  const expectedStatus = workflowNotificationStatus(message.body);
  if (!expectedStatus) return true;
  if (task.status !== expectedStatus) return false;
  return workflowOwnerSlugs(task).has(message.agentSlug);
}

function shouldRenderPendingCommentMessage(args: {
  task: WorkflowBubbleTask;
  message: PendingCommentMessage;
  run?: PendingCommentRun;
  settledMessageIds: Set<string>;
}) {
  const { task, message, run, settledMessageIds } = args;
  if (message.originChannel !== "comment" || message.sender.kind === "agent") {
    return false;
  }

  const isWorkflowNotification = workflowNotificationStatus(message.body) !== null;
  const isCurrentWorkflow = isCurrentWorkflowNotification(task, message);
  if (isWorkflowNotification && !isCurrentWorkflow) return false;

  if (run?.status === "failed") {
    return isWorkflowNotification && isCurrentWorkflow;
  }
  if (run?.status === "completed") return false;
  if (settledMessageIds.has(message.id)) return false;

  return true;
}

function settledAgentSlugsForMessage(
  rows: Array<{ kind: string; payload: string | null; targetAgent?: string | null }>,
  messageId: string,
  runs: Array<{ messageId: string; agentSlug: string; status: string }> = [],
) {
  const slugs = new Set<string>();
  for (const run of runs) {
    if (run.messageId === messageId && run.status === "completed") {
      slugs.add(run.agentSlug);
    }
  }
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as {
        inReplyToMessageId?: unknown;
        messageId?: unknown;
        agentSlug?: unknown;
      };
      const agentSlug =
        typeof row.targetAgent === "string"
          ? row.targetAgent
          : typeof payload.agentSlug === "string"
            ? payload.agentSlug
            : null;
      if (!agentSlug) continue;
      if (
        (row.kind === "task.chat.reply" || row.kind === "task.chat.silent") &&
        payload.inReplyToMessageId === messageId
      ) {
        slugs.add(agentSlug);
      }
    } catch {
      // Ignore old or malformed audit payloads.
    }
  }
  return slugs;
}

function discussionTargetValue(
  principal: { id?: string | null; kind?: string | null; agent?: { slug?: string | null } | null } | null | undefined,
) {
  if (!principal?.id) return null;
  if (principal.kind === "agent" && principal.agent?.slug) return `agent:${principal.agent.slug}`;
  return `user:${principal.id}`;
}

const DEVELOPMENT_TAB = "Development";
const TASK_TABS = ["Description", "Action Plan", "Sub-Tasks", "Attachments", "Comments", "Activities", DEVELOPMENT_TAB, "Changes"] as const;
const OWNER_ONLY_TASK_TABS = new Set(["Action Plan", "Activities", DEVELOPMENT_TAB, "Changes"]);

function tabParam(tab: string) {
  return tab
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tabFromSearchParam(raw: string | undefined, tabs: readonly string[]) {
  if (!raw) return null;
  const normalized = tabParam(raw);
  if (normalized === "discussion") {
    return tabs.find((tab) => tab === "Action Plan") ?? null;
  }
  if (normalized === "deployment") {
    return tabs.find((tab) => tab === DEVELOPMENT_TAB) ?? null;
  }
  return tabs.find((tab) => tabParam(tab) === normalized) ?? null;
}

// ---- Page -----------------------------------------------------------

export default async function TaskDetailPage({
  params,
  searchParams,
  contained = false,
}: {
  params: Promise<{ slug: string; taskId: string }>;
  searchParams: Promise<{ chat?: string; chatArchive?: string; chatRoom?: string; tab?: string; comment?: string; commit?: string; file?: string }>;
  contained?: boolean;
}) {
  const [{ slug, taskId }, { chatArchive = "", chatRoom = "", tab = "", comment: focusedCommentParam = "", commit = "", file = "" }] = await Promise.all([
    params,
    searchParams,
  ]);
  let selectedTab = chatArchive || chatRoom === "current"
    ? "Action Plan"
    : tabFromSearchParam(tab, TASK_TABS) ?? "Description";

  const viewer = await requireActor();
  if (!(await canAccessTask(viewer, taskId))) notFound();

  const [taskShell, comments, attachments] = await Promise.all([
    getCachedTaskDetailShell(taskId),
    getCachedTaskComments(taskId),
    getCachedTaskAttachments(taskId),
  ]);
  const task = taskShell ? { ...taskShell, comments, attachments } : null;
  if (!task || task.project.slug !== slug || task.deletedAt) notFound();
  const actorVisibility = await getActorVisibility(viewer);
  const visibleAttachments = task.attachments.map((attachment) => ({
    ...attachment,
    uploader: !viewer.isOwner && attachment.uploader?.kind === "agent"
      ? (actorVisibility.owner ? { username: actorVisibility.owner.username } : null)
      : attachment.uploader,
  }));
  // Deployment is an optional post-Done step for repo-backed projects, and only
  // for standalone tasks (no epic parent — an epic owns its tasks' deploy gate).
  const hasDeploymentTab =
    canShowDeploymentTab(task) && Boolean(task.project.repositoryPath) && task.status === "Done";
  const showDeploymentTab = viewer.isOwner && hasDeploymentTab;
  const taskTabs = (hasDeploymentTab ? [...TASK_TABS] : TASK_TABS.filter((name) => name !== DEVELOPMENT_TAB))
    .filter((name) => viewer.isOwner || !OWNER_ONLY_TASK_TABS.has(name));
  if (!taskTabs.some((name) => name === selectedTab)) selectedTab = "Description";

  // Comment moderation is exclusive to the Mission Control owner.
  const canDeleteComments = viewer.isOwner;

  const [principals, cachedProjectEpics, mentionableUsers, recentTaskChatMessages, recentReplyActivity, latestRepoVerify, allActivity, targetedCommentRows] = await Promise.all([
    viewer.isOwner ? listAssignablePrincipals(viewer) : Promise.resolve([]),
    getCachedProjectEpics(task.project.id),
    db.user.findMany({ select: { username: true, kind: true } }),
    getCachedRecentTaskChatMessages(task.id),
    getCachedTaskActivity(task.id),
    // Latest monitor-verifier branch row, if any. Used by the Review-state
    // Repo verification panel below.
    getCachedLatestRepoVerifyActivity(task.id),
    db.activityLog.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            kind: true,
            name: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, name: true, avatar: true } },
          },
        },
      },
    }) as Promise<ActivityTimelineRow[]>,
    viewer.isOwner || task.comments.length === 0
      ? Promise.resolve([])
      : db.agentChatMessage.findMany({
          where: { originCommentId: { in: task.comments.map((comment) => comment.id) } },
          distinct: ["originCommentId"],
          select: { originCommentId: true },
        }),
  ]);
  const projectEpics = cachedProjectEpics.filter((epic) => viewer.isOwner || !epic.private);
  const visibleActivity = visibleActivityRows(allActivity, actorVisibility);
  const activeFormalBlocker = activeFormalBlockersByTask(
    allActivity.map((row) => ({ taskId: task.id, kind: row.kind, payload: row.payload, createdAt: row.createdAt })),
    task.comments.map((comment) => ({ id: comment.id, taskId: task.id, createdAt: comment.createdAt })),
  ).get(task.id) ?? null;
  const activeBlockerPermissionGrant = activeFormalBlocker?.commentId
    ? blockerPermissionGrantForComment(allActivity, activeFormalBlocker.commentId)
    : null;

  // Candidate blockers for the "Blocked by" picker: other live tasks in this
  // project. Cycles are rejected server-side on save (lib/tasks/blocking.ts).
  const blockerCandidates = await db.task.findMany({
    where: accessibleTaskWhere(viewer, {
      projectId: task.project.id,
      id: { not: task.id },
      OR: [
        { deletedAt: null, archivedAt: null },
        ...(task.blockedById ? [{ id: task.blockedById }] : []),
      ],
    }),
    orderBy: [{ status: "asc" }, { workItemKey: "asc" }],
    select: { id: true, workItemKey: true, title: true, status: true },
  });
  const currentBlockerVisible = !task.blockedById || blockerCandidates.some((candidate) => candidate.id === task.blockedById);
  const agentUsernames = mentionableUsers.filter((user) => user.kind === "agent").map((user) => user.username);
  const targetedCommentIds = new Set(targetedCommentRows.map((row) => row.originCommentId).filter(Boolean));
  const mentionables = mentionableUsers
    .filter((user) => viewer.isOwner || user.kind !== "agent")
    .map((user) => ({ username: user.username }));
  // Resolved reviewer for role-aware comment identity: the task's acting
  // manager, or the epic's acting manager when the task has none.
  const resolvedReviewerId = task.actingManager?.id ?? task.epic?.actingManagerId ?? null;
  // Body redactor: strips real agent slugs/usernames/names out of member-
  // visible comment bodies (agent comments name each other verbatim, which the
  // author-avatar mask alone does not cover). No-op for the owner.
  const redactBody = buildAgentRedactor(actorVisibility.agentIdentities, actorVisibility.maskAgents);
  const visibleTaskComments = viewer.isOwner
    ? task.comments
    : task.comments.filter((comment) => {
        // Deleted agent comments were fully hidden from members before this
        // change; keep them hidden (the deleted-divider reveal would expose the
        // raw body and the deleting agent's slug).
        if (comment.user.kind === "agent") return !comment.deletedAt;
        // Human comments stay visible, except the owner's PM-instruction
        // comments aimed at an agent (targeted or @agent mention) — those embed
        // real agent slugs in the body, so they remain hidden from members.
        return !(
          comment.user.id === actorVisibility.owner?.id &&
          (targetedCommentIds.has(comment.id) || agentUsernames.some((username) => mentionedUsername(comment.body, username)))
        );
      });
  const focusedCommentId = visibleTaskComments.some((comment) => comment.id === focusedCommentParam)
    ? focusedCommentParam
    : null;
  const settledMessageIds = activityMessageIds(recentReplyActivity);
  const recentCommentMessages = recentTaskChatMessages.filter((message) => (
    message.originChannel === "comment"
    && message.sender.kind !== "agent"
  ));
  const recentCommentRuns = recentCommentMessages.length
    ? await db.pmChannelRun.findMany({
        where: {
          kind: "task-comment",
          taskId: task.id,
          messageId: { in: recentCommentMessages.map((message) => message.id) },
        },
        select: { messageId: true, agentSlug: true, status: true },
      })
    : [];
  const commentRunByTarget = new Map(
    recentCommentRuns.map((run) => [`${run.messageId}:${run.agentSlug}`, run]),
  );
  const pendingCommentMessages = recentCommentMessages
    .filter((message) => shouldRenderPendingCommentMessage({
      task,
      message,
      run: commentRunByTarget.get(`${message.id}:${message.agentSlug}`),
      settledMessageIds,
    }))
    .filter((message, index, all) => all.findIndex((item) => item.agentSlug === message.agentSlug) === index)
    .slice(0, 4);
  const deploymentPullRequests: DeploymentPrRow[] = showDeploymentTab && selectedTab === DEVELOPMENT_TAB
    ? await db.deploymentPullRequest.findMany({
        where: { taskId: task.id },
        orderBy: { updatedAt: "desc" },
        include: { task: { select: { workItemKey: true, title: true } } },
      })
    : [];
  const chatMessages = await getCachedTaskRoomMessages(task.id);
  const taskChatCursorKey = `task:${task.id}`;
  const taskChatReadCursor = await db.chatReadCursor.findUnique({
    where: { userId_agentSlug: { userId: viewer.id, agentSlug: taskChatCursorKey } },
    select: { lastReadAt: true },
  });
  // chatMessages come from unstable_cache, which JSON-revives createdAt as an
  // ISO string; comparing string > Date coerces to NaN (always false), so
  // normalize both sides to epoch ms before comparing the read cursor.
  const taskChatReadCursorMs = taskChatReadCursor ? taskChatReadCursor.lastReadAt.getTime() : null;
  const unreadActionPlanMessages = chatMessages.filter((message) => (
    !message.deletedAt
    && !message.body.startsWith("PM workflow notification for @")
    && message.sender.id !== viewer.id
    && (taskChatReadCursorMs === null || createdAtMs(message.createdAt) > taskChatReadCursorMs)
  ));
  const firstUnreadMessageId = unreadActionPlanMessages[0]?.id ?? null;
  if (selectedTab === "Action Plan" && !chatArchive) {
    await db.chatReadCursor.upsert({
      where: { userId_agentSlug: { userId: viewer.id, agentSlug: taskChatCursorKey } },
      create: { userId: viewer.id, agentSlug: taskChatCursorKey },
      update: { lastReadAt: new Date() },
    });
  }
  const pendingProposals = await getCachedPendingTaskProposals(
    task.id,
    task.projectId,
    chatMessages.map((m) => m.id),
  );
  const pendingDescriptionMessages = await db.agentChatMessage.findMany({
    where: {
      taskId: task.id,
      allowDescriptionEdit: true,
      originChannel: "description",
      editGrantUsedAt: null,
    },
    select: { id: true },
  });
  const pendingDescMsgIds = pendingDescriptionMessages.map((m) => m.id);
  const runningDescriptionRun = pendingDescMsgIds.length > 0
    ? await db.pmChannelRun.findFirst({
        where: {
          taskId: task.id,
          messageId: { in: pendingDescMsgIds },
          status: { in: ["queued", "accepted", "streaming"] },
        },
        select: { messageId: true, agentSlug: true },
      })
    : null;
  const isAiDescriptionRunning = runningDescriptionRun !== null;

  // Draft is requester-bound — anyone viewing the task other than the
  // human who clicked "Ask AI" sees null. The reaper inside
  // getDescriptionDraft() also returns null for stale drafts
  // (lastSeenAt > 60s ago) so a closed-tab requester doesn't leak
  // their draft into a later session.
  const { getDescriptionDraft } = await import("@/lib/description-drafts");
  const draftDescription = await getDescriptionDraft({
    scope: "task",
    targetId: task.id,
    requesterUserId: viewer.id,
  });

  const [[chatArchives, binChatArchives], selectedChatArchive] = await Promise.all([
    getCachedTaskChatArchives(task.project.id, task.id),
    chatArchive
      ? db.agentChatRoomArchive.findFirst({
          where: { id: chatArchive, projectId: task.project.id, taskId: task.id },
          include: {
            messages: {
              orderBy: { createdAt: "asc" },
              include: {
                sender: {
                  select: {
                    id: true,
                    username: true,
                    kind: true,
                    name: true,
                    avatarUpdatedAt: true,
                    agent: { select: { slug: true, name: true, avatar: true } },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve(null),
  ]);
  const visibleChatMessages = selectedChatArchive?.messages ?? chatMessages;
  const visibleActionPlanMessages = visibleChatMessages.filter(
    (message) => !message.body.startsWith("PM workflow notification for @"),
  );
  const activeActionPlanMessageCount = chatMessages.filter(
    (message) => !message.body.startsWith("PM workflow notification for @"),
  ).length;
  const viewingChatArchive = Boolean(selectedChatArchive);
  const selectedChatArchiveDeleted = Boolean(selectedChatArchive?.deletedAt);
  const humanChatMessageIds = chatMessages
    .filter((message) => message.sender.kind !== "agent")
    .map((message) => message.id);
  const completedChatRuns = humanChatMessageIds.length
    ? await db.pmChannelRun.findMany({
        where: {
          kind: "task-chat",
          taskId: task.id,
          messageId: { in: humanChatMessageIds },
          status: "completed",
        },
        select: { messageId: true, agentSlug: true, status: true },
      })
    : [];

  const pendingAgents: Array<{ slug: string; username: string }> = [];
  let pendingChatMessageId: string | null = null;

  if (chatMessages.some((message) => message.sender.kind !== "agent")) {
    const users = await db.user.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        kind: true,
        status: true,
        agent: { select: { slug: true, role: true, deactivatedAt: true, name: true } },
      },
    });

    for (const message of [...chatMessages].reverse()) {
      if (message.sender.kind === "agent") continue;
      const mentions = extractMentions(
        message.body,
        users.map((u) => ({ username: u.username })),
      );
      const targetAgents = new Map<string, { slug: string; username: string }>();
      const addPendingAgent = (u: (typeof users)[number] | null | undefined) => {
        if (
          u &&
          u.kind === "agent" &&
          u.status === "active" &&
          u.agent &&
          !u.agent.deactivatedAt
        ) {
          targetAgents.set(u.agent.slug, {
            slug: u.agent.slug,
            username: u.agent.name || u.username,
          });
        }
      };

      if (message.targetType === "all-coders") {
        for (const u of users) {
          if (u.agent?.role === "coding") addPendingAgent(u);
        }
      } else if (message.targetType === "agent" && message.targetValue?.startsWith("agent:")) {
        const agentSlug = message.targetValue.slice("agent:".length);
        addPendingAgent(users.find((u) => u.agent?.slug === agentSlug));
      } else if (message.targetType === "multi" && message.targetValue) {
        try {
          const targets = JSON.parse(message.targetValue) as unknown;
          if (Array.isArray(targets)) {
            for (const target of targets) {
              if (typeof target !== "string" || !target.startsWith("agent:")) continue;
              const agentSlug = target.slice("agent:".length);
              addPendingAgent(users.find((u) => u.agent?.slug === agentSlug));
            }
          }
        } catch {
          // Ignore malformed historical target payloads.
        }
      } else if (!message.targetType && mentions.length === 0) {
        const candidates = [
          task.actingManager,
          task.assignee,
        ];
        for (const cand of candidates) addPendingAgent(cand);
      }

      for (const u of users) {
        if (mentions.includes(u.username)) {
          addPendingAgent(u);
        }
      }

      const settled = settledAgentSlugsForMessage(recentReplyActivity, message.id, completedChatRuns);
      const stillPending = [...targetAgents.values()].filter((agent) => !settled.has(agent.slug));
      if (stillPending.length > 0) {
        pendingChatMessageId = message.id;
        pendingAgents.push(...stillPending);
        break;
      }
    }
  }

  const discussionTargets = principals.map((p) => ({
    value: p.kind === "agent" && p.agentSlug ? `agent:${p.agentSlug}` : `user:${p.id}`,
    label: p.name,
    group: p.kind === "agent" ? "Agents" as const : "Users" as const,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt,
      agent: p.kind === "agent"
        ? { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar }
        : null,
    },
  }));
  const defaultDiscussionTarget =
    discussionTargetValue(task.actingManager)
    ?? discussionTargetValue(task.assignee)
    ?? null;
  const principalOptions: AvatarComboboxOption[] = principals.map((p) => ({
    value: p.id,
    label: p.name,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt,
      agent: p.kind === "agent"
        ? { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar }
        : null,
    },
  }));
  const visibleReporter = serializeActor(task.reporter, actorVisibility);
  const visibleAssignee = serializeVisibleActorAs(task.assignee, "assignee", actorVisibility);
  const visibleReviewer = serializeVisibleActorAs(task.actingManager, "reviewer", actorVisibility);
  const visibleApprover = serializeActor(task.approvedBy, actorVisibility);
  const showApproverAvatar = Boolean(
    task.approvedOn &&
    visibleApprover &&
    task.approvedById !== task.actingManagerId
  );
  const effectiveDeploymentStatus = task.epic?.deploymentStatus
    ?? (task.parentTaskId ? "Not applicable" : task.deploymentStatus);
  const reporterOptions = task.reporter && visibleReporter && !principals.some((p) => p.id === task.reporterId)
    ? [
        ...principalOptions,
        {
          value: task.reporter.id,
          label: actorDisplayName(visibleReporter),
          actor: visibleReporter,
        },
      ]
      : principalOptions;
  const aiTargetOptions: AvatarComboboxOption[] = principals.flatMap((p) => {
    if (p.kind !== "agent" || !p.agentSlug) return [];
    return [{
      value: `agent:${p.agentSlug}`,
      label: p.name,
      actor: {
        id: p.id,
        username: p.username,
        kind: p.kind,
        name: p.name,
        avatarUpdatedAt: p.avatarUpdatedAt,
        agent: { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar },
      },
    }];
  });
  const defaultAiTarget = [
    discussionTargetValue(task.actingManager),
    discussionTargetValue(task.assignee),
  ].find((value) => Boolean(value?.startsWith("agent:") && aiTargetOptions.some((option) => option.value === value)))
    ?? aiTargetOptions[0]?.value
    ?? "";
  const canApproveActionPlan =
    !task.approvedOn &&
    (viewer.kind === "human" || canApproveActionPlanForActor(task, viewer.id));
  const doneActivity = allActivity.find((row) =>
    row.kind === "task.move" && payloadValue(row.payload, "to") === "Done"
  );
  const createdActivity = [...visibleActivity].reverse().find((row) => row.kind === "task.create");
  const updatedActivity = allActivity.find((row) => (
    row.kind === "task.update" ||
    row.kind === "task.move" ||
    row.kind === "task.ack.auto" ||
    row.kind === "task.assign" ||
    row.kind === "task.acting_manager" ||
    row.kind === "task.privacy" ||
    row.kind === "task.epic" ||
    row.kind === "task.blocked_by" ||
    row.kind === "task.branch" ||
    row.kind === "task.commit_prefix" ||
    row.kind === "task.deployment_status" ||
    row.kind === "task.reporter" ||
    row.kind === "task.alert_reporter" ||
    row.kind === "task.archive" ||
    row.kind === "task.unarchive" ||
    row.kind === "task.auto_archive" ||
    row.kind === "task.restore" ||
    row.kind === "task.action_plan.approve" ||
    row.kind === "task.action_plan.reset"
  ));
  const visibleUpdatedActor = updatedActivity
    ? serializeVisibleActor(updatedActivity.user, actorVisibility)
    : createdActivity?.user ?? null;
  const visibleDoneActor = serializeVisibleActor(doneActivity?.user ?? null, actorVisibility);
  const doneAt = doneActivity?.createdAt
    ?? (task.status === "Done" ? task.statusChangedAt : null);
  const changeWindows = taskWorkWindows(allActivity, {
    status: task.status,
    statusChangedAt: task.statusChangedAt,
  });
  const taskBranchName = effectiveTaskBranchName(task);
  const taskCommitPrefix = effectiveTaskCommitPrefix(task);
  const taskChangeCommitPrefixes = uniqueStrings([
    taskCommitPrefix,
    task.workItemKey,
  ]);
  const taskChanges = selectedTab === "Changes"
    ? await getTaskGitChanges({
        repositoryPath: task.project.repositoryPath,
        branchName: taskBranchName,
        commitPrefix: taskChangeCommitPrefixes,
        windows: changeWindows,
      })
    : { commits: [], ref: null, error: null };
  const selectedDiff = selectedTab === "Changes"
    ? await getTaskGitFileDiff({
        repositoryPath: task.project.repositoryPath,
        commitHash: commit,
        filePath: file,
      })
    : null;

  async function reorderChecklist(orderedIds: string[]): Promise<void> {
    "use server";
    const ctx = await resolveChecklistContext(taskId, slug);
    if (!ctx) return;
    await reorderSubTaskItems({ taskId, orderedIds });
    revalidateChecklist(slug, taskId, ctx.task.projectId);
  }

  return (
    <StickyViewportSurface kind="task-detail" contained={contained}>
    <TaskDirtyGuard>
    <div data-task-quick-add-context className="mx-auto w-full max-w-none">
      {/* ----- Main column ------------------------------------------- */}
      <div className="min-w-0">
        <section className={`space-y-section-gap border border-line bg-panel p-card-lg shadow-sm ${contained ? "rounded-b-panel rounded-t-none border-t-0" : "rounded-panel"}`}>
          {/* Sticky one-row editor header: title, epic and save stay visible. */}
          <div
            data-detail-header
            data-task-header
            className={`relative sticky top-[var(--detail-sticky-top)] z-20 -mx-5 -mt-5 flex flex-wrap items-end gap-3 border-b border-line bg-panel px-5 py-2 shadow-sm xl:flex-nowrap ${contained ? "" : "rounded-t-2xl"}`}
          >
            <label className="min-w-[18rem] flex-1">
              <span className="mb-0.5 block text-nano font-semibold uppercase tracking-wider text-text-muted">
                Task title
                {task.workItemKey ? (
                  <span className="ml-2 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-nano text-text-muted">
                    {task.workItemKey}
                  </span>
                ) : null}
              </span>
              <input
                form="taskMain"
                name="title"
                defaultValue={task.title}
                required
                maxLength={200}
                className="h-9 w-full rounded-lg border border-transparent bg-transparent px-2 text-heading font-semibold tracking-tight outline-none transition focus:border-line focus:bg-bg"
                aria-label="Task title"
              />
            </label>
            {/* The close button only exists ultra-wide. Contained, the pane's
                own × sits on this corner, so reserve room for it; canonical, the
                form's button overhangs outside and needs none. */}
            <div className={`flex shrink-0 flex-col items-end gap-0.5 ${contained ? "4xl:pr-12" : ""}`}>
              <span className="text-nano font-semibold uppercase tracking-wider text-text-muted">
                Updated{" "}
                <time dateTime={dateIso(task.updatedAt) ?? undefined} title={dateIso(task.updatedAt) ?? undefined}>
                  {timeAgo(task.updatedAt)}
                </time>
              </span>
              <div className="flex items-center gap-2">
                <button
                  form="taskMain"
                  type="submit"
                  className="h-9 rounded-lg bg-accent px-3 text-body font-medium text-bg hover:opacity-90"
                >
                  Save changes
                </button>
                {/* Canonical (full-page) task: the form owns its overhang close
                    button. In the split pane the pane owns it (see
                    WorkspacePane), so the form renders none. */}
                {!contained ? <CloseTaskButton slug={slug} /> : null}
              </div>
            </div>
          </div>
          {task.repositoryRun ? (
            <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
              <span className="rounded-full border border-line bg-surface-muted px-2 py-1 font-semibold uppercase tracking-wide text-text">
                Repository: {task.repositoryRun.phase.replaceAll("_", " ")}
              </span>
              {task.repositoryRun.validationOutcome ? (
                <span>validation: {task.repositoryRun.validationOutcome.replaceAll("_", " ")}</span>
              ) : null}
              {task.repositoryRun.candidateSha ? (
                <span>candidate <code className="text-text">{task.repositoryRun.candidateSha.slice(0, 10)}</code></span>
              ) : null}
            </div>
          ) : null}

          {/* Review verification panel. Status changes only after the monitor
              gate, while repositoryRun exposes validating/finalizing errors. */}
          {task.status === "Review" && taskBranchName ? (() => {
            const branchName = taskBranchName;
            const commitPrefix = taskCommitPrefix;
            let kind: string | null = latestRepoVerify?.kind ?? null;
            let payload: { headSha?: string | null; matchSha?: string | null; branchName?: string | null; fetchError?: string | null; logError?: string | null } = {};
            try {
              payload = latestRepoVerify?.payload ? JSON.parse(latestRepoVerify.payload) : {};
            } catch { /* ignore */ }
            const fetchAuthError = Boolean(
              payload.fetchError &&
              /(?:unauthorized|permission denied|could not read from remote|access rights|repository not found)/i.test(payload.fetchError),
            );
            const tone =
              kind === "pm.repo.verify.ok" ? "ok" :
              kind === "pm.repo.verify.warning" ? "warning" :
              kind === "pm.repo.verify.fail" ? "fail" :
              kind === "pm.repo.verify.operational_error" ? "operational" :
              kind === "pm.repo.verify.enqueue" ? "pending" :
              "missing";
            const palette = {
              ok:      { border: "var(--color-line)", bg: "rgba(34,197,94,0.08)",  dot: "#22c55e", title: "✓ origin verified" },
              warning: { border: "var(--color-line)", bg: "rgba(245,158,11,0.10)", dot: "#f59e0b", title: "⚠ verified with advisory warning" },
              fail:    { border: "var(--color-line)", bg: "rgba(239,68,68,0.10)",  dot: "#ef4444", title: "⚠ origin not verified" },
              operational: { border: "var(--color-line)", bg: "rgba(168,85,247,0.10)", dot: "#a855f7", title: "⚙ verifier operational error" },
              pending: { border: "var(--color-line)", bg: "rgba(59,130,246,0.08)", dot: "#3b82f6", title: "... monitor verifier running" },
              missing: { border: "var(--color-line)", bg: "rgba(148,163,184,0.10)", dot: "#94a3b8", title: "Repo verification not yet requested" },
            }[tone];
            return (
              <div
                className="rounded-lg border px-4 py-3 text-body"
                style={{ borderColor: palette.border, backgroundColor: palette.bg }}
              >
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette.dot }} aria-hidden="true" />
                  <strong className="text-text">{palette.title}</strong>
                  <span className="ml-auto text-caption text-text-muted">
                    branch <code className="text-text">{branchName}</code>
                    {commitPrefix ? <> · prefix <code className="text-text">{commitPrefix}</code></> : null}
                  </span>
                </div>
                <div className="mt-1 text-caption text-text-muted">
                  {tone === "ok" && payload.headSha
                    ? <>HEAD <code className="text-text">{payload.headSha.slice(0, 10)}</code> matches the COMMIT_PREFIX — safe to review.</>
                    : null}
                  {tone === "warning"
                    ? <>Repository checks passed with an advisory description mismatch. Read the Monitor Agent comment and decide whether to accept the update.</>
                    : null}
                  {tone === "operational"
                    ? <>The branch was not rejected. PM kept the current task status, did not notify the reviewer, and requires operator recovery.</>
                    : null}
                  {tone === "fail"
                    ? fetchAuthError
                      ? <>{payload.fetchError ? <>fetch failed: <code className="text-text">{payload.fetchError}</code>.</> : null} This is a monitor verifier repository-access problem. Fix the verifier credentials and retry; do not ask the assignee to repush solely for this error.</>
                      : <>{payload.fetchError ? <>fetch failed: <code className="text-text">{payload.fetchError}</code>.</> : null} See the latest <code className="text-text">pm.repo.verify.fail</code> comment below. Ask the assignee to push or fix the commit prefix before reviewing.</>
                    : null}
                  {tone === "pending"
                    ? <>The monitor verifier has been asked to verify <code className="text-text">origin/{branchName}</code>. The result will appear as a new task comment.</>
                    : null}
                  {tone === "missing"
                    ? <>No <code className="text-text">pm.repo.verify.*</code> activity yet — either the task pre-dates the verifier, or the assignee declared <code className="text-text">repoTouched: false</code> on ready_for_review.</>
                    : null}
                </div>
              </div>
            );
          })() : null}

          {/* One edit form for the whole card: every control below carries
              form="taskMain" so the single "Save changes" button persists
              Epic, Status, Title, Description, Branch, Commit Prefix,
              Assignee and Reviewer together. The form element itself is
              empty so the tab panels' own forms (sub-task/comment/upload)
              are never nested inside it. */}
          <form id="taskMain" action={updateTask} />
          <input form="taskMain" type="hidden" name="taskId" value={task.id} />
          <input form="taskMain" type="hidden" name="projectSlug" value={slug} />
          {/* Tabbed content */}
          <TabsProvider defaultTab={selectedTab}>
            <TabsNav
              tabs={taskTabs}
              sticky
              badges={viewer.isOwner ? { "Action Plan": unreadActionPlanMessages.length } : undefined}
            />
            <div className="pt-4">
              <TabPanel name="Description">
                <div className="grid gap-card xl:grid-cols-[minmax(0,1fr)_20rem] 4xl:grid-cols-[minmax(0,1fr)_24rem]">
                  <DescriptionField
                    formId="taskMain"
                    previewHtml={renderFullMarkdown(task.description ?? "").__html}
                    defaultValue={task.description ?? ""}
                    projectSlug={slug}
                    taskId={task.id}
                    aiTargets={viewer.isOwner ? aiTargetOptions : []}
                    defaultAiTarget={viewer.isOwner ? defaultAiTarget : ""}
                    descriptionLabel="Task"
                    draftDescription={draftDescription}
                    aiRunning={viewer.isOwner && isAiDescriptionRunning}
                    runningMessageId={viewer.isOwner ? runningDescriptionRun?.messageId ?? null : null}
                    runningAgentSlug={viewer.isOwner ? runningDescriptionRun?.agentSlug ?? null : null}
                    // Sub-tasks (parentTaskId !== null) get a taller editor —
                    // they're where most of the day-to-day work detail lands,
                    // so the larger box matches actual use (HOMELAB-48).
                    rows={task.parentTaskId !== null ? 24 : 12}
                  />

                  <aside className="space-y-section-gap xl:sticky xl:top-[calc(var(--detail-sticky-top)+var(--detail-header-height)+var(--detail-tabs-height)+1rem)] xl:self-start">
                    {/* Status + Private widget */}
                    <div data-task-status-private className="flex items-end gap-3">
                      <label className="min-w-0 flex-1">
                        <span className="mb-0.5 block text-nano font-semibold uppercase tracking-wider text-text-muted">
                          Status
                        </span>
                        <select
                          form="taskMain"
                          name="status"
                          defaultValue={task.status}
                          className="h-9 w-full rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
                          aria-label="Status"
                        >
                          {COLUMN_IDS.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                      </label>
                      {viewer.isOwner ? (
                        <PrivateToggle
                          formId="taskMain"
                          defaultChecked={task.private}
                          includeSubmittedField
                        />
                      ) : null}
                    </div>

                    <div
                      data-task-roles
                      className="grid grid-cols-2 gap-3 rounded-card border border-line bg-panel-soft p-card"
                    >
                      <div data-task-role className="min-w-0">
                        <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Reported by</span>
                        {viewer.isOwner ? (
                          <AvatarCombobox formId="taskMain" name="reporterId" defaultValue={task.reporterId ?? ""} options={reporterOptions} emptyLabel="No reporter" ariaLabel="Reported by" />
                        ) : (
                          <div className="flex min-h-9 items-center gap-2 rounded-lg border border-line bg-bg px-2 text-caption">
                            {visibleReporter ? <MessageAvatar actor={visibleReporter} size="sm" /> : null}
                            <span className="truncate">{visibleReporter ? actorDisplayName(visibleReporter) : "No reporter"}</span>
                          </div>
                        )}
                      </div>
                      <div data-task-role className="min-w-0">
                        <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Assignee</span>
                        {viewer.isOwner ? (
                          <AvatarCombobox formId="taskMain" name="assigneeId" defaultValue={task.assigneeId ?? ""} options={principalOptions} emptyLabel="Unassigned" ariaLabel="Assignee" />
                        ) : (
                          <div className="flex min-h-9 items-center gap-2 rounded-lg border border-line bg-bg px-2 text-caption">
                            {visibleAssignee ? <MessageAvatar actor={visibleAssignee} size="sm" /> : null}
                            <span className="truncate">{visibleAssignee ? actorDisplayName(visibleAssignee) : "Unassigned"}</span>
                          </div>
                        )}
                      </div>
                      <div data-task-role className="min-w-0">
                        <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Reviewer</span>
                        {viewer.isOwner ? (
                          <AvatarCombobox formId="taskMain" name="actingManagerId" defaultValue={task.actingManagerId ?? ""} options={principalOptions} emptyLabel="No reviewer" ariaLabel="Reviewer" />
                        ) : (
                          <div className="flex min-h-9 items-center gap-2 rounded-lg border border-line bg-bg px-2 text-caption">
                            {visibleReviewer ? <MessageAvatar actor={visibleReviewer} size="sm" /> : null}
                            <span className="truncate">{visibleReviewer ? actorDisplayName(visibleReviewer) : "No reviewer"}</span>
                          </div>
                        )}
                      </div>
                      <div data-task-role className="min-w-0">
                        <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Approved date</span>
                        <div data-task-approved className="flex min-h-9 items-center gap-2 rounded-lg border border-line bg-bg px-2 text-caption">
                          {showApproverAvatar && visibleApprover ? (
                            <MessageAvatar actor={visibleApprover} size="sm" />
                          ) : null}
                          <time
                            dateTime={dateIso(task.approvedOn) ?? undefined}
                            title={dateIso(task.approvedOn) ?? undefined}
                            className="min-w-0 flex-1 break-words text-[0.68rem] leading-tight tabular-nums"
                          >
                            {task.approvedOn ? timeAgo(task.approvedOn) : "—"}
                          </time>
                        </div>
                      </div>
                    </div>

                    {/* Branch, commit prefix, and deployment — persisted by the card's single Save. */}
                    <div data-task-source-control className="space-y-3 rounded-card border border-line bg-panel-soft p-card">
                      <label className="block">
                        <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">
                          Branch
                        </span>
                        <input
                          form="taskMain"
                          name="branchName"
                          defaultValue={task.branchName ?? ""}
                          maxLength={200}
                          placeholder={taskBranchName ? `inherits/defaults to ${taskBranchName}` : "e.g. feature/HOMELAB-99"}
                          className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption font-mono outline-none focus:border-accent"
                          aria-label="Branch name"
                        />
                      </label>
                      <div data-task-commit-deployment className="grid grid-cols-2 gap-3">
                        <label className="block min-w-0">
                          <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">
                            Commit prefix
                          </span>
                          <input
                            form="taskMain"
                            name="commitPrefix"
                            defaultValue={task.commitPrefix ?? ""}
                            maxLength={200}
                            placeholder={taskCommitPrefix ? `inherits/defaults to ${taskCommitPrefix}` : "e.g. HOMELAB-99"}
                            className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption font-mono outline-none focus:border-accent"
                            aria-label="Commit prefix"
                          />
                        </label>
                        <div className="min-w-0">
                          {hasDeploymentTab ? (
                            <DeploymentStatusSelect formId="taskMain" defaultValue={task.deploymentStatus} />
                          ) : (
                            <div>
                              <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Deployment status</span>
                              <div className="flex min-h-9 items-center rounded-lg border border-line bg-bg px-2 text-caption text-text-muted">
                                {effectiveDeploymentStatus}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Epic picker moved from header to sidebar */}
                    <div className="min-w-0">
                      <span className="mb-0.5 block text-nano font-semibold uppercase tracking-wider text-text-muted">
                        Epic
                      </span>
                      <TaskEpicPicker
                        formId="taskMain"
                        name="epicId"
                        projectSlug={slug}
                        defaultValue={task.epicId ?? ""}
                        epics={projectEpics}
                      />
                    </div>

                    {/* Execution state (ENV-123) — what PM believes is actually
                        happening on this task right now, and what the watchdog
                        did about it. Sits above "Blocked by" because a blocked
                        task is a subset of "not executing". */}
                    <TaskExecutionStrip executionState={task.executionState} />

                    {/* Blocked by — hard dependency on another task (ENV-62). */}
                    {currentBlockerVisible ? <div className="space-y-1 rounded-card border border-line bg-panel-soft p-card">
                      <label className="block">
                        <span className="mb-1 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wider text-text-muted">
                          <LockIcon />
                          Blocked by
                        </span>
                        <select
                          form="taskMain"
                          name="blockedById"
                          defaultValue={task.blockedById ?? ""}
                          aria-label="Blocked by"
                          className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption outline-none focus:border-accent"
                        >
                          <option value="">Not blocked</option>
                          {blockerCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {(candidate.workItemKey ? `${candidate.workItemKey} — ` : "") + candidate.title} ({candidate.status})
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="text-nano text-text-muted">
                        This task waits until the chosen task is Done. Circular blocks are rejected.
                      </p>
                    </div> : null}

                    <div data-task-actions className="grid grid-cols-2 gap-3">
                      <form
                        action={task.archivedAt ? unarchiveTask : archiveTask}
                        className="flex h-full flex-col gap-2 rounded-card border border-line bg-panel-soft p-card"
                      >
                        <input type="hidden" name="taskId" value={task.id} />
                        <input type="hidden" name="projectSlug" value={slug} />
                        <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                          Archive
                        </div>
                        <p className="flex-1 text-caption text-text-muted">
                          {task.archivedAt
                            ? "Restore this task to active project views without changing its status."
                            : "Hide this task from active boards and grids without changing its status."}
                        </p>
                        <button
                          type="submit"
                          className="mt-auto w-full rounded-lg border border-line bg-transparent px-control-x py-control-y text-caption font-medium text-text hover:border-accent hover:text-accent"
                        >
                          {task.archivedAt ? "Restore from archive" : "Archive task"}
                        </button>
                      </form>

                      {/* Danger zone — soft delete moves the task (and any sub-tasks)
                          to the bin for 7 days, then hard-deletes. */}
                      <form
                        action={deleteTask}
                        className="flex h-full flex-col gap-2 rounded-card border border-line bg-panel-soft p-card"
                      >
                        <input type="hidden" name="taskId" value={task.id} />
                        <input type="hidden" name="projectSlug" value={slug} />
                        <div className="text-micro font-semibold uppercase tracking-wider text-crit">
                          Danger zone
                        </div>
                        <p className="flex-1 text-caption text-text-muted">
                          Move this task to the bin. Its {task.checklist.length} checklist
                          item{task.checklist.length === 1 ? "" : "s"} go with it.
                          Auto-purged after 7 days.
                        </p>
                        <button
                          type="submit"
                          className="mt-auto w-full rounded-lg border border-crit bg-transparent px-control-x py-control-y text-caption font-medium text-crit hover:bg-crit hover:text-on-crit"
                        >
                          Delete task
                        </button>
                      </form>
                    </div>

                    {/* Dates — no border/background, each date on its own row with avatar+username+timestamp */}
                    <dl data-task-dates className="space-y-2 text-caption">
                      <div data-task-date className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-micro uppercase tracking-wider text-text-muted">Created by</span>
                        {createdActivity?.user ? (
                          <MessageAvatar actor={createdActivity.user} size="sm" />
                        ) : visibleReporter ? (
                          <MessageAvatar actor={visibleReporter} size="sm" />
                        ) : (
                          <span aria-hidden="true" className="h-6 w-6 shrink-0 rounded-full bg-bg-elev" />
                        )}
                        <span className="truncate text-text-muted">
                          {createdActivity?.user ? actorDisplayName(createdActivity.user) : visibleReporter ? actorDisplayName(visibleReporter) : "Unknown"}
                        </span>
                        <time
                          dateTime={dateIso(task.createdAt) ?? undefined}
                          title={dateIso(task.createdAt) ?? undefined}
                          className="ml-auto tabular-nums text-text-muted"
                        >
                          {timeAgo(task.createdAt)}
                        </time>
                      </div>
                      <div data-task-date className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-micro uppercase tracking-wider text-text-muted">Last updated by</span>
                        {visibleUpdatedActor ? (
                          <MessageAvatar actor={visibleUpdatedActor} size="sm" />
                        ) : (
                          <span aria-hidden="true" className="h-6 w-6 shrink-0 rounded-full bg-bg-elev" />
                        )}
                        <span className="truncate text-text-muted">
                          {visibleUpdatedActor ? actorDisplayName(visibleUpdatedActor) : "Unknown"}
                        </span>
                        <time
                          dateTime={dateIso(task.updatedAt) ?? undefined}
                          title={dateIso(task.updatedAt) ?? undefined}
                          className="ml-auto tabular-nums text-text-muted"
                        >
                          {timeAgo(task.updatedAt)}
                        </time>
                      </div>
                      <div data-task-date className="flex items-center gap-2">
                        <span className="w-28 shrink-0 text-micro uppercase tracking-wider text-text-muted">Completed by</span>
                        {visibleDoneActor ? (
                          <MessageAvatar actor={visibleDoneActor} size="sm" />
                        ) : (
                          <span aria-hidden="true" className="h-6 w-6 shrink-0 rounded-full bg-bg-elev" />
                        )}
                        <span className="truncate text-text-muted">
                          {visibleDoneActor ? actorDisplayName(visibleDoneActor) : "—"}
                        </span>
                        <time
                          dateTime={dateIso(doneAt) ?? undefined}
                          title={dateIso(doneAt) ?? undefined}
                          className="ml-auto tabular-nums text-text-muted"
                        >
                          {doneAt ? timeAgo(doneAt) : "—"}
                        </time>
                      </div>
                    </dl>
                  </aside>
                </div>
              </TabPanel>


              {viewer.isOwner ? <TabPanel name="Action Plan">
                <div className="space-y-3 pt-2">
                  <div
                    data-structured-action-plan-status
                    className={`rounded-card border p-card text-caption ${
                      task.actionPlan
                        ? "border-line bg-panel-soft text-text-muted"
                        : "border-warn/50 bg-warn/10 text-warn"
                    }`}
                  >
                    {task.actionPlan
                      ? `Structured plan v${task.actionPlan.version} is ${task.actionPlan.status}. The messages below are its discussion and review history.`
                      : "No structured Action Plan has been submitted. Messages below are discussion only and cannot be approved until the assignee calls action=submit_plan."}
                  </div>
                  {canApproveActionPlan ? (
                    <form action={approveTaskActionPlan} className="flex justify-end">
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <button
                        type="submit"
                        className="rounded-lg bg-accent px-control-x py-control-y text-caption font-medium text-bg hover:opacity-90"
                      >
                        Approve Plan
                      </button>
                    </form>
                  ) : null}
                  <ChatRoom
                    projectSlug={slug}
                    taskId={task.id}
                    messages={visibleActionPlanMessages}
                    activeMessageCount={activeActionPlanMessageCount}
                    archives={chatArchives}
                    binArchives={binChatArchives}
                    selectedArchiveId={selectedChatArchive?.id ?? null}
                    selectedArchiveDeleted={selectedChatArchiveDeleted}
                    viewingArchive={viewingChatArchive}
                    discussionTargets={discussionTargets}
                    defaultDiscussionTarget={defaultDiscussionTarget}
                    pendingAgents={pendingAgents}
                    latestMessageId={viewingChatArchive ? null : pendingChatMessageId}
                    firstUnreadMessageId={firstUnreadMessageId}
                    currentUserId={viewer.id}
                    currentUsername={viewer.username}
                    pendingProposals={pendingProposals}
                  />
                </div>
              </TabPanel> : null}

              <TabPanel name="Sub-Tasks">
                <TaskChecklist
                  taskId={task.id}
                  projectSlug={slug}
                  taskStatus={task.status}
                  items={task.checklist.map((item) => ({
                    id: item.id,
                    text: item.text,
                    // task shell comes through unstable_cache, which JSON-revives
                    // completedAt as an ISO string; dateIso handles Date|string.
                    completedAt: dateIso(item.completedAt),
                    minutesSpent: item.minutesSpent ?? null,
                    kind: item.kind === "review" ? ("review" as const) : ("implementation" as const),
                  }))}
                  addAction={addSubTaskItem}
                  toggleAction={toggleSubTaskItem}
                  removeAction={removeSubTaskItem}
                  reorderAction={reorderChecklist}
                />
              </TabPanel>

              <TabPanel name="Attachments">
                <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-body font-semibold tracking-wide text-text">
              Attachments
            </h2>
            <span className="text-caption text-text-muted">
              Max {formatBytes(attachmentMaxBytes())} per file
            </span>
          </div>
          <AttachmentList
            attachments={visibleAttachments}
            projectSlug={slug}
            deleteAction={deleteAttachment}
          />

                </div>
              </TabPanel>

              <TabPanel name="Comments">
                <div className="flex h-[calc(100dvh-14rem)] min-h-[560px] flex-col">
                  <h2 className="mb-3 text-body font-semibold tracking-wide text-text">
                    Comments
                  </h2>
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {focusedCommentId ? <FocusTaskComment commentId={focusedCommentId} /> : null}
          {visibleTaskComments.length === 0 ? (
            <p className="text-caption text-text-muted">
              No comments yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {visibleTaskComments.map((c, index) => {
                const parsedPmOptions = parsePmOptions(c.body);
                const mentionedCurrentUser = mentionedUsername(c.body, viewer.username);
                const resolvedPmOption = findPmOptionResolution(
                  parsedPmOptions.options,
                  visibleTaskComments.slice(index + 1).filter((later) => !later.deletedAt).map((later) => later.body),
                );
                if (c.deletedAt) {
                  // Soft-deleted (HOMELAB-41 / item 2): render as a
                  // collapsed dotted divider with the original body
                  // hidden behind a [+] toggle. Humans can restore via
                  // the ↺ button (only shown when canDeleteComments).
                  // Agent context never sees deleted bodies.
                  return (
                    <li
                      key={c.id}
                      id={`task-comment-${c.id}`}
                      tabIndex={-1}
                      className={focusedCommentId === c.id ? "scroll-mt-6 rounded-card ring-2 ring-crit/60" : "scroll-mt-6"}
                    >
                      <DeletedMessageDivider
                        deletedAt={c.deletedAt}
                        deletedBy={c.deletedBy}
                        restore={canDeleteComments ? {
                          action: restoreComment,
                          fields: { commentId: c.id, taskId: task.id, projectSlug: slug },
                        } : undefined}
                      >
                        {renderCommentBody(redactBody(c.body), mentionables)}
                      </DeletedMessageDivider>
                    </li>
                  );
                }
                const commentAuthor = serializeVisibleActorAs(
                  c.user,
                  c.user.id === resolvedReviewerId ? "reviewer" : "assignee",
                  actorVisibility,
                )!;
                const authorRole = syntheticRoleMeta(commentAuthor);
                return (
                  <li
                    key={c.id}
                    id={`task-comment-${c.id}`}
                    tabIndex={-1}
                    className={`scroll-mt-6 flex items-start gap-3 rounded-card text-body outline-none transition-shadow ${focusedCommentId === c.id ? "ring-2 ring-crit/60 ring-offset-2 ring-offset-panel" : ""}`}
                  >
                    <MessageAvatar actor={commentAuthor} size="sm" />
                    <div className={`min-w-0 flex-1 rounded-card border border-line px-3 py-2 ${authorRole?.accentClass ?? ""} ${mentionedCurrentUser ? "bg-yellow-400/[0.12]" : "bg-panel-soft"}`}>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <strong className="truncate font-medium text-text">
                            {actorDisplayName(commentAuthor)}
                          </strong>
                          {authorRole ? (
                            <span className={`rounded-full px-2 py-0.5 text-nano font-semibold uppercase tracking-wide ${authorRole.chipClass}`}>
                              {authorRole.label}
                            </span>
                          ) : null}
                          {c.isGenerated ? (
                            <span className="rounded-full border border-line bg-bg-elev px-2 py-0.5 text-nano font-semibold uppercase tracking-wide text-text-muted">
                              System
                            </span>
                          ) : null}
                          {c.provider && c.model ? (
                            <span className="rounded-full border border-line bg-bg-elev px-2 py-0.5 text-nano font-medium text-text-muted" title={`${c.provider}/${c.model}`}>
                              {c.provider}/{c.model}
                            </span>
                          ) : null}
                          <MessageTimestamp value={c.createdAt} />
                        </div>
                        {canDeleteComments ? (
                          <ConfirmedDeleteButton
                            action={deleteComment}
                            fields={{ commentId: c.id, taskId: task.id, projectSlug: slug }}
                            title="Delete comment"
                            description="The comment will be hidden behind a collapsed dotted divider that humans can expand. Agents will never see it in their context again."
                            confirmLabel="Delete comment"
                            buttonTitle="Delete comment"
                            ariaLabel="Delete comment"
                          />
                        ) : null}
                      </div>
                      <div>{renderCommentBody(redactBody(parsedPmOptions.body), mentionables)}</div>
                      {parsedPmOptions.options.length > 0 ? (
                        <PmOptions
                          projectSlug={slug}
                          sourceMessageId={c.id}
                          surface="task-comment"
                          options={parsedPmOptions.options}
                          resolvedOption={resolvedPmOption}
                          interactive={viewer.isOwner && isPmOptionsTargetedAtCurrentUser({ currentUserId: viewer.id })}
                        />
                      ) : null}
                      {activeFormalBlocker?.commentId === c.id && activeFormalBlocker.permissionRequest ? (
                        <div
                          data-blocker-permission-action
                          className="mt-3 border-t border-crit/20 pt-3"
                        >
                          <p className="text-caption font-semibold text-crit">Reporter permission required</p>
                          <p className="mt-1 text-caption text-text-muted">
                            {activeFormalBlocker.permissionRequest.scope}
                          </p>
                          {activeBlockerPermissionGrant ? (
                            <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-caption font-semibold text-ok">
                              Permission granted — the assignee has been notified.
                            </p>
                          ) : viewer.id === task.reporterId && (
                            activeFormalBlocker.permissionRequest.kind !== "publish_checkpoint" || viewer.isOwner
                          ) ? (
                            <form action={grantBlockerPermission} className="mt-2">
                              <input type="hidden" name="taskId" value={task.id} />
                              <input type="hidden" name="projectSlug" value={slug} />
                              <input type="hidden" name="blockerCommentId" value={c.id} />
                              <button
                                type="submit"
                                className="rounded-lg bg-crit px-control-x py-control-y text-caption font-semibold text-on-crit shadow-[var(--shadow-xs)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crit/60"
                              >
                                Grant requested permission
                              </button>
                            </form>
                          ) : (
                            <p className="mt-2 text-caption text-text-muted">
                              {activeFormalBlocker.permissionRequest.kind === "publish_checkpoint"
                                ? "The task reporter must also be the active Mission Control owner to grant checkpoint publication."
                                : "Waiting for the task reporter to grant this permission."}
                            </p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <TaskCommentStreams
            taskId={task.id}
            messages={(viewer.isOwner ? pendingCommentMessages : []).map((message) => ({
              id: message.id,
              agentSlug: message.agentSlug,
            }))}
          />
          {!focusedCommentId && (visibleTaskComments.length > 0 || (viewer.isOwner && pendingCommentMessages.length > 0)) ? (
            <AutoScrollToLatest
              whenTab="Comments"
              watchKey={[
                visibleTaskComments.length,
                visibleTaskComments.at(-1)?.id ?? "",
                viewer.isOwner ? pendingCommentMessages.map((message) => message.id).join(",") : "",
              ].join(":")}
            />
          ) : null}
                  </div>
                </div>
              </TabPanel>

              {viewer.isOwner ? <TabPanel name="Activities">
                <div className="pt-2">
                  <ActivityTimeline rows={visibleActivity} />
                </div>
              </TabPanel> : null}

              {showDeploymentTab ? (
                <TabPanel name={DEVELOPMENT_TAB}>
                  <DeploymentTab
                    mode="task"
                    title={task.title}
                    deploymentStatus={task.deploymentStatus}
                    branchName={taskBranchName}
                    commitPrefix={taskCommitPrefix}
                    productionBranch={task.project.deploymentProductionBranch}
                    rows={deploymentPullRequests}
                    canAct={(row) => canShowDeploymentAction({
                      provider: row.provider,
                      viewerKind: viewer.kind,
                      viewerId: viewer.id,
                      reporterId: task.reporterId,
                      reviewerId: task.actingManagerId,
                      onlyReportersCanApprovePullRequests: task.project.onlyReportersCanApprovePullRequests,
                    })}
                    approveLocalChangesAction={approveDeploymentLocalChanges}
                    approveAndMergeAction={approveAndMergeDeploymentPullRequest}
                  />
                </TabPanel>
              ) : null}

              {viewer.isOwner ? <TabPanel name="Changes">
                <TaskChangesPanel
                  changes={taskChanges}
                  branchName={taskBranchName}
                  commitPrefix={taskCommitPrefix}
                  commitPrefixes={taskChangeCommitPrefixes}
                  baseHref={`/projects/${slug}/tasks/${task.id}`}
                  selectedDiff={selectedDiff}
                  projectSlug={slug}
                  taskId={task.id}
                  aiTargets={aiTargetOptions}
                  defaultAiTarget={defaultAiTarget}
                />
              </TabPanel> : null}
            </div>
          </TabsProvider>
        </section>
      </div>
    </div>
    </TaskDirtyGuard>
    </StickyViewportSurface>
  );
}
