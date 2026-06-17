// Work-item proposal apply core (Slice 3).
//
// commitProposal() takes a pending WorkItemProposal and the approving
// human's user id, re-validates the change-set against current state
// under the same human-triggered grant semantics, then commits every
// operation in one transaction. It mirrors the canonical
// createTask / createEpic / moveTask shapes (rank, Backlog, statusChangedAt,
// activity rows).
//
// Attribution: the mutations themselves are logged as the AGENT
// (proposal.proposedByUserId) so the board feed reads "@agent created X",
// while the human's approval is recorded by proposal.appliedById + a
// single workitem.proposal.apply summary row. Re-validation failure
// aborts without writing anything.
//
// This module is intentionally auth-free (no next/auth, no revalidatePath)
// so it is unit-testable from a script; the "use server" wrappers in
// lib/work-items/actions.ts add auth + cache revalidation.

import { db } from "@/lib/db";
import {
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
  type TaskWorkflowNotificationReason,
} from "@/lib/agents/workflow/notifications/task";
import { listAssignablePrincipals } from "@/lib/principals";
import { validateProposal } from "@/lib/work-items/proposal";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { MAX_SUBTASK_TEXT } from "@/lib/tasks/subtasks";

type RawOp = Record<string, unknown>;

export interface CommitCounts {
  epics: number;
  tasks: number;
  subtasks: number;
  updates: number;
  comments: number;
}

export interface CommitResult {
  ok: boolean;
  error?: string;
  projectSlug: string;
  agentSlug: string;
  taskId?: string | null;
  epicId?: string | null;
  counts: CommitCounts;
  createdItems?: Array<{
    kind: "epic" | "task" | "subtask";
    id: string;
    title: string;
    url: string;
  }>;
}

const ZERO: CommitCounts = { epics: 0, tasks: 0, subtasks: 0, updates: 0, comments: 0 };

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

type WorkflowNotification = {
  taskId: string;
  targetUserId: string;
  reason: TaskWorkflowNotificationReason;
  body: string;
};

type CommentNotification = {
  taskId: string;
  commentId: string;
  body: string;
};

function taskWorkflowBody(args: {
  title: string;
  actorUsername: string | null;
  reason: TaskWorkflowNotificationReason;
}) {
  const actor = args.actorUsername ? `@${args.actorUsername}` : "the workflow manager";
  if (args.reason === "backlog_plan_requested") {
    return [
      `You have been assigned to "${args.title}" while it is in Backlog by ${actor}.`,
      "Read the full task context and existing comments. Post one concise technical implementation plan in Action Plan.",
      "Do not change task status and do not start work until the task is moved to To Do.",
    ].join("\n");
  }
  if (args.reason === "todo_start_required") {
    return [
      `Task "${args.title}" is now in To Do and assigned to you by ${actor}.`,
      "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
      "Do not move it to In Progress until approved_on is set.",
    ].join("\n");
  }
  if (args.reason === "review_requested") {
    return [
      `Task "${args.title}" was moved to Review by ${actor}.`,
      "Review the completed work and full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, leave concise feedback while keeping it in Review.",
    ].join("\n");
  }
  if (args.reason === "review_done") {
    return [
      `Task "${args.title}" was reviewed and moved to Done by ${actor}.`,
      "No further action is required unless the task is reopened or follow-up feedback is posted.",
    ].join("\n");
  }
  return `Follow the Mission Control workflow for "${args.title}".`;
}

