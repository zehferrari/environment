import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
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
  checkHierarchy,
  checkStatusTransition,
  type ActorKind,
} from "@/lib/workflow";
import { COLUMN_IDS } from "../../columns";
import {
  buildDeploymentApproved,
  buildTaskAssigned,
} from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import {
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
} from "@/lib/agents/task-workflow-notifications";
import {
  listAssignablePrincipals,
} from "@/lib/principals";
import { uploadAttachment, deleteAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { deleteTask } from "@/lib/bin/actions";
import { archiveTask, unarchiveTask } from "@/lib/archive/actions";
import { approveAndMergeDeploymentPullRequest, approveDeploymentLocalChanges } from "@/lib/deploy/actions";
import { reorderTasks } from "@/lib/tasks/reorder";
import { publishBoardTouch } from "@/lib/pm/board-events";
import {
  canApproveActionPlanForActor,
  resolveReviewOwnerId,
} from "@/lib/tasks/workflow-actors";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { getTaskGitChanges, getTaskGitFileDiff } from "@/lib/tasks/git-changes";
import { createActionPlanSubtasksForTask } from "@/lib/tasks/action-plan-subtasks";
import { allocateWorkItemKey, effectiveCommitPrefix } from "@/lib/work-items/keys";
import {
  getCachedLatestRepoVerifyActivity,
  getCachedPendingTaskProposals,
  getCachedProjectEpics,
  getCachedRecentTaskChatMessages,
  getCachedTaskActivity,
  getCachedTaskAttachments,
  getCachedTaskChatArchives,
  getCachedTaskComments,
  getCachedTaskDetailShell,
  getCachedTaskRoomMessages,
  revalidateTaskReplyScope,
} from "@/lib/tasks/cache";
import SortableTaskList from "@/components/sortable-task-list";
import AttachmentList from "@/components/attachment-list";
import AttachmentUploadFab from "@/components/attachment-upload-fab";
import AutoScrollToLatest from "@/components/auto-scroll-to-latest";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import ChatRoom from "@/components/chat-room";
import ActivityTimeline, { type ActivityTimelineRow } from "@/components/activity-timeline";
import TaskChangesPanel from "@/components/task-changes-panel";
import CommentComposerFab from "@/components/comment-composer-fab";
import ConfirmedDeleteButton from "@/components/confirmed-delete-button";
import DeletedMessageDivider from "@/components/deleted-message-divider";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
} from "@/components/message-avatar";
import DescriptionField from "@/components/description-field";
import { TabsProvider, TabsNav, TabPanel } from "@/components/task-tabs";
import PmOptions from "@/components/pm-options";
import { findPmOptionResolution, parsePmOptions, isPmOptionsTargetedAtCurrentUser } from "@/lib/pm-options";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import TaskEpicPicker from "./task-epic-picker";
import DeploymentTab, { DeploymentStatusSelect, canShowDeploymentAction, canShowDeploymentTab, type DeploymentPrRow } from "@/components/deployment-tab";
import { checkDeploymentStatusWrite, isDeploymentStatus } from "@/lib/deploy/deployment-status";

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

function serializeActor(actor: ActorRow | null) {
  if (!actor) return null;
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind,
    name: actor.name,
    avatarUpdatedAt: dateIso(actor.avatarUpdatedAt),
    agent: actor.agent,
  };
}

