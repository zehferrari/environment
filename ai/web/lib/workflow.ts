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

// Allowed direct transitions per Stage 0 / HOMELAB-44:
//   Backlog → To Do
//   To Do → In Progress  (also reversible to Backlog for re-triage)
//   In Progress → Review (also reversible to To Do if work is dropped)
//   Review → Done        (also reversible to In Progress if review re-opens)
//   Done → Review        (re-open path; final close is still Done)
//
// "Reversible" edges exist for humans walking work back; agents are
// further constrained by EXPLICIT_USER_TARGETS below so they cannot
// reach Review/Done implicitly.
const ALLOWED: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  Backlog: new Set<TaskStatus>(["To Do"]),
  "To Do": new Set<TaskStatus>(["In Progress", "Backlog"]),
  "In Progress": new Set<TaskStatus>(["Review", "To Do"]),
  Review: new Set<TaskStatus>(["Done", "In Progress"]),
  Done: new Set<TaskStatus>(["Review"]),
};

// Review and Done are explicit human actions per TEAM_WORKFLOW.md and
// HOMELAB-44 Steps. The agent-ack auto-transition (see below) is bounded
// to To Do → In Progress and never crosses these.
const EXPLICIT_USER_TARGETS: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "Review",
  "Done",
]);

export type ActorKind = "human" | "agent";

export type WorkflowErrorCode =
  | "INVALID_STATUS"
  | "INVALID_TRANSITION"
  | "EXPLICIT_USER_ACTION_REQUIRED"
  | "AGENT_SELF_ASSIGN"
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
// agent attempts to reach Review/Done. A no-op (from === to) is OK.
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

  if (input.actor.kind === "agent" && EXPLICIT_USER_TARGETS.has(input.to)) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: `Transition to ${input.to} requires an explicit human action.`,
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

export interface AckInput {
  status: TaskStatus | string;
  actor: { id: string; kind: ActorKind };
  assigneeId: string | null;
}

// Agent-ack auto-transition: when an agent acknowledges a wake on a
// task they are assigned to and the task is in To Do, the server moves
// the task to In Progress. Returns the next status, or null when no
// auto-transition applies. This is the only path where an agent
// advances status without an explicit human action.
export function autoTransitionOnAck(input: AckInput): TaskStatus | null {
  if (input.actor.kind !== "agent") return null;
  if (input.assigneeId !== input.actor.id) return null;
  if (input.status !== "To Do") return null;
  return "In Progress";
}
