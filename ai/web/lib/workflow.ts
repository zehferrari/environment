// Workflow rule enforcement for the PM webapp (HOMELAB-44 Stage 2).
// Pure server-side rules. API routes and server actions must call these
// before persisting transitions/assignments — workflow validity is not
// allowed to be UI-only (see HOMELAB-44 commentId 12180).
//
// Status labels are verbatim per Stage 0 sign-off (HOMELAB-42 Q4):
//   Backlog | To Do | In Progress | Review | Done
// No Jira-style aliases are accepted on the API surface.

export const TASK_STATUSES = [
  "Backlog",
  "To Do",
  "In Progress",
  "Review",
  "Done",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}

// Allowed direct transitions per Stage 0 / HOMELAB-44, amended by the
// 2026-07 workflow overhaul (P1):
//   Backlog → To Do
//   To Do → In Progress  (also reversible to Backlog for re-triage)
//   In Progress → Review (also reversible to To Do if work is dropped)
//   Review → Done        (review feedback returns Review → To Do FRONT via
//                         the agent workflow endpoint's review_feedback
//                         action or a human drag — there is NO
//                         Review → In Progress resume edge)
//   Done → Review        (re-open path; final close is still Done)
//
// "Reversible" edges exist for humans walking work back. Browser-session
// agent form edits are still constrained by EXPLICIT_USER_STATES below;
// role-aware agent transitions use /api/agent/tasks/[taskId]/workflow,
// where assignment/reviewer authority is validated against the live task.
const ALLOWED: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  Backlog: new Set<TaskStatus>(["To Do"]),
  "To Do": new Set<TaskStatus>(["In Progress", "Backlog"]),
  "In Progress": new Set<TaskStatus>(["Review", "To Do"]),
  Review: new Set<TaskStatus>(["Done"]),
  Done: new Set<TaskStatus>(["Review"]),
};

// Review and Done are blocked for generic agent form edits because the
// task role is not part of this small structural helper. The native
// agent workflow endpoint applies the newer PM policy: assignees may
// send completed work to Review, and resolved reviewers may move Review
// to Done or leave feedback.
const EXPLICIT_USER_STATES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "Review",
  "Done",
]);

export type ActorKind = "human" | "agent";

export type WorkflowErrorCode =
  | "INVALID_STATUS"
  | "INVALID_TRANSITION"
  | "EXPLICIT_USER_ACTION_REQUIRED"
  | "AGENT_SELF_ASSIGN"
  | "AGENT_SELF_ACTING_MANAGER"
  | "PARENT_REQUIRED"
  | "PARENT_NOT_ALLOWED";

export type RuleOk = { ok: true };
export type RuleFail = {
  ok: false;
  code: WorkflowErrorCode;
  message: string;
};
export type RuleResult = RuleOk | RuleFail;

export interface TransitionInput {
  from: TaskStatus | string;
  to: TaskStatus | string;
  actor: { id: string; kind: ActorKind };
}

// Validate that `actor` may move a task from `from` to `to`.
// Rejects unknown statuses (string fall-through), disallowed edges, and
// agent attempts to enter or leave Review/Done. A no-op (from === to)
// is OK.
export function checkStatusTransition(input: TransitionInput): RuleResult {
  if (!isTaskStatus(input.from)) {
    return {
      ok: false,
      code: "INVALID_STATUS",
      message: `Unknown from-status: ${String(input.from)}`,
    };
  }
  if (!isTaskStatus(input.to)) {
    return {
      ok: false,
      code: "INVALID_STATUS",
      message: `Unknown to-status: ${String(input.to)}`,
    };
  }
  if (input.from === input.to) return { ok: true };

  const next = ALLOWED[input.from];
  if (!next.has(input.to)) {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      message: `Transition ${input.from} → ${input.to} is not allowed.`,
    };
  }

  if (
    input.actor.kind === "agent" &&
    (EXPLICIT_USER_STATES.has(input.from) ||
      EXPLICIT_USER_STATES.has(input.to))
  ) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: `Transition ${input.from} → ${input.to} touches Review/Done and requires the native PM workflow endpoint or a human action.`,
    };
  }

  if (
    input.actor.kind === "agent" &&
    input.from === "Backlog" &&
    input.to === "To Do"
  ) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message:
        "Agents cannot promote Backlog work through generic board moves; use the native PM workflow endpoint so reviewer authority is checked.",
    };
  }

  return { ok: true };
}

export interface AssignmentInput {
  actor: { id: string; kind: ActorKind };
  newAssigneeId: string | null;
}

// Agents may not self-assign tasks (TEAM_WORKFLOW.md). Unassign and
// human-driven assignments are allowed. Lookup of whether the assignee
// exists / is active is the caller's responsibility — this is the rule.
export function checkAssignment(input: AssignmentInput): RuleResult {
  if (input.newAssigneeId === null) return { ok: true };
  if (
    input.actor.kind === "agent" &&
    input.newAssigneeId === input.actor.id
  ) {
    return {
      ok: false,
      code: "AGENT_SELF_ASSIGN",
      message: "Agents cannot self-assign tasks.",
    };
  }
  return { ok: true };
}

export interface ActingManagerInput {
  actor: { id: string; kind: ActorKind };
  newActingManagerId: string | null;
}

// Agents may not set themselves as a task's acting manager — the
// acting manager is the workflow owner / reviewer for the task and
// agents reviewing their own work would defeat the purpose. Mirrors
// the no-self-assign rule. Unsetting (null) and human-driven changes
// are allowed. Caller is responsible for verifying the target user
// exists and is active.
export function checkActingManager(input: ActingManagerInput): RuleResult {
  if (input.newActingManagerId === null) return { ok: true };
  if (
    input.actor.kind === "agent" &&
    input.newActingManagerId === input.actor.id
  ) {
    return {
      ok: false,
      code: "AGENT_SELF_ACTING_MANAGER",
      message: "Agents cannot set themselves as a task's acting manager.",
    };
  }
  return { ok: true };
}

export type HierarchyLevel = "task" | "subtask";

export interface HierarchyInput {
  level: HierarchyLevel;
  parentTaskId: string | null;
}

// Sub-tasks must have parentTaskId; top-level tasks must not.
// Epic ⇄ Task linkage is enforced by the API caller against the project.
export function checkHierarchy(input: HierarchyInput): RuleResult {
  if (input.level === "subtask") {
    if (!input.parentTaskId) {
      return {
        ok: false,
        code: "PARENT_REQUIRED",
        message: "Sub-task requires parentTaskId.",
      };
    }
    return { ok: true };
  }
  if (input.parentTaskId) {
    return {
      ok: false,
      code: "PARENT_NOT_ALLOWED",
      message: "Top-level task must not have parentTaskId.",
    };
  }
  return { ok: true };
}

// Agent-ack auto-transition was removed (2026-07 workflow overhaul): an ack
// is a liveness ping only and never changes task status. Entering In Progress
// happens exclusively through the workflow endpoint's `start` action (or
// PM auto-start), where the per-project WIP and branch-clash guards run.
// See app/api/tasks/[id]/ack/route.ts.
