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
import type { Prisma } from "@prisma/client";
import {
  sendTaskCommentNotifications,
  type TaskWorkflowNotificationReason,
} from "@/lib/agents/workflow/notifications/task";
import { listAssignablePrincipals } from "@/lib/principals";
import { validateProposal } from "@/lib/work-items/proposal";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { MAX_SUBTASK_TEXT } from "@/lib/tasks/subtasks";
import { unresolvedTaskPrerequisites, validateBlockedBy } from "@/lib/tasks/blocking";
import { isActionableEpicStatus } from "@/lib/tasks/workflow-actors";
import {
  enqueueWorkflowEffects,
  type TaskWorkflowStatus,
} from "@/lib/tasks/transition-kernel";
import { submitWorkflowCommandInTransaction } from "@/lib/tasks/orchestrator";
import type { OrchestratorResult, TaskWorkflowCommand } from "@/lib/tasks/orchestrator/types";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import { newTaskWorkflowOwnership } from "@/lib/tasks/orchestrator/ownership";

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

function assertProposalCommandApplied(result: OrchestratorResult, operationIndex: number): void {
  if (result.status === "accepted" || result.status === "replayed") return;
  throw new Error(
    `proposal_workflow_command_rejected:op:${operationIndex}:${result.domainCode ?? result.status}:${result.reason}`,
  );
}

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
      "Read the full task context and existing comments. Call action=submit_plan with one concise structured technical Action Plan; plain chat text is discussion only.",
      "Do not change task status and do not start work until the task is moved to To Do.",
    ].join("\n");
  }
  if (args.reason === "todo_start_required") {
    return [
      `Task "${args.title}" is now in To Do and assigned to you by ${actor}.`,
      "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. A plain chat reply is discussion only.",
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
  const approverUser = await db.user.findUnique({
    where: { id: approverUserId },
    select: { id: true, username: true, kind: true, status: true },
  });
  const requesterUser = requesterUserId && requesterUserId !== approverUserId
    ? await db.user.findUnique({
        where: { id: requesterUserId },
        select: { id: true, username: true, kind: true, status: true },
      })
    : null;
  // Auto-applied owner grants are executed by the proposing agent on behalf
  // of the authenticated owner message. Recover that human as the decision
  // actor; ordinary UI approval uses the authenticated approver directly.
  const proposalDecisionActor = approverUser?.kind === "human"
    ? approverUser
    : requesterUser?.kind === "human" && requesterUser.status === "active"
      ? requesterUser
      : null;

  try {
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
        if (op.op === "create_task" && typeof op.blockedBy === "string" && op.blockedBy.startsWith("tmp:")) deps.push(op.blockedBy);
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
            const blockedById = op.blockedBy !== undefined ? resolveRef(op.blockedBy) : null;
            const title = epicId
              ? await nextEpicTaskTitle(epicId, String(op.title), tx)
              : String(op.title);
            const task = await tx.task.create({
              data: {
                ...newTaskWorkflowOwnership(),
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
                // Null retains dynamic inheritance/default semantics.
                branchName: null,
                commitPrefix: null,
              },
              select: { id: true, title: true, assigneeId: true },
            });
            refToId.set(ref, task.id);
            let blockedByKey: string | null = null;
            if (blockedById) {
              // Re-check the proposal visibility/lifecycle rules inside the
              // write transaction. The blocker may have been archived or made
              // private after the pre-transaction proposal revalidation.
              const blocker = await tx.task.findFirst({
                where: {
                  id: blockedById,
                  projectId,
                  private: false,
                  archivedAt: null,
                  deletedAt: null,
                  AND: [
                    { OR: [{ epicId: null }, { epic: { private: false } }] },
                    {
                      OR: [
                        { parentTaskId: null },
                        { parent: { private: false, OR: [{ epicId: null }, { epic: { private: false } }] } },
                      ],
                    },
                  ],
                },
                select: { workItemKey: true },
              });
              if (!blocker) throw new Error("Blocking task not found in this project");
              const check = await validateBlockedBy({
                taskId: task.id,
                projectId,
                blockerId: blockedById,
                client: tx,
              });
              if (!check.ok) throw new Error(check.message);
              blockedByKey = blocker.workItemKey ?? null;
              await tx.task.update({
                where: { id: task.id },
                data: { blockedById },
              });
            }
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
            if (blockedById) {
              await tx.activityLog.create({
                data: {
                  projectId,
                  taskId: task.id,
                  userId: agentId,
                  kind: "task.blocked_by",
                  payload: JSON.stringify({ from: null, to: blockedByKey, proposalId: proposal.id }),
                },
              });
            }
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
      let operationIndex = 0;
      for (const op of ops) {
        const currentOperationIndex = operationIndex++;
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
              workflowVersion: true,
              assigneeId: true, actingManagerId: true, reporterId: true, approvedOn: true, alertReporter: true,
              blockedById: true,
              assignee: { select: { username: true } },
              actingManager: { select: { username: true } },
              blockedBy: { select: { id: true, workItemKey: true, status: true } },
              dependencies: {
                select: { prerequisite: { select: { id: true, workItemKey: true, status: true } } },
              },
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
            // Attributed to the APPROVER, not the proposing agent: a
            // human-approved proposal assigning the proposer must not look
            // like an agent self-assignment to the guard.
            logs.push({ kind: "task.assign", userId: approverUserId, payload: { from: task.assignee?.username ?? null, to: asg ? usernameById.get(asg) ?? null : null, assignedBy: "proposal-apply", proposalId: proposal.id } });
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
          if (op.blockedBy !== undefined) {
            const blockedById = resolveRef(op.blockedBy);
            // Match the human editor's hidden-current-blocker guard at the
            // actual mutation boundary. Lifecycle filters are intentionally
            // omitted for the current edge so a still-visible archived blocker
            // may be disconnected, while a newly private edge cannot be
            // changed by a proposal that was validated before that transition.
            if (task.blockedById) {
              const visibleCurrentBlocker = await tx.task.findFirst({
                where: {
                  id: task.blockedById,
                  projectId,
                  private: false,
                  AND: [
                    { OR: [{ epicId: null }, { epic: { private: false } }] },
                    {
                      OR: [
                        { parentTaskId: null },
                        { parent: { private: false, OR: [{ epicId: null }, { epic: { private: false } }] } },
                      ],
                    },
                  ],
                },
                select: { id: true },
              });
              if (!visibleCurrentBlocker) throw new Error("blockedBy is not editable for this task");
            }
            if (blockedById !== task.blockedById) {
              let blockedByKey: string | null = null;
              if (blockedById) {
                const blocker = await tx.task.findFirst({
                  where: {
                    id: blockedById,
                    projectId,
                    private: false,
                    archivedAt: null,
                    deletedAt: null,
                    AND: [
                      { OR: [{ epicId: null }, { epic: { private: false } }] },
                      {
                        OR: [
                          { parentTaskId: null },
                          { parent: { private: false, OR: [{ epicId: null }, { epic: { private: false } }] } },
                        ],
                      },
                    ],
                  },
                  select: { workItemKey: true },
                });
                if (!blocker) throw new Error("Blocking task not found in this project");
                const check = await validateBlockedBy({
                  taskId: task.id,
                  projectId,
                  blockerId: blockedById,
                  client: tx,
                });
                if (!check.ok) throw new Error(check.message);
                blockedByKey = blocker.workItemKey ?? null;
              }
              data.blockedById = blockedById;
              logs.push({
                kind: "task.blocked_by",
                payload: {
                  from: task.blockedBy?.workItemKey ?? null,
                  to: blockedByKey,
                  proposalId: proposal.id,
                },
              });
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
          let targetStatus = task.status;
          let submitStatusCommand = false;
          if (typeof op.status === "string" && op.status !== task.status) {
            // Proposals must not be a side door around the workflow engine:
            // proposals never bypass the shared start boundary. Even an
            // approved, unblocked proposal targeting In Progress lands in To
            // Do first so action=start can validate/provision the exact linked
            // worktree before any implementation becomes active.
            targetStatus = op.status;
            if (targetStatus === "In Progress") {
              const unresolvedPrerequisites = unresolvedTaskPrerequisites(task);
              const blockerUncleared = unresolvedPrerequisites.length > 0;
              const planUnapproved = !task.approvedOn;
              targetStatus = "To Do";
              logs.push({
                kind: "task.move.downgraded",
                payload: {
                  proposalId: proposal.id,
                  requested: "In Progress",
                  applied: "To Do",
                  reason: blockerUncleared
                    ? "blocker_not_done"
                    : planUnapproved
                      ? "plan_not_approved"
                      : "worktree_validation_required",
                  blockedBy: unresolvedPrerequisites.map((item) => item.workItemKey ?? item.id),
                },
              });
            }
            if (targetStatus !== task.status) {
              if (targetStatus === "Review" || targetStatus === "Done") {
                throw new Error(`Proposal status ${targetStatus} requires the dedicated Review workflow.`);
              }
              const edge = `${task.status}->${targetStatus}`;
              const supportedEdges = new Set([
                "Backlog->To Do",
                "To Do->Backlog",
                "In Progress->To Do",
                "Review->To Do",
                "Done->To Do",
              ]);
              submitStatusCommand = supportedEdges.has(edge);
              if (!submitStatusCommand) {
                throw new Error(`Proposal status edge ${edge} requires a dedicated workflow action.`);
              }
            }
          }
          if (Object.keys(data).length > 0 || submitStatusCommand) {
            if (submitStatusCommand && targetStatus !== task.status) {
              if (!proposalDecisionActor) {
                throw new Error("proposal_status_change_requires_authenticated_human_actor");
              }
              const command: TaskWorkflowCommand = {
                taskId: id,
                intent: "override_status",
                actor: {
                  id: proposalDecisionActor.id,
                  username: proposalDecisionActor.username,
                  kind: "human",
                },
                expectedWorkflowVersion: task.workflowVersion,
                workflowCycleId: task.status === "In Progress" || task.status === "Review"
                  ? undefined
                  : null,
                idempotencyKey: `proposal:${proposal.id}:op:${currentOperationIndex}:status`,
                source: "browser",
                messageId: proposal.grantMessageId,
                evidence: {
                  proposalId: proposal.id,
                  proposedByUserId: agentId,
                  approvedByUserId: proposalDecisionActor.id,
                  operationIndex: currentOperationIndex,
                },
                payload: {
                  targetStatus: targetStatus as TaskWorkflowStatus,
                  reason: `Approved work-item proposal ${proposal.id}`,
                },
              };
              const commandResult = await submitWorkflowCommandInTransaction(tx, command);
              assertProposalCommandApplied(commandResult, currentOperationIndex);
              if (Object.keys(data).length > 0) {
                await tx.task.update({ where: { id }, data });
              }
            } else {
              await tx.task.update({ where: { id }, data });
            }
            for (const l of logs) {
              await tx.activityLog.create({ data: { projectId, taskId: id, userId: typeof l.userId === "string" ? l.userId : agentId, kind: l.kind as string, payload: JSON.stringify(l.payload) } });
            }
            counts.updates++;

            const finalStatus = targetStatus;
            const finalAssigneeId = asg !== undefined ? asg : task.assigneeId;
            const finalActingManagerId = am !== undefined ? am : task.actingManagerId;
            const assignmentChanged = asg !== undefined && asg !== task.assigneeId;
            const statusChanged = finalStatus !== task.status;
            const reviewerId = finalActingManagerId
              ?? (isActionableEpicStatus(task.epic?.status) ? task.epic?.actingManagerId : null)
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
                  body: task.approvedOn
                    ? [
                        `Task "${task.title}" is now in To Do and assigned to you by @${actorUsername ?? "the workflow manager"}.`,
                        "Its Action Plan is approved. Call action=start so PM validates/provisions the linked worktree before moving it to In Progress.",
                      ].join("\n")
                    : taskWorkflowBody({
                        title: task.title,
                        actorUsername,
                        reason: "todo_start_required",
                      }),
                });
              } else if (finalStatus === "In Progress") {
                // Previously the ONLY status transition that dispatched no
                // wake — an applied proposal could park an agent's task In
                // Progress while the agent never learned about it (observed
                // 27-minute stall on PH-110).
                workflowNotifications.push({
                  taskId: id,
                  targetUserId: finalAssigneeId,
                  reason: "todo_start_required",
                  body: [
                    `Task "${task.title}" was assigned to you and moved to In Progress via an applied proposal by @${actorUsername}.`,
                    "Start (or continue) implementation now using the full task context. If the Action Plan thread is empty, post your concise plan there first.",
                  ].join("\n"),
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
            data: { taskId: id, userId: agentId, body, commentKind: "workflow_action", isGenerated: true },
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

      for (const [notificationIndex, notification] of workflowNotifications.entries()) {
        const state = await tx.task.findUnique({
          where: { id: notification.taskId },
          select: { projectId: true, workflowVersion: true },
        });
        if (!state) continue;
        await enqueueWorkflowEffects(tx, {
          taskId: notification.taskId,
          projectId: state.projectId,
          aggregateVersion: state.workflowVersion,
          effects: [{
            type: "task_notification",
            key: `proposal:${proposal.id}:notification:${notificationIndex}:${notification.targetUserId}`,
            payload: {
              taskId: notification.taskId,
              targetUserId: notification.targetUserId,
              actor: {
                id: agentId,
                username: actorUsername,
                kind: actorUser?.kind === "agent" ? "agent" : "human",
              },
              reason: notification.reason,
              body: notification.body,
            },
          }],
        });
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
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      projectSlug,
      agentSlug,
      taskId,
      epicId,
      counts: ZERO,
    };
  }

  const actor = {
    id: agentId,
    username: actorUsername,
    kind: actorUser?.kind === "agent" ? "agent" as const : "human" as const,
  };
  await drainWorkflowOutbox({ limit: Math.max(1, workflowNotifications.length) }).catch(() => {});
  await Promise.allSettled([
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