export async function commitProposal(
  proposalId: string,
  approverUserId: string,
): Promise<CommitResult> {
  const proposal = await db.workItemProposal.findUnique({
    where: { id: proposalId },
    select: {
      id: true,
      status: true,
      projectId: true,
      agentSlug: true,
      proposedByUserId: true,
      operations: true,
      grantMessageId: true,
      project: { select: { slug: true, deletedAt: true } },
    },
  });
  if (!proposal) {
    return { ok: false, error: "Proposal not found", projectSlug: "", agentSlug: "", counts: ZERO };
  }
  const projectSlug = proposal.project.slug;
  const agentSlug = proposal.agentSlug;

  let taskId: string | null = null;
  let epicId: string | null = null;
  // Resolve the requesting human. New epics/tasks created by this
  // proposal record that human as the reporter (HOMELAB-41 / item 3:
  // "every Epic/Task created by an agent has to set the human user
  // that requested the task as the reporter"). The grant message is
  // either a DirectAgentChatMessage (direct-chat-attached project work)
  // or an AgentChatMessage (Task/Epic Discussion). Both expose
  // senderUserId for the human who issued the request.
  let requesterUserId: string | null = null;
  if (proposal.grantMessageId) {
    const directGrant = await db.directAgentChatMessage.findUnique({
      where: { id: proposal.grantMessageId },
      select: { senderUserId: true },
    });
    if (directGrant) {
      requesterUserId = directGrant.senderUserId;
    } else {
      const discussionGrant = await db.agentChatMessage.findUnique({
        where: { id: proposal.grantMessageId },
        select: { taskId: true, epicId: true, senderUserId: true },
      });
      if (discussionGrant) {
        taskId = discussionGrant.taskId;
        epicId = discussionGrant.epicId;
        requesterUserId = discussionGrant.senderUserId;
      }
    }
  }
  // If the grant message has gone (or the sender row is gone), fall back
  // to the agent — same behaviour as before the rule. Verify the user
  // we resolved is still a real, active row before stamping it.
  if (requesterUserId) {
    const exists = await db.user.findUnique({
      where: { id: requesterUserId },
      select: { id: true, status: true },
    });
    if (!exists || exists.status === "inactive") requesterUserId = null;
  }

  if (proposal.status !== "pending") {
    return { ok: false, error: `Proposal is already ${proposal.status}`, projectSlug, agentSlug, taskId, epicId, counts: ZERO };
  }
  if (proposal.project.deletedAt) {
    return { ok: false, error: "Project is in the bin", projectSlug, agentSlug, taskId, epicId, counts: ZERO };
  }

  let ops: RawOp[];
  try {
    const parsed = JSON.parse(proposal.operations) as unknown;
    ops = Array.isArray(parsed) ? (parsed as RawOp[]) : [];
  } catch {
    return { ok: false, error: "Stored operations are not valid JSON", projectSlug, agentSlug, counts: ZERO };
  }

  // Re-validate against current state with the same grant semantics.
  const agentActor = { userId: proposal.proposedByUserId, agentSlug };
  const validation = await validateProposal(proposal.projectId, ops, agentActor);
  if (!validation.ok) {
    const firstErr = validation.results.find((r) => !r.ok)?.errors[0] ?? "validation failed";
    return { ok: false, error: `Re-validation failed: ${firstErr}`, projectSlug, agentSlug, counts: ZERO };
  }

  const principals = await listAssignablePrincipals();
  const idByUsername = new Map(principals.map((p) => [p.username, p.id]));
  const usernameById = new Map(principals.map((p) => [p.id, p.username]));

  // username|null|undefined -> id|null|undefined (undefined = field absent / leave unchanged)
  const resolvePrincipal = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    return idByUsername.get(value.replace(/^@/, "")) ?? null;
  };
  // For creates: absent/unknown -> null (unassigned).
  const createId = (value: unknown): string | null => {
    const r = resolvePrincipal(value);
    return r === undefined ? null : r;
  };

  const counts: CommitCounts = { ...ZERO };
  const createdItems: NonNullable<CommitResult["createdItems"]> = [];
  const agentId = proposal.proposedByUserId;
  const projectId = proposal.projectId;
  const workflowNotifications: WorkflowNotification[] = [];
  const commentNotifications: CommentNotification[] = [];
  // reporterId on new epics/tasks: the requesting human if we resolved
  // one, otherwise fall back to the agent (preserves old behaviour for
  // grants whose original message is gone).
  const newItemReporterId = requesterUserId ?? agentId;
  const actorUser = await db.user.findUnique({
    where: { id: agentId },
    select: { username: true, kind: true },
  });
  const actorUsername = actorUser?.username ?? null;

  await db.$transaction(
    async (tx) => {
      const refToId = new Map<string, string>();
      const resolveRef = (value: unknown): string | null => {
        if (typeof value !== "string" || !value) return null;
        if (value.startsWith("tmp:")) return refToId.get(value) ?? null;
        return value;
      };

      const maxRank = await tx.task.aggregate({
        where: { projectId, status: "Backlog", archivedAt: null, deletedAt: null },
        _max: { rank: true },
      });
      let nextRank = (maxRank._max.rank ?? 0) + 1;

      // ---- creates, resolved in dependency waves (epic before its tasks,
      // parent before its sub-tasks; sub-tasks may nest) ----
      const depsOf = (op: RawOp): string[] => {
        const deps: string[] = [];
        if (op.op === "create_task" && typeof op.epic === "string" && op.epic.startsWith("tmp:")) deps.push(op.epic);
        if (op.op === "create_subtask" && typeof op.parent === "string" && op.parent.startsWith("tmp:")) deps.push(op.parent);
        return deps;
      };
      const pending = ops.filter(
        (op) => typeof op.op === "string" && (op.op as string).startsWith("create_"),
      );
      let guard = pending.length + 1;
      while (pending.length > 0 && guard-- > 0) {
        let progressed = false;
        for (let k = 0; k < pending.length;) {
          const op = pending[k]!;
          if (!depsOf(op).every((d) => refToId.has(d))) {
            k += 1;
            continue;
          }
          const ref = String(op.ref);

          if (op.op === "create_epic") {
            const epic = await tx.epic.create({
              data: {
                projectId,
                workItemKey: await allocateWorkItemKey(projectId, tx),
                title: String(op.title),
                description: optionalText(op.description),
                status: "Backlog",
                statusChangedAt: new Date(),
                actingManagerId: null,
                reporterId: newItemReporterId,
              },
              select: { id: true, title: true },
            });
            refToId.set(ref, epic.id);
            counts.epics++;
            createdItems.push({
              kind: "epic",
              id: epic.id,
              title: epic.title,
              url: `/projects/${projectSlug}/epics/${epic.id}`,
            });
            await tx.activityLog.create({
              data: {
                projectId,
                userId: agentId,
                kind: "epic.create",
                payload: JSON.stringify({ epicId: epic.id, title: epic.title, proposalId: proposal.id }),
              },
            });
          } else if (op.op === "create_subtask") {
            // A proposed "sub-task" is now a lightweight checklist item on the
            // parent task (text + completion), NOT a child Task. Fold any
            // description into the single goal line.
            const parentTaskId = resolveRef(op.parent);
            if (!parentTaskId) {
              throw new Error("create_subtask parent did not resolve to a task");
            }
            const description = optionalText(op.description);
            const text = (description ? `${String(op.title)} — ${description}` : String(op.title)).slice(0, MAX_SUBTASK_TEXT);
            const agg = await tx.subTask.aggregate({
              where: { taskId: parentTaskId },
              _max: { rank: true },
            });
            const sub = await tx.subTask.create({
              data: { taskId: parentTaskId, text, rank: (agg._max.rank ?? 0) + 1 },
              select: { id: true },
            });
            counts.subtasks++;
            createdItems.push({
              kind: "subtask",
              id: sub.id,
              title: String(op.title),
              url: `/projects/${projectSlug}/tasks/${parentTaskId}`,
            });
            const parent = await tx.task.findUnique({ where: { id: parentTaskId }, select: { title: true } });
            await tx.activityLog.create({
              data: {
                projectId,
                taskId: parentTaskId,
                userId: agentId,
                kind: "task.subtask.add",
                payload: JSON.stringify({ subTaskId: sub.id, text, parentTitle: parent?.title ?? null, proposalId: proposal.id }),
              },
            });
          } else {
            const epicId = op.epic !== undefined ? resolveRef(op.epic) : null;
            let inheritedBranchName: string | null = null;
            let inheritedCommitPrefix: string | null = null;
            if (epicId) {
              const epic = await tx.epic.findUnique({
                where: { id: epicId },
                select: { branchName: true, commitPrefix: true },
              });
              inheritedBranchName = epic?.branchName ?? null;
              inheritedCommitPrefix = epic?.commitPrefix ?? null;
            }
            const title = epicId
              ? await nextEpicTaskTitle(epicId, String(op.title), tx)
              : String(op.title);
            const task = await tx.task.create({
              data: {
                projectId,
                workItemKey: await allocateWorkItemKey(projectId, tx),
                epicId,
                title,
                description: optionalText(op.description),
                status: "Backlog",
                rank: nextRank++,
                statusChangedAt: new Date(),
                assigneeId: null,
                actingManagerId: null,
                reporterId: newItemReporterId,
                branchName: inheritedBranchName,
                commitPrefix: inheritedCommitPrefix,
              },
              select: { id: true, title: true, assigneeId: true },
            });
            refToId.set(ref, task.id);
            counts.tasks++;
            createdItems.push({
              kind: "task",
              id: task.id,
              title: task.title,
              url: `/projects/${projectSlug}/tasks/${task.id}`,
            });
            await tx.activityLog.create({
              data: {
                projectId,
                taskId: task.id,
                userId: agentId,
                kind: "task.create",
                payload: JSON.stringify({ title: task.title, epicId, proposalId: proposal.id }),
              },
            });
          }
          pending.splice(k, 1);
          progressed = true;
        }
        if (!progressed) break;
      }
      if (pending.length > 0) {
        throw new Error("unresolved temp-ref dependency cycle in proposal");
      }

      // ---- updates + comments ----
      for (const op of ops) {
        if (op.op === "update_epic") {
          const id = String(op.target);
          const epic = await tx.epic.findUnique({
            where: { id },
            select: {
              id: true, title: true, description: true, status: true,
              actingManagerId: true, deployReviewerId: true,
              actingManager: { select: { username: true } },
              deployReviewer: { select: { username: true } },
            },
          });
          if (!epic) continue;
          const data: Record<string, unknown> = {};
          const logs: Array<Record<string, unknown>> = [];
          if (typeof op.title === "string" && op.title !== epic.title) data.title = op.title;
          if (op.description !== undefined) {
            const d = optionalText(op.description);
            if (d !== epic.description) data.description = d;
          }
          if (data.title !== undefined || data.description !== undefined) {
            logs.push({ kind: "epic.update", payload: { epicId: id, proposalId: proposal.id } });
          }
          const am = resolvePrincipal(op.actingManager);
          if (am !== undefined && am !== epic.actingManagerId) {
            data.actingManagerId = am;
            logs.push({ kind: "epic.acting_manager", payload: { epicId: id, from: epic.actingManager?.username ?? null, to: am ? usernameById.get(am) ?? null : null, proposalId: proposal.id } });
          }
          const deployReviewer = resolvePrincipal(op.deployReviewer);
          if (deployReviewer !== undefined && deployReviewer !== epic.deployReviewerId) {
            data.deployReviewerId = deployReviewer;
            logs.push({ kind: "epic.deploy_reviewer", payload: { epicId: id, from: epic.deployReviewer?.username ?? null, to: deployReviewer ? usernameById.get(deployReviewer) ?? null : null, proposalId: proposal.id } });
          }
          if (typeof op.status === "string" && op.status !== epic.status) {
            data.status = op.status;
            logs.push({ kind: "epic.status", payload: { epicId: id, from: epic.status, to: op.status, proposalId: proposal.id } });
          }
          if (Object.keys(data).length > 0) {
            await tx.epic.update({ where: { id }, data });
            for (const l of logs) {
              await tx.activityLog.create({ data: { projectId, userId: agentId, kind: l.kind as string, payload: JSON.stringify(l.payload) } });
            }
            counts.updates++;
          }
        } else if (op.op === "update_task") {
          const id = String(op.target);
          const task = await tx.task.findUnique({
            where: { id },
            select: {
              id: true, title: true, description: true, status: true, epicId: true, parentTaskId: true,
              assigneeId: true, actingManagerId: true, reporterId: true, approvedOn: true, alertReporter: true,
              assignee: { select: { username: true } },
              actingManager: { select: { username: true } },
              epic: { select: { status: true, actingManagerId: true } },
            },
          });
          if (!task) continue;
          const data: Record<string, unknown> = {};
          const logs: Array<Record<string, unknown>> = [];
          if (typeof op.title === "string" && op.title !== task.title) data.title = op.title;
          if (op.description !== undefined) {
            const d = optionalText(op.description);
            if (d !== task.description) data.description = d;
          }
          if (data.title !== undefined || data.description !== undefined) {
            logs.push({ kind: "task.update", payload: { taskId: id, proposalId: proposal.id } });
          }
          const asg = resolvePrincipal(op.assignee);
          if (asg !== undefined && asg !== task.assigneeId) {
            data.assigneeId = asg;
            data.approvedOn = null;
            data.approvedById = null;
            logs.push({ kind: "task.assign", payload: { from: task.assignee?.username ?? null, to: asg ? usernameById.get(asg) ?? null : null, proposalId: proposal.id } });
            logs.push({ kind: "task.action_plan.reset", payload: { reason: "assignee_changed", from: task.assignee?.username ?? null, to: asg ? usernameById.get(asg) ?? null : null, proposalId: proposal.id } });
          }
          const am = resolvePrincipal(op.actingManager);
          if (am !== undefined && am !== task.actingManagerId) {
            data.actingManagerId = am;
            logs.push({ kind: "task.acting_manager", payload: { from: task.actingManager?.username ?? null, to: am ? usernameById.get(am) ?? null : null, proposalId: proposal.id } });
          }
          if (op.epic !== undefined) {
            const epicId = resolveRef(op.epic);
            if (epicId !== task.epicId) {
              data.epicId = epicId;
              logs.push({ kind: "task.epic", payload: { from: task.epicId, to: epicId, proposalId: proposal.id } });
            }
          }
          if (op.parent !== undefined) {
            const parentTaskId = resolveRef(op.parent);
            if (parentTaskId !== task.parentTaskId) {
              data.parentTaskId = parentTaskId;
              logs.push({ kind: "task.update", payload: { taskId: id, parentTaskId, proposalId: proposal.id } });
            }
          }

          const alertReporterRaw = op.alert_reporter !== undefined ? op.alert_reporter : op.alertReporter;
          if (alertReporterRaw !== undefined) {
            const alertReporter = alertReporterRaw === true || alertReporterRaw === 1 || alertReporterRaw === "1" || alertReporterRaw === "true";
            if (alertReporter !== task.alertReporter) {
              data.alertReporter = alertReporter;
              logs.push({ kind: "task.alert_reporter", payload: { taskId: id, from: task.alertReporter, to: alertReporter, proposalId: proposal.id } });
            }
          }
          if (typeof op.status === "string" && op.status !== task.status) {
            const rankAgg = await tx.task.aggregate({
              where: { projectId, status: op.status, archivedAt: null, deletedAt: null },
              _max: { rank: true },
            });
            data.status = op.status;
            data.rank = (rankAgg._max.rank ?? 0) + 1;
            data.statusChangedAt = new Date();
            logs.push({ kind: "task.move", payload: { from: task.status, to: op.status, proposalId: proposal.id } });
          }
          if (Object.keys(data).length > 0) {
            await tx.task.update({ where: { id }, data });
            for (const l of logs) {
              await tx.activityLog.create({ data: { projectId, taskId: id, userId: agentId, kind: l.kind as string, payload: JSON.stringify(l.payload) } });
            }
            counts.updates++;

            const finalStatus = typeof op.status === "string" ? op.status : task.status;
            const finalAssigneeId = asg !== undefined ? asg : task.assigneeId;
            const finalActingManagerId = am !== undefined ? am : task.actingManagerId;
            const assignmentChanged = asg !== undefined && asg !== task.assigneeId;
            const statusChanged = typeof op.status === "string" && op.status !== task.status;
            const reviewerId = finalActingManagerId
              ?? (task.epic?.status === "In Progress" ? task.epic.actingManagerId : null)
              ?? task.reporterId;

            if (finalAssigneeId && (assignmentChanged || statusChanged)) {
              if (finalStatus === "Backlog") {
                workflowNotifications.push({
                  taskId: id,
                  targetUserId: finalAssigneeId,
                  reason: "backlog_plan_requested",
                  body: taskWorkflowBody({
                    title: task.title,
                    actorUsername,
                    reason: "backlog_plan_requested",
                  }),
                });
              } else if (finalStatus === "To Do") {
                workflowNotifications.push({
                  taskId: id,
                  targetUserId: finalAssigneeId,
                  reason: "todo_start_required",
                  body: taskWorkflowBody({
                    title: task.title,
                    actorUsername,
                    reason: "todo_start_required",
                  }),
                });
              }
            }

            if (statusChanged && finalStatus === "Review" && reviewerId) {
              workflowNotifications.push({
                taskId: id,
                targetUserId: reviewerId,
                reason: "review_requested",
                body: taskWorkflowBody({
                  title: task.title,
                  actorUsername,
                  reason: "review_requested",
                }),
              });
            }

            if (statusChanged && finalStatus === "Done" && finalAssigneeId) {
              workflowNotifications.push({
                taskId: id,
                targetUserId: finalAssigneeId,
                reason: "review_done",
                body: taskWorkflowBody({
                  title: task.title,
                  actorUsername,
                  reason: "review_done",
                }),
              });
            }
          }
        } else if (op.op === "comment_task") {
          const id = String(op.target);
          const body = typeof op.body === "string" ? op.body : "";
          if (!body.trim()) continue;
          const comment = await tx.comment.create({
            data: { taskId: id, userId: agentId, body },
            select: { id: true },
          });
          await tx.activityLog.create({
            data: {
              projectId,
              taskId: id,
              userId: agentId,
              kind: "task.comment",
              payload: JSON.stringify({ commentId: comment.id, proposalId: proposal.id }),
            },
          });
          commentNotifications.push({ taskId: id, commentId: comment.id, body });
          counts.comments++;
        }
      }

      await tx.workItemProposal.update({
        where: { id: proposal.id },
        data: { status: "applied", appliedById: approverUserId, appliedAt: new Date() },
      });
      await tx.activityLog.create({
        data: {
          projectId,
          userId: approverUserId,
          kind: "workitem.proposal.apply",
          targetAgent: agentSlug,
          payload: JSON.stringify({ proposalId: proposal.id, agentSlug, opCount: ops.length }),
        },
      });
    },
    { timeout: 20000, maxWait: 10000 },
  );

  const actor = {
    id: agentId,
    username: actorUsername,
    kind: actorUser?.kind === "agent" ? "agent" as const : "human" as const,
  };
  await Promise.allSettled([
    ...workflowNotifications.map((notification) =>
      sendTaskWorkflowNotification({
        taskId: notification.taskId,
        targetUserId: notification.targetUserId,
        actor,
        reason: notification.reason,
        body: notification.body,
      }),
    ),
    ...commentNotifications.map((notification) =>
      sendTaskCommentNotifications({
        taskId: notification.taskId,
        commentId: notification.commentId,
        body: notification.body,
        actor,
      }),
    ),
  ]);

  return { ok: true, projectSlug, agentSlug, taskId, epicId, counts, createdItems };
}
