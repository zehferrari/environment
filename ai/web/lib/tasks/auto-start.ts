import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { epicAllowsAgentAction } from "@/lib/tasks/workflow-actors";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";
import type { OrchestratorResult } from "@/lib/tasks/orchestrator/types";
import { unresolvedTaskPrerequisites } from "@/lib/tasks/blocking";

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

type DbClient = Prisma.TransactionClient | typeof db;

export type StartConflict = {
  kind: "wip" | "branch";
  activeTask: { id: string; title: string; workItemKey?: string | null };
};

// Shared entry gate for In Progress (P4): every path that moves a task to
// In Progress (explicit workflow `start` AND PM auto-start) must pass both
// checks. Returns the first conflict found, or null when the task may start.
//
// 1. WIP limit — ≤1 In Progress task per agent per PROJECT. Review does not
//    count; assignment eligibility (To Do+In Progress) is a separate rule in
//    lib/epics/assignment.ts.
// 2. Branch-keyed serialization — never let two tasks that resolve to the
//    SAME effective branch be In Progress at once: two agents editing one
//    branch collide. Per-task branches (lib/work-items/branches.ts) make Epic
//    siblings independent; an explicit shared branchName (manager-forced
//    co-development) or a legacy shared Epic branch still serializes here
//    regardless of which agent holds each task.
export async function findInProgressStartConflict(
  client: DbClient,
  args: {
    taskId: string;
    projectId: string;
    assigneeId: string;
    candidateBranch: string | null;
  },
): Promise<StartConflict | null> {
  const activeTask = await client.task.findFirst({
    where: {
      id: { not: args.taskId },
      projectId: args.projectId,
      assigneeId: args.assigneeId,
      status: "In Progress",
      archivedAt: null,
      deletedAt: null,
    },
    orderBy: [{ statusChangedAt: "asc" }, { updatedAt: "asc" }],
    select: { id: true, title: true, workItemKey: true },
  });
  if (activeTask) return { kind: "wip", activeTask };

  if (args.candidateBranch) {
    const branchPeers = await client.task.findMany({
      where: {
        id: { not: args.taskId },
        projectId: args.projectId,
        status: "In Progress",
        archivedAt: null,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        workItemKey: true,
        branchName: true,
        epic: { select: { workItemKey: true, branchName: true } },
      },
    });
    const branchClash = branchPeers.find(
      (peer) => effectiveTaskBranchName(peer) === args.candidateBranch,
    );
    if (branchClash) {
      return {
        kind: "branch",
        activeTask: { id: branchClash.id, title: branchClash.title, workItemKey: branchClash.workItemKey },
      };
    }
  }
  return null;
}

export type TaskAutoStartResult =
  | {
      started: true;
      task: {
        id: string;
        title: string;
        projectId: string;
        projectSlug: string;
        assigneeId: string;
        assigneeUsername: string;
      };
    }
  | {
      started: false;
      reason:
        | "not_found"
        | "not_todo"
        | "not_approved"
        | "not_agent_assignee"
        | "blocked"
        | "epic_not_ready"
        | "busy"
        | "changed"
        | "command_rejected";
      activeTask?: { id: string; title: string } | null;
      task?: { id: string; title: string; projectSlug: string; assigneeId: string | null } | null;
      commandResult?: OrchestratorResult;
    };

export type PolicyTrigger = {
  kind: "command_receipt" | "workflow_transition" | "monitor_incident" | "policy_event";
  id: string;
};

function policyIdentityPart(value: string, maxLength = 160) {
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, maxLength) || "unspecified";
}

function mapRejectedStart(
  result: Exclude<OrchestratorResult, { status: "accepted" | "replayed" }>,
  task: { id: string; title: string; projectSlug: string; assigneeId: string | null },
): TaskAutoStartResult {
  if (result.status === "stale") {
    return { started: false, reason: "changed", task, commandResult: result };
  }
  if (result.domainCode === "wip_conflict" || result.domainCode === "branch_collision") {
    return { started: false, reason: "busy", task, commandResult: result };
  }
  if (result.domainCode === "prerequisites_unmet") {
    return { started: false, reason: "blocked", task, commandResult: result };
  }
  if (result.domainCode === "epic_not_actionable") {
    return { started: false, reason: "epic_not_ready", task, commandResult: result };
  }
  return { started: false, reason: "command_rejected", task, commandResult: result };
}