async function requireActor(): Promise<{ id: string; username: string; kind: ActorKind }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, username: session.user?.name ?? "", kind };
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
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const newAssigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const reviewerRaw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = reviewerRaw === "" ? null : reviewerRaw;
  const reporterRaw = String(formData.get("reporterId") ?? "");
  const newReporterId = reporterRaw === "" ? null : reporterRaw;
  const deploymentRaw = String(formData.get("deploymentStatus") ?? "");

  if (newStatus !== "" && !COLUMN_IDS.includes(newStatus)) return;
  if (deploymentRaw !== "" && !isDeploymentStatus(deploymentRaw)) return;
  if (newBranch !== null && newBranch.length > 200) return;
  if (newCommitPrefix !== null && newCommitPrefix.length > 200) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      status: true,
      epicId: true,
      branchName: true,
      commitPrefix: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      deploymentStatus: true,
      parentTaskId: true,
      approvedOn: true,
      workItemKey: true,
      project: {
        select: {
          slug: true,
          onlyReportersCanApproveActionPlans: true,
          onlyReportersCanApprovePullRequests: true,
        },
      },
      epic: { select: { title: true, status: true, actingManagerId: true, branchName: true, commitPrefix: true } },
      assignee: { select: { id: true, username: true, kind: true } },
      actingManager: { select: { username: true } },
      reporter: { select: { username: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;

  const data: Prisma.TaskUpdateInput = {};
  const activity: { kind: string; payload: string }[] = [];
  let assignmentTarget: { id: string; kind: string; username: string } | null =
    null;
  let assignmentChanged = false;
  let statusChangedTo: string | null = null;
  let completeReviewAfterSave = false;

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
    // Browser-session human saves are authoritative. Workflow policy still
    // constrains agent/generic automation paths, but a human task-form action
    // must persist once the target column is a known PM status.
    if (actor.kind !== "human") {
      const check = checkStatusTransition({
        from: task.status,
        to: newStatus,
        actor,
      });
      if (!check.ok) throw new Error(check.message);
    }
    if (actor.kind !== "human" && newStatus === "In Progress" && !task.approvedOn) {
      throw new Error("Action Plan must be approved before this task can move to In Progress.");
    }
    if (task.status === "Review" && newStatus === "Done") {
      completeReviewAfterSave = true;
    } else {
      const maxRank = await db.task.aggregate({
        where: { status: newStatus, archivedAt: null, deletedAt: null },
        _max: { rank: true },
      });
      data.status = newStatus;
      data.rank = (maxRank._max.rank ?? 0) + 1;
      data.statusChangedAt = new Date();
      statusChangedTo = newStatus;
      activity.push({
        kind: "task.move",
        payload: JSON.stringify({ from: task.status, to: newStatus }),
      });
    }
  }

  // Epic (must belong to the same project)
  let selectedEpicDefaults =
    newEpicId === task.epicId
      ? { branchName: task.epic?.branchName ?? null, commitPrefix: task.epic?.commitPrefix ?? null }
      : null;

  if (newEpicId !== task.epicId) {
    let newEpicTitle: string | null = null;
    if (newEpicId !== null) {
      const target = await db.epic.findUnique({
        where: { id: newEpicId },
        select: { title: true, projectId: true, branchName: true, commitPrefix: true },
      });
      if (!target || target.projectId !== task.projectId) {
        throw new Error("Epic not found in this project");
      }
      newEpicTitle = target.title;
      selectedEpicDefaults = {
        branchName: target.branchName,
        commitPrefix: target.commitPrefix,
      };
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

  const effectiveNewBranch = newBranch ?? selectedEpicDefaults?.branchName ?? null;
  const effectiveNewCommitPrefix = newCommitPrefix ?? selectedEpicDefaults?.commitPrefix ?? null;

  // Branch
  if ((task.branchName ?? null) !== effectiveNewBranch) {
    data.branchName = effectiveNewBranch;
    activity.push({
      kind: "task.branch",
      payload: JSON.stringify({ from: task.branchName ?? null, to: effectiveNewBranch }),
    });
  }

  // Commit prefix (HOMELAB task-form redesign)
  if ((task.commitPrefix ?? null) !== effectiveNewCommitPrefix) {
    data.commitPrefix = effectiveNewCommitPrefix;
    activity.push({
      kind: "task.commit_prefix",
      payload: JSON.stringify({
        from: task.commitPrefix ?? null,
        to: effectiveNewCommitPrefix,
      }),
    });
  }

  // Assignee (no agent self-assign; target must be active)
  if (newAssigneeId !== task.assigneeId) {
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
  if (newActingManagerId !== task.actingManagerId) {
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
  if (newReporterId !== task.reporterId) {
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

  if (activity.length === 0 && !completeReviewAfterSave) return; // nothing changed

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

  try {
    const { deleteDescriptionDraft } = await import("@/lib/description-drafts");
    // Save applied — clear THIS user's draft (others viewing the same
    // task with their own drafts keep them).
    await deleteDescriptionDraft({ scope: "task", targetId: taskId, requesterUserId: actor.id });
  } catch (e) {
    console.error("Failed to delete description draft:", e);
  }

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(task.projectId);

  if (deploymentAllowed && deploymentRaw === "Deployment Approved" && task.deploymentStatus !== "Deployment Approved") {
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
  if (assignmentChanged) {
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
            "Read the full task context and existing comments. Post one concise technical implementation plan in Action Plan.",
            "Do not change task status and do not start work until the task is moved to To Do.",
          ].join("\n")
        : [
            `Task "${titleRaw}" is now in To Do and assigned to you.`,
            "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
            "Do not move it to In Progress until approved_on is set.",
          ].join("\n"),
    });
  }

  if (completeReviewAfterSave) {
    const actorUser = await db.user.findUnique({
      where: { id: actor.id },
      select: { username: true },
    });
    await completeReviewedTaskAndAssignNext({
      taskId: task.id,
      actor: {
        id: actor.id,
        username: actorUser?.username ?? "unknown",
        kind: actor.kind,
      },
      via: "task-edit",
    });
  }

  if (statusChangedTo === "Review") {
    const updatedTask = await db.task.findUnique({
      where: { id: task.id },
      select: {
        actingManagerId: true,
        reporterId: true,
        epic: { select: { status: true, actingManagerId: true } },
      },
    });
    const reviewerId = updatedTask ? resolveReviewOwnerId(updatedTask) : null;
    if (reviewerId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: reviewerId,
        actor,
        reason: "review_requested",
        body: [
          `Task "${titleRaw}" was moved to Review.`,
          "Review the completed work and full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, leave concise feedback while keeping it in Review.",
        ].join("\n"),
      });
    }
  }
}

async function approveTaskActionPlan(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  if (!taskId || !slug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      approvedOn: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      deletedAt: true,
      project: { select: { slug: true, onlyReportersCanApproveActionPlans: true } },
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!task || task.deletedAt || task.project.slug !== slug) return;

  if (actor.kind !== "human" && !canApproveActionPlanForActor(task, actor.id)) {
    throw new Error(task.project.onlyReportersCanApproveActionPlans
      ? "Only the task reporter can approve the Action Plan for this project."
      : "Only the task reviewer or reporter can approve the Action Plan.");
  }
  if (task.approvedOn) return;

  const approvedAt = new Date();
  const statusUpdate =
    task.status === "Backlog"
      ? { status: "To Do", statusChangedAt: approvedAt }
      : {};

  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: {
        approvedOn: approvedAt,
        approvedById: actor.id,
        ...statusUpdate,
      },
    }),
    db.activityLog.create({
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
    }),
    ...(task.status === "Backlog"
      ? [
          db.activityLog.create({
            data: {
              projectId: task.projectId,
              taskId: task.id,
              userId: actor.id,
              kind: "task.move",
              payload: JSON.stringify({
                from: "Backlog",
                to: "To Do",
                via: "action-plan-approval",
              }),
            },
          }),
        ]
      : []),
  ]);

  await createActionPlanSubtasksForTask({
    taskId: task.id,
    approvedAt,
    approvedById: actor.id,
  });

  if (task.assigneeId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor,
      reason: "todo_start_required",
      body: [
        `The Action Plan for "${task.title}" was approved.`,
        "You may now call the workflow endpoint with action=start, move the task to In Progress, and implement the approved plan.",
        "Keep visible replies concise; use a comment only if a blocker or material plan change appears.",
      ].join("\n"),
    });
  }

  revalidatePath(`/projects/${slug}/tasks/${task.id}`);
  revalidatePath(`/projects/${slug}`);
}