export async function startApprovedTodoTaskIfIdle(args: {
  taskId: string;
  actor: Actor;
  via: string;
  trigger?: PolicyTrigger;
  selectionReason?: string;
}): Promise<TaskAutoStartResult> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      workflowVersion: true,
      projectId: true,
      assigneeId: true,
      approvedOn: true,
      deletedAt: true,
      workItemKey: true,
      branchName: true,
      blockedById: true,
      blockedBy: { select: { id: true, title: true, status: true, workItemKey: true } },
      dependencies: {
        select: {
          prerequisite: { select: { id: true, title: true, status: true, workItemKey: true } },
        },
      },
      epicId: true,
      epic: { select: { status: true, workItemKey: true, branchName: true } },
      project: { select: { slug: true } },
      assignee: {
        select: {
          id: true,
          username: true,
          kind: true,
          status: true,
          agent: { select: { role: true, deactivatedAt: true } },
        },
      },
    },
  });

  if (!task || task.deletedAt) return { started: false, reason: "not_found", task: null };
  const taskRef = {
    id: task.id,
    title: task.title,
    projectSlug: task.project.slug,
    assigneeId: task.assigneeId,
  };
  if (task.status !== "To Do") return { started: false, reason: "not_todo", task: taskRef };
  if (!task.approvedOn) return { started: false, reason: "not_approved", task: taskRef };
  if (
    !task.assigneeId ||
    task.assignee?.kind !== "agent" ||
    task.assignee.status !== "active" ||
    !task.assignee.agent ||
    task.assignee.agent.role !== "coding" ||
    task.assignee.agent.deactivatedAt
  ) {
    return { started: false, reason: "not_agent_assignee", task: taskRef };
  }
  const [unresolvedPrerequisite] = unresolvedTaskPrerequisites(task);
  if (unresolvedPrerequisite) {
    return {
      started: false,
      reason: "blocked",
      task: taskRef,
      activeTask: {
        id: unresolvedPrerequisite.id,
        title: unresolvedPrerequisite.workItemKey ?? unresolvedPrerequisite.title ?? "another task",
      },
    };
  }
  if (!epicAllowsAgentAction(task)) {
    return { started: false, reason: "epic_not_ready", task: taskRef };
  }

  // Selection is advisory only. The canonical start command repeats WIP,
  // branch, prerequisite, Epic, plan, coding-capability, blocker, version and
  // active-cycle guards at the authoritative transaction boundary.
  const conflict = await findInProgressStartConflict(db, {
    taskId: task.id,
    projectId: task.projectId,
    assigneeId: task.assigneeId,
    candidateBranch: effectiveTaskBranchName(task),
  });
  if (conflict) {
    return {
      started: false,
      reason: "busy",
      task: taskRef,
      activeTask: { id: conflict.activeTask.id, title: conflict.activeTask.title },
    };
  }

  const trigger = args.trigger ?? { kind: "policy_event" as const, id: args.via };
  const selectionReason = args.selectionReason ?? "approved_todo_assignee_lane_idle";
  const result = await submitWorkflowCommand({
    taskId: task.id,
    intent: "start_implementation",
    actor: args.actor,
    expectedWorkflowVersion: task.workflowVersion,
    workflowCycleId: null,
    idempotencyKey: [
      "pm-policy:start",
      policyIdentityPart(trigger.kind),
      policyIdentityPart(trigger.id),
      policyIdentityPart(selectionReason, 120),
      task.id,
      task.assigneeId,
      `v${task.workflowVersion}`,
    ].join(":"),
    source: "pm-service",
    payload: { worktreePath: null, branchName: effectiveTaskBranchName(task) },
    evidence: {
      policy: "auto_start",
      trigger,
      selectionReason,
      assigneeLane: `${task.projectId}:${task.assigneeId}`,
      selectedTaskId: task.id,
      selectedAssigneeId: task.assigneeId,
      expectedWorkflowVersion: task.workflowVersion,
      via: args.via,
    },
  });
  if (result.status !== "accepted" && result.status !== "replayed") {
    return mapRejectedStart(result, taskRef);
  }

  return {
    started: true,
    task: {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      projectSlug: task.project.slug,
      assigneeId: task.assigneeId,
      assigneeUsername: task.assignee.username,
    },
  };
}