async function createComment(formData: FormData) {
  "use server";
  const actorId = await requireActorId();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!taskId || !slug || !body) return;
  if (body.length > 8000) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;

  const users = await db.user.findMany({
    select: {
      id: true,
      username: true,
      kind: true,
      status: true,
      agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
    },
  });
  const mentions = extractMentions(
    body,
    users.map((u) => ({ username: u.username })),
  );
  const actorUser = users.find((u) => u.id === actorId);

  const comment = await db.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: { taskId, userId: actorId, body },
      select: { id: true, createdAt: true },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actorId,
        kind: "task.comment",
        payload: mentions.length > 0 ? JSON.stringify({ mentions }) : null,
      },
    });
    return comment;
  });

  revalidateTaskReplyScope(taskId, "comment");

  const actor = {
    id: actorId,
    kind: (users.find((u) => u.id === actorId)?.kind === "agent"
      ? "agent"
      : "human") as "human" | "agent",
  };
  await sendTaskCommentNotifications({
    taskId: task.id,
    commentId: comment.id,
    body,
    actor: {
      id: actor.id,
      username: actorUser?.username,
      kind: actor.kind,
    },
  });
}

// Human-only comment removal (HOMELAB-41). Agents post comments but
// cannot delete them — moderation stays a human action. Scoped by the
// URL slug + task so a comment id from another project can't be removed.
async function deleteComment(formData: FormData) {
  "use server";
  const actor = await requireActor();
  if (actor.kind !== "human") return;
  const commentId = String(formData.get("commentId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  if (!commentId || !slug || !taskId) return;

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
  if (actor.kind !== "human") return;
  const commentId = String(formData.get("commentId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  if (!commentId || !slug || !taskId) return;

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

async function createSubtask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const parentTaskId = String(formData.get("parentTaskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!parentTaskId || !slug || !title) return;
  if (title.length > 200) return;

  const parent = await db.task.findUnique({
    where: { id: parentTaskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      epicId: true,
      branchName: true,
      commitPrefix: true,
      parentTaskId: true,
      assigneeId: true,
      approvedOn: true,
      subtasks: { where: { deletedAt: null }, select: { id: true }, take: 1 },
      project: {
        select: {
          slug: true,
        },
      },
      epic: { select: { branchName: true, commitPrefix: true } },
    },
  });
  if (!parent || parent.project.slug !== slug) return;

  if (parent.parentTaskId !== null) {
    throw new Error("Cannot create sub-task under another sub-task");
  }
  if (actor.kind !== "human" && actor.id !== parent.assigneeId) {
    throw new Error("Only the task assignee can create task-local subtasks.");
  }
  if (actor.kind !== "human" && !parent.approvedOn) {
    throw new Error("Task Action Plan must be approved before subtasks can be created.");
  }
  if (actor.kind !== "human" && parent.subtasks.length > 0) {
    throw new Error("Task-local subtasks can only be created when the task has no child subtasks yet.");
  }

  const check = checkHierarchy({ level: "subtask", parentTaskId });
  if (!check.ok) throw new Error(check.message);

  const maxRank = await db.task.aggregate({
    where: { projectId: parent.projectId, status: "Backlog", archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });

  const child = await db.task.create({
    data: {
      projectId: parent.projectId,
      workItemKey: await allocateWorkItemKey(parent.projectId),
      epicId: parent.epicId,
      parentTaskId,
      title,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      assigneeId: null,
      actingManagerId: null,
      reporterId: actor.id,
      branchName: parent.branchName ?? parent.epic?.branchName ?? null,
      commitPrefix: parent.commitPrefix ?? parent.epic?.commitPrefix ?? null,
    },
    select: { id: true, title: true },
  });

  await db.activityLog.create({
    data: {
      projectId: parent.projectId,
      taskId: child.id,
      userId: actor.id,
      kind: "task.create",
      payload: JSON.stringify({
        title: child.title,
        parentTaskId,
        parentTitle: parent.title,
      }),
    },
  });

  revalidatePath(`/projects/${slug}/tasks/${parentTaskId}`);
  revalidatePath(`/projects/${slug}/tasks/${child.id}`);
  revalidatePath(`/projects/${slug}`);
}

// ---- Helpers --------------------------------------------------------

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
        ?? (task.epic?.status === "Open" ? workflowActorSlug(task.epic?.actingManager) : null)
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
  if (run?.status === "complete") return false;
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
    if (run.messageId === messageId && run.status === "complete") {
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
}: {
  params: Promise<{ slug: string; taskId: string }>;
  searchParams: Promise<{ chat?: string; chatArchive?: string; chatRoom?: string; tab?: string; commit?: string; file?: string }>;
}) {
  const [{ slug, taskId }, { chatArchive = "", chatRoom = "", tab = "", commit = "", file = "" }] = await Promise.all([
    params,
    searchParams,
  ]);
  let selectedTab = chatArchive || chatRoom === "current"
    ? "Action Plan"
    : tabFromSearchParam(tab, TASK_TABS) ?? "Description";

  const [taskShell, comments, attachments] = await Promise.all([
    getCachedTaskDetailShell(taskId),
    getCachedTaskComments(taskId),
    getCachedTaskAttachments(taskId),
  ]);
  const task = taskShell ? { ...taskShell, comments, attachments } : null;
  if (!task || task.project.slug !== slug || task.deletedAt) notFound();
  const showDeploymentTab = canShowDeploymentTab(task);
  const taskTabs = showDeploymentTab ? TASK_TABS : TASK_TABS.filter((name) => name !== DEVELOPMENT_TAB);
  if (!showDeploymentTab && selectedTab === DEVELOPMENT_TAB) selectedTab = "Description";

  // Only human viewers get comment-delete controls (see deleteComment).
  const viewer = await requireActor();
  const canDeleteComments = viewer.kind === "human";

  const [principals, projectEpics, mentionableUsers, recentTaskChatMessages, recentReplyActivity, latestRepoVerify, allActivity] = await Promise.all([
    listAssignablePrincipals(),
    getCachedProjectEpics(task.project.id),
    db.user.findMany({ select: { username: true } }),
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
  ]);
  const mentionables = mentionableUsers.map((u) => ({ username: u.username }));
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
  const deploymentPullRequests: DeploymentPrRow[] = showDeploymentTab
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
  const unreadActionPlanMessages = chatMessages.filter((message) => (
    !message.deletedAt
    && !message.body.startsWith("PM workflow notification for @")
    && message.sender.id !== viewer.id
    && (!taskChatReadCursor || message.createdAt > taskChatReadCursor.lastReadAt)
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
          status: "complete",
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
  const reporterOptions = task.reporter && !principals.some((p) => p.id === task.reporterId)
    ? [
        ...principalOptions,
        {
          value: task.reporter.id,
          label: actorDisplayName(serializeActor(task.reporter)!),
          actor: serializeActor(task.reporter),
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
  const createdActivity = [...allActivity].reverse().find((row) => row.kind === "task.create");
  const updatedActivity = allActivity.find((row) => (
    row.kind === "task.update" ||
    row.kind === "task.move" ||
    row.kind === "task.assign" ||
    row.kind === "task.acting_manager" ||
    row.kind === "task.action_plan.approve" ||
    row.kind === "task.action_plan.reset"
  )) ?? createdActivity;
  const changeWindows = taskWorkWindows(allActivity, {
    status: task.status,
    statusChangedAt: task.statusChangedAt,
  });
  const taskExplicitCommitPrefix = task.commitPrefix ?? task.epic?.commitPrefix ?? null;
  const taskCommitPrefix = effectiveCommitPrefix({
    commitPrefix: taskExplicitCommitPrefix,
    workItemKey: task.workItemKey ?? null,
  });
  const taskChanges = selectedTab === "Changes"
    ? await getTaskGitChanges({
        repositoryPath: task.project.repositoryPath,
        branchName: task.branchName ?? task.epic?.branchName ?? null,
        commitPrefix: taskCommitPrefix,
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

  async function reorderSubtasks(orderedIds: string[]): Promise<void> {
    "use server";
    await reorderTasks(orderedIds);
    revalidatePath(`/projects/${slug}/tasks/${taskId}`);
    revalidatePath(`/projects/${slug}`);
  }

  return (
    <div className="mx-auto w-full max-w-none">
      {/* ----- Main column ------------------------------------------- */}
      <div className="min-w-0">
        <section className="space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          {/* Sticky one-row editor header: title, epic, status and save stay visible. */}
          <div className="sticky top-0 z-10 -mx-5 -mt-5 flex flex-wrap items-end gap-3 rounded-t-2xl border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-2 shadow-sm xl:flex-nowrap">
            <label className="min-w-[18rem] flex-1">
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Task title
                {task.workItemKey ? (
                  <span className="ml-2 rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
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
                className="h-9 w-full rounded-lg border border-transparent bg-transparent px-2 text-xl font-semibold tracking-tight outline-none transition focus:border-[var(--color-line)] focus:bg-[var(--color-bg)]"
                aria-label="Task title"
              />
            </label>
            <div className="min-w-[12rem] flex-[0_1_16rem]">
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
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
            <label className="w-32 shrink-0">
              <span className="mb-0.5 block text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Status
              </span>
              <select
                form="taskMain"
                name="status"
                defaultValue={task.status}
                className="h-9 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 text-xs outline-none focus:border-[var(--color-accent)]"
                aria-label="Status"
              >
                {COLUMN_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Updated{" "}
                <time dateTime={dateIso(task.updatedAt) ?? undefined} title={dateIso(task.updatedAt) ?? undefined}>
                  {timeAgo(task.updatedAt)}
                </time>
              </span>
              <button
                form="taskMain"
                type="submit"
                className="h-9 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Save changes
              </button>
            </div>
          </div>
          {/* Review verification panel — only shown on tasks in Review with
              a branchName set on the task or its epic. Surfaces the monitor
              verifier's
              latest pm.repo.verify.* result so the reviewer doesn't approve
              work that isn't on origin/<branch> yet. */}
          {task.status === "Review" && (task.branchName || task.epic?.branchName) ? (() => {
            const branchName = task.branchName ?? task.epic?.branchName ?? "";
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
              kind === "pm.repo.verify.fail" ? "fail" :
              kind === "pm.repo.verify.enqueue" ? "pending" :
              "missing";
            const palette = {
              ok:      { border: "var(--color-line)", bg: "rgba(34,197,94,0.08)",  dot: "#22c55e", title: "✓ origin verified" },
              fail:    { border: "var(--color-line)", bg: "rgba(239,68,68,0.10)",  dot: "#ef4444", title: "⚠ origin not verified" },
              pending: { border: "var(--color-line)", bg: "rgba(59,130,246,0.08)", dot: "#3b82f6", title: "... monitor verifier running" },
              missing: { border: "var(--color-line)", bg: "rgba(148,163,184,0.10)", dot: "#94a3b8", title: "Repo verification not yet requested" },
            }[tone];
            return (
              <div
                className="rounded-lg border px-4 py-3 text-sm"
                style={{ borderColor: palette.border, backgroundColor: palette.bg }}
              >
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette.dot }} aria-hidden="true" />
                  <strong className="text-[var(--color-text)]">{palette.title}</strong>
                  <span className="ml-auto text-xs text-[var(--color-text-muted)]">
                    branch <code className="text-[var(--color-text)]">{branchName}</code>
                    {commitPrefix ? <> · prefix <code className="text-[var(--color-text)]">{commitPrefix}</code></> : null}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {tone === "ok" && payload.headSha
                    ? <>HEAD <code className="text-[var(--color-text)]">{payload.headSha.slice(0, 10)}</code> matches the COMMIT_PREFIX — safe to review.</>
                    : null}
                  {tone === "fail"
                    ? fetchAuthError
                      ? <>{payload.fetchError ? <>fetch failed: <code className="text-[var(--color-text)]">{payload.fetchError}</code>.</> : null} This is a monitor verifier repository-access problem. Fix the verifier credentials and retry; do not ask the assignee to repush solely for this error.</>
                      : <>{payload.fetchError ? <>fetch failed: <code className="text-[var(--color-text)]">{payload.fetchError}</code>.</> : null} See the latest <code className="text-[var(--color-text)]">pm.repo.verify.fail</code> comment below. Ask the assignee to push or fix the commit prefix before reviewing.</>
                    : null}
                  {tone === "pending"
                    ? <>The monitor verifier has been asked to verify <code className="text-[var(--color-text)]">origin/{branchName}</code>. The result will appear as a new task comment.</>
                    : null}
                  {tone === "missing"
                    ? <>No <code className="text-[var(--color-text)]">pm.repo.verify.*</code> activity yet — either the task pre-dates the verifier, or the assignee declared <code className="text-[var(--color-text)]">repoTouched: false</code> on ready_for_review.</>
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
              badges={{ "Action Plan": unreadActionPlanMessages.length }}
            />
            <div className="pt-4">
              <TabPanel name="Description">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
                  <DescriptionField
                    formId="taskMain"
                    previewHtml={renderFullMarkdown(task.description ?? "").__html}
                    defaultValue={task.description ?? ""}
                    projectSlug={slug}
                    taskId={task.id}
                    aiTargets={aiTargetOptions}
                    defaultAiTarget={defaultAiTarget}
                    descriptionLabel="Task"
                    draftDescription={draftDescription}
                    aiRunning={isAiDescriptionRunning}
                    runningMessageId={runningDescriptionRun?.messageId ?? null}
                    runningAgentSlug={runningDescriptionRun?.agentSlug ?? null}
                    // Sub-tasks (parentTaskId !== null) get a taller editor —
                    // they're where most of the day-to-day work detail lands,
                    // so the larger box matches actual use (HOMELAB-48).
                    rows={task.parentTaskId !== null ? 24 : 12}
                  />

                  <aside className="space-y-4 xl:sticky xl:top-16 xl:self-start">
                    {/* Dates */}
                    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Dates
                      </div>
                      <dl className="mt-2 space-y-1 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[var(--color-text-muted)]">Created</dt>
                          <dd className="flex items-center gap-2">
                            <time
                              dateTime={dateIso(task.createdAt) ?? undefined}
                              title={dateIso(task.createdAt) ?? undefined}
                              className="tabular-nums"
                            >
                              {timeAgo(task.createdAt)}
                            </time>
                            {createdActivity?.user ? (
                              <MessageAvatar actor={createdActivity.user} size="sm" />
                            ) : task.reporter ? (
                              <MessageAvatar actor={serializeActor(task.reporter)!} size="sm" />
                            ) : null}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[var(--color-text-muted)]">Updated</dt>
                          <dd className="flex items-center gap-2">
                            <time
                              dateTime={dateIso(task.updatedAt) ?? undefined}
                              title={dateIso(task.updatedAt) ?? undefined}
                              className="tabular-nums"
                            >
                              {timeAgo(task.updatedAt)}
                            </time>
                            {updatedActivity?.user ? (
                              <MessageAvatar actor={updatedActivity.user} size="sm" />
                            ) : null}
                          </dd>
                        </div>
                        {task.approvedOn ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-[var(--color-text-muted)]">Approved</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={dateIso(task.approvedOn) ?? undefined}
                                title={dateIso(task.approvedOn) ?? undefined}
                                className="tabular-nums"
                              >
                                {timeAgo(task.approvedOn)}
                              </time>
                              {task.approvedBy ? <MessageAvatar actor={serializeActor(task.approvedBy)!} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                        {task.status === "Done" && task.statusChangedAt ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-[var(--color-text-muted)]">Done</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={dateIso(task.statusChangedAt) ?? undefined}
                                title={dateIso(task.statusChangedAt) ?? undefined}
                                className="tabular-nums"
                              >
                                {timeAgo(task.statusChangedAt)}
                              </time>
                              {doneActivity?.user ? <MessageAvatar actor={doneActivity.user} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                        {task.archivedAt ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-[var(--color-text-muted)]">Archived</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={dateIso(task.archivedAt) ?? undefined}
                                title={dateIso(task.archivedAt) ?? undefined}
                                className="tabular-nums"
                              >
                                {timeAgo(task.archivedAt)}
                              </time>
                              {task.archivedBy ? <MessageAvatar actor={serializeActor(task.archivedBy)!} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>

                    <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Report by
                        </span>
                        <AvatarCombobox
                          formId="taskMain"
                          name="reporterId"
                          defaultValue={task.reporterId ?? ""}
                          options={reporterOptions}
                          emptyLabel="No reporter"
                          ariaLabel="Report by"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Assignee
                        </span>
                        <AvatarCombobox
                          formId="taskMain"
                          name="assigneeId"
                          defaultValue={task.assigneeId ?? ""}
                          options={principalOptions}
                          emptyLabel="Unassigned"
                          ariaLabel="Assignee"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Reviewer
                        </span>
                        <AvatarCombobox
                          formId="taskMain"
                          name="actingManagerId"
                          defaultValue={task.actingManagerId ?? ""}
                          options={principalOptions}
                          emptyLabel="No reviewer"
                          ariaLabel="Reviewer"
                        />
                      </label>
                    </div>

                    {showDeploymentTab ? (
                      <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                        <DeploymentStatusSelect formId="taskMain" defaultValue={task.deploymentStatus} />
                      </div>
                    ) : null}

                    {/* Branch + Commit prefix — persisted by the card's single Save. */}
                    <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Branch
                        </span>
                        <input
                          form="taskMain"
                          name="branchName"
                          defaultValue={task.branchName ?? task.epic?.branchName ?? ""}
                          maxLength={200}
                          placeholder="e.g. feature/HOMELAB-99"
                          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--color-accent)]"
                          aria-label="Branch name"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Commit prefix
                        </span>
                        <input
                          form="taskMain"
                          name="commitPrefix"
                          defaultValue={task.commitPrefix ?? task.epic?.commitPrefix ?? ""}
                          maxLength={200}
                          placeholder={task.workItemKey ? `defaults to ${task.workItemKey}` : "e.g. HOMELAB-99"}
                          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--color-accent)]"
                          aria-label="Commit prefix"
                        />
                      </label>
                    </div>

                    {task.parent ? (
                      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Parent task
                        </div>
                        <Link
                          href={`/projects/${slug}/tasks/${task.parent.id}`}
                          className="mt-2 block text-sm hover:underline"
                        >
                          {task.parent.title}
                        </Link>
                      </div>
                    ) : null}

                    <form
                      action={task.archivedAt ? unarchiveTask : archiveTask}
                      className="space-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4"
                    >
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Archive
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {task.archivedAt
                          ? "Restore this task to active project views without changing its status."
                          : "Hide this task from active boards and grids without changing its status."}
                      </p>
                      <button
                        type="submit"
                        className="w-full rounded-lg border border-[var(--color-line)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      >
                        {task.archivedAt ? "Restore from archive" : "Archive task"}
                      </button>
                    </form>

                    {/* Danger zone — soft delete moves the task (and any sub-tasks) to
                        the bin for 7 days, then hard-deletes. Its own form, separate
                        from the main edit form. Restore from /projects/<slug>/bin. */}
                    <form
                      action={deleteTask}
                      className="space-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4"
                    >
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-crit)]">
                        Danger zone
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        Move this task to the bin. Sub-tasks ({task.subtasks.length}) go
                        with it. Auto-purged after 7 days.
                      </p>
                      <button
                        type="submit"
                        className="w-full rounded-lg border border-[var(--color-crit)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-crit)] hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
                      >
                        Delete task
                      </button>
                    </form>
                  </aside>
                </div>
              </TabPanel>


              <TabPanel name="Action Plan">
                <div className="space-y-3 pt-2">
                  {canApproveActionPlan ? (
                    <form action={approveTaskActionPlan} className="flex justify-end">
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <button
                        type="submit"
                        className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
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
              </TabPanel>

              <TabPanel name="Sub-Tasks">
                <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-text)]">
              Sub-tasks
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">
              {task.subtasks.length} total
            </span>
          </div>
          {task.subtasks.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No sub-tasks yet.
            </p>
          ) : (
            <SortableTaskList
              ariaLabel="Sub-tasks"
              reorderAction={reorderSubtasks}
              showAssignee
              showStatusBadge
              items={task.subtasks.map((st) => ({
                id: st.id,
                workItemKey: st.workItemKey,
                title: st.title,
                status: st.status,
                alertReporter: st.alertReporter,
                href: `/projects/${slug}/tasks/${st.id}`,
                assigneeName: st.assignee?.username ?? null,
              }))}
            />
          )}

          {task.parentTaskId === null ? (
            <form action={createSubtask} className="mt-4 flex gap-2">
              <input type="hidden" name="parentTaskId" value={task.id} />
              <input type="hidden" name="projectSlug" value={slug} />
              <input
                name="title"
                required
                maxLength={200}
                placeholder="New sub-task title"
                className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="submit"
                className="rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Add
              </button>
            </form>
          ) : (
            <p className="mt-4 text-xs text-[var(--color-text-muted)]">
              Sub-tasks of sub-tasks are not allowed. Add sub-tasks on the
              parent task.
            </p>
          )}
                </div>
              </TabPanel>

              <TabPanel name="Attachments">
                <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-text)]">
              Attachments
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">
              Max {formatBytes(attachmentMaxBytes())} per file
            </span>
          </div>
          <AttachmentList
            attachments={task.attachments}
            projectSlug={slug}
            deleteAction={deleteAttachment}
          />

          <AttachmentUploadFab
            projectSlug={slug}
            taskId={task.id}
            maxLabel={formatBytes(attachmentMaxBytes())}
            uploadAction={uploadAttachment}
          />
                </div>
              </TabPanel>

              <TabPanel name="Comments">
                <div className="flex h-[calc(100dvh-14rem)] min-h-[560px] flex-col">
                  <h2 className="mb-3 text-sm font-semibold tracking-wide text-[var(--color-text)]">
                    Comments
                  </h2>
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {task.comments.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No comments yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {task.comments.map((c, index) => {
                const parsedPmOptions = parsePmOptions(c.body);
                const mentionedCurrentUser = mentionedUsername(c.body, viewer.username);
                const resolvedPmOption = findPmOptionResolution(
                  parsedPmOptions.options,
                  task.comments.slice(index + 1).filter((later) => !later.deletedAt).map((later) => later.body),
                );
                if (c.deletedAt) {
                  // Soft-deleted (HOMELAB-41 / item 2): render as a
                  // collapsed dotted divider with the original body
                  // hidden behind a [+] toggle. Humans can restore via
                  // the ↺ button (only shown when canDeleteComments).
                  // Agent context never sees deleted bodies.
                  return (
                    <li key={c.id}>
                      <DeletedMessageDivider
                        deletedAt={c.deletedAt}
                        deletedBy={c.deletedBy}
                        restore={canDeleteComments ? {
                          action: restoreComment,
                          fields: { commentId: c.id, taskId: task.id, projectSlug: slug },
                        } : undefined}
                      >
                        {renderCommentBody(c.body, mentionables)}
                      </DeletedMessageDivider>
                    </li>
                  );
                }
                return (
                  <li
                    key={c.id}
                    className="flex items-start gap-3 text-sm"
                  >
                    <MessageAvatar actor={c.user} size="sm" />
                    <div className={`min-w-0 flex-1 rounded-xl border border-[var(--color-line)] px-3 py-2 ${mentionedCurrentUser ? "bg-yellow-400/[0.12]" : "bg-[var(--color-panel-soft)]"}`}>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <strong className="truncate font-medium text-[var(--color-text)]">
                            {actorDisplayName(c.user)}
                          </strong>
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
                      <div>{renderCommentBody(parsedPmOptions.body, mentionables)}</div>
                      {parsedPmOptions.options.length > 0 ? (
                        <PmOptions
                          projectSlug={slug}
                          sourceMessageId={c.id}
                          surface="task-comment"
                          options={parsedPmOptions.options}
                          resolvedOption={resolvedPmOption}
                          interactive={isPmOptionsTargetedAtCurrentUser({ currentUserId: viewer.id })}
                        />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {pendingCommentMessages.length > 0 ? (
            <div className="mt-3 space-y-2">
              {pendingCommentMessages.map((message) => (
                <StreamingAgentReply
                  key={message.id}
                  targetKind="task-comment"
                  agentSlug={message.agentSlug}
                  taskId={task.id}
                  messageId={message.id}
                  label={`@${message.agentSlug}`}
                  anonymizeTyping
                />
              ))}
            </div>
          ) : null}
          {task.comments.length > 0 || pendingCommentMessages.length > 0 ? (
            <AutoScrollToLatest
              whenTab="Comments"
              watchKey={[
                task.comments.length,
                task.comments.at(-1)?.id ?? "",
                pendingCommentMessages.map((message) => message.id).join(","),
              ].join(":")}
            />
          ) : null}
                  </div>

          <CommentComposerFab
            projectSlug={slug}
            taskId={task.id}
            action={createComment}
            title="Task Comment"
            placeholder="Write a comment — **markdown** and @mentions supported"
          />
                </div>
              </TabPanel>

              <TabPanel name="Activities">
                <div className="pt-2">
                  <ActivityTimeline rows={allActivity} />
                </div>
              </TabPanel>

              {showDeploymentTab ? (
                <TabPanel name={DEVELOPMENT_TAB}>
                  <DeploymentTab
                    mode="task"
                    title={task.title}
                    deploymentStatus={task.deploymentStatus}
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

              <TabPanel name="Changes">
                <TaskChangesPanel
                  changes={taskChanges}
                  branchName={task.branchName ?? task.epic?.branchName ?? null}
                  commitPrefix={taskCommitPrefix}
                  baseHref={`/projects/${slug}/tasks/${task.id}`}
                  selectedDiff={selectedDiff}
                />
              </TabPanel>
            </div>
          </TabsProvider>
        </section>
      </div>
    </div>
  );
}
