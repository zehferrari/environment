// Work-item proposal model + validator (agent planning, propose→approve).
//
// An agent that received a per-conversation "manage work items" grant
// submits a *change-set* of typed operations against one project. PM
// stores it as a pending WorkItemProposal; a human later approves it,
// at which point the operations are applied (lib/work-items/actions.ts,
// Slice 3).
//
// validateProposal runs the same structural workflow rules the UI uses
// (known statuses, allowed transitions, hierarchy, active principals),
// but under human-triggered grant semantics. Any coding agent may propose
// changes anywhere in the project when the current human message grants
// that capability; nothing is applied until a human reviews and approves
// the proposal. Created items always land in Backlog (tasks and epics)
// (epics), matching createTask/createEpic.
//
// Reference scheme: items created within the same proposal are addressed
// by a temp ref that MUST start with "tmp:" (e.g. "tmp:epic1"). Anything
// else is treated as an existing row id and is scoped to the project.
// This keeps temp refs unambiguous against cuid ids.

import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import {
  checkActingManager,
  checkAssignment,
  checkHierarchy,
  checkStatusTransition,
  isTaskStatus,
} from "@/lib/workflow";

export const MAX_OPS = 100;
const MAX_TITLE = 200;
const MAX_BODY = 8000;
const MAX_DESCRIPTION = 20000;

export const EPIC_STATUSES = ["Backlog", "Open", "Done"] as const;
type EpicStatus = (typeof EPIC_STATUSES)[number];

// A principal reference is a username (optionally @-prefixed) or null to
// unset. Resolved against lib/principals.ts (active humans + coding agents).
export type PrincipalRef = string | null;

export type ProposalOp =
  | {
      op: "create_epic";
      ref: string;
      title: string;
      description?: string | null;
      assignee?: PrincipalRef;
      actingManager?: PrincipalRef;
    }
  | {
      op: "create_task";
      ref: string;
      title: string;
      description?: string | null;
      epic?: string | null;
      assignee?: PrincipalRef;
      actingManager?: PrincipalRef;
    }
  | {
      op: "create_subtask";
      ref: string;
      parent: string;
      title: string;
      description?: string | null;
      assignee?: PrincipalRef;
      actingManager?: PrincipalRef;
    }
  | {
      op: "update_epic";
      target: string;
      title?: string;
      description?: string | null;
      assignee?: PrincipalRef;
      actingManager?: PrincipalRef;
      status?: string;
    }
  | {
      op: "update_task";
      target: string;
      title?: string;
      description?: string | null;
      assignee?: PrincipalRef;
      actingManager?: PrincipalRef;
      epic?: string | null;
      parent?: string | null;
      status?: string;
    }
  | { op: "comment_task"; target: string; body: string };

export const CREATE_OPS = ["create_epic", "create_task", "create_subtask"] as const;
const KNOWN_OPS = new Set<string>([
  ...CREATE_OPS,
  "update_epic",
  "update_task",
  "comment_task",
]);

export interface OpResult {
  index: number;
  op: string;
  ref: string | null;
  ok: boolean;
  errors: string[];
}

export interface ProposalValidation {
  ok: boolean;
  opCount: number;
  results: OpResult[];
}

export interface ProposalActor {
  // The agent's seeded User id, used for attribution and token identity.
  // Proposal validation itself follows human-triggered grant semantics.
  userId: string;
  agentSlug: string;
}

function isTempRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("tmp:");
}

function rootError(message: string, opCount: number): ProposalValidation {
  return {
    ok: false,
    opCount,
    results: [{ index: -1, op: "(root)", ref: null, ok: false, errors: [message] }],
  };
}

export async function validateProposal(
  projectId: string,
  rawOperations: unknown,
  actor: ProposalActor,
): Promise<ProposalValidation> {
  if (!Array.isArray(rawOperations)) {
    return rootError("operations must be a JSON array", 0);
  }
  if (rawOperations.length === 0) {
    return rootError("operations is empty", 0);
  }
  if (rawOperations.length > MAX_OPS) {
    return rootError(`too many operations (max ${MAX_OPS})`, rawOperations.length);
  }

  const ops = rawOperations.map((value) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {},
  );

  // Pass 1 — collect declared temp refs (classified by created kind) and
  // every existing-id reference, so the DB lookups can be batched.
  const epicRefs = new Set<string>();
  const taskRefs = new Set<string>();
  const declaredRefDup = new Set<string>();
  const epicIds = new Set<string>();
  const taskIds = new Set<string>();

  const addExistingEpic = (value: unknown) => {
    if (typeof value === "string" && value && !isTempRef(value)) epicIds.add(value);
  };
  const addExistingTask = (value: unknown) => {
    if (typeof value === "string" && value && !isTempRef(value)) taskIds.add(value);
  };

  for (const raw of ops) {
    const op = typeof raw.op === "string" ? raw.op : "";
    if (op === "create_epic" || op === "create_task" || op === "create_subtask") {
      const ref = typeof raw.ref === "string" ? raw.ref : "";
      if (isTempRef(ref)) {
        if (epicRefs.has(ref) || taskRefs.has(ref)) declaredRefDup.add(ref);
        else if (op === "create_epic") epicRefs.add(ref);
        else taskRefs.add(ref);
      }
    }
    if (op === "create_task") addExistingEpic(raw.epic);
    if (op === "create_subtask") addExistingTask(raw.parent);
    if (op === "update_epic") addExistingEpic(raw.target);
    if (op === "update_task") {
      addExistingTask(raw.target);
      addExistingEpic(raw.epic);
      addExistingTask(raw.parent);
    }
    if (op === "comment_task") addExistingTask(raw.target);
  }

  const [loadedEpicRows, loadedTaskRows, existingEpicTaskCounts, existingSubtaskCounts, principals] = await Promise.all([
    epicIds.size
      ? db.epic.findMany({
          where: { id: { in: [...epicIds] }, projectId, archivedAt: null, deletedAt: null },
          select: { id: true, status: true, approvedOn: true, actingManagerId: true },
        })
      : Promise.resolve([] as Array<{ id: string; status: string; approvedOn: Date | null; actingManagerId: string | null }>),
    taskIds.size
      ? db.task.findMany({
          where: { id: { in: [...taskIds] }, projectId, archivedAt: null, deletedAt: null },
          select: { id: true, status: true, parentTaskId: true, assigneeId: true, approvedOn: true },
        })
      : Promise.resolve([] as Array<{
          id: string;
          status: string;
          parentTaskId: string | null;
          assigneeId: string | null;
          approvedOn: Date | null;
        }>),
    epicIds.size
      ? db.task.groupBy({
          by: ["epicId"],
          where: {
            projectId,
            epicId: { in: [...epicIds] },
            parentTaskId: null,
            deletedAt: null,
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ epicId: string | null; _count: { _all: number } }>),
    taskIds.size
      ? db.task.groupBy({
          by: ["parentTaskId"],
          where: {
            projectId,
            parentTaskId: { in: [...taskIds] },
            deletedAt: null,
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ parentTaskId: string | null; _count: { _all: number } }>),
    listAssignablePrincipals(),
  ]);

  const loadedEpics = new Map(loadedEpicRows.map((e) => [e.id, e]));
  const loadedTasks = new Map(loadedTaskRows.map((t) => [t.id, t]));
  const topLevelTaskCountByEpic = new Map(
    existingEpicTaskCounts.flatMap((row) => row.epicId ? [[row.epicId, row._count._all] as const] : []),
  );
  const childTaskCountByParent = new Map(
    existingSubtaskCounts.flatMap((row) => row.parentTaskId ? [[row.parentTaskId, row._count._all] as const] : []),
  );
  const byUsername = new Map(principals.map((p) => [p.username, p]));

  // ---- per-op field validators (closures over the loaded maps) ----

  const validateTitle = (value: unknown, errors: string[], required: boolean) => {
    if (value === undefined) {
      if (required) errors.push("title is required");
      return;
    }
    if (typeof value !== "string" || !value.trim()) {
      errors.push("title must be a non-empty string");
      return;
    }
    if (value.length > MAX_TITLE) errors.push(`title exceeds ${MAX_TITLE} chars`);
  };

  const validateDescription = (value: unknown, errors: string[]) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string") {
      errors.push("description must be a string or null");
      return;
    }
    if (value.length > MAX_DESCRIPTION) errors.push(`description exceeds ${MAX_DESCRIPTION} chars`);
  };

  const validatePrincipal = (
    value: unknown,
    errors: string[],
    label: "assignee" | "actingManager",
  ) => {
    if (value === undefined || value === null) return; // unchanged / unset
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${label} must be a username string or null`);
      return;
    }
    const username = value.replace(/^@/, "");
    const principal = byUsername.get(username);
    if (!principal) {
      errors.push(`${label} @${username} is not an active assignable principal`);
      return;
    }
    // Agents may not propose themselves as assignee or acting manager
    // (lib/workflow self-* rules — TEAM_WORKFLOW.md). `actor` is the proposing
    // agent and principal.id is the resolved User id, so a self-proposal matches.
    const selfCheck =
      label === "assignee"
        ? checkAssignment({
            actor: { id: actor.userId, kind: "agent" },
            newAssigneeId: principal.id,
          })
        : checkActingManager({
            actor: { id: actor.userId, kind: "agent" },
            newActingManagerId: principal.id,
          });
    if (!selfCheck.ok) errors.push(selfCheck.message);
  };

  // Epic reference for create_task.epic / update_task.epic — tmp ref to a
  // create_epic in this set, or an existing project epic id, or null.
  const validateEpicLink = (value: unknown, errors: string[]) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string" || !value) {
      errors.push("epic must be an epic ref/id string or null");
      return;
    }
    if (isTempRef(value)) {
      if (!epicRefs.has(value)) errors.push(`epic ref ${value} is not declared by a create_epic in this proposal`);
    } else if (!loadedEpics.has(value)) {
      errors.push(`epic ${value} not found in this project`);
    }
  };

  // Parent reference — tmp ref to a created task/subtask, or existing task id.
  const validateParentLink = (value: unknown, errors: string[], required: boolean) => {
    if (value === undefined || value === null) {
      if (required) errors.push("parent is required for a sub-task");
      return;
    }
    if (typeof value !== "string" || !value) {
      errors.push("parent must be a task ref/id string or null");
      return;
    }
    if (isTempRef(value)) {
      if (!taskRefs.has(value)) errors.push(`parent ref ${value} is not declared by a create_task/create_subtask in this proposal`);
    } else if (!loadedTasks.has(value)) {
      errors.push(`parent task ${value} not found in this project`);
    }
  };

  // Existing-id target for update_*/comment_task. Returns the loaded row.
  const requireExistingEpic = (value: unknown, errors: string[]) => {
    if (typeof value !== "string" || !value) {
      errors.push("target epic id is required");
      return null;
    }
    if (isTempRef(value)) {
      errors.push("update_epic target must be an existing epic id, not a tmp ref");
      return null;
    }
    const row = loadedEpics.get(value);
    if (!row) errors.push(`epic ${value} not found in this project`);
    return row ?? null;
  };

  const requireExistingTask = (value: unknown, errors: string[]) => {
    if (typeof value !== "string" || !value) {
      errors.push("target task id is required");
      return null;
    }
    if (isTempRef(value)) {
      errors.push("target must be an existing task id, not a tmp ref");
      return null;
    }
    const row = loadedTasks.get(value);
    if (!row) errors.push(`task ${value} not found in this project`);
    return row ?? null;
  };

  const validateTaskStatus = (
    value: unknown,
    errors: string[],
    fromStatus: string | null,
  ) => {
    if (value === undefined) return;
    if (!isTaskStatus(value)) {
      errors.push(`unknown task status: ${String(value)}`);
      return;
    }
    if (fromStatus !== null) {
      // Proposals are agent-driven: pass kind "agent" so checkStatusTransition
      // enforces the Review/Done (EXPLICIT_USER_STATES) guard — e.g. a Done task
      // cannot be re-opened to Review via a generic proposal; that must go
      // through the native PM workflow endpoint where reviewer authority is checked.
      const check = checkStatusTransition({
        from: fromStatus,
        to: value,
        actor: { id: actor.userId, kind: "agent" },
      });
      if (!check.ok) errors.push(check.message);
    }
  };

  // ---- Pass 2 — validate each op ----
  const results: OpResult[] = ops.map((raw, index) => {
    const op = typeof raw.op === "string" ? raw.op : "";
    const ref = typeof raw.ref === "string" ? raw.ref : null;
    const errors: string[] = [];

    if (!KNOWN_OPS.has(op)) {
      errors.push(op ? `unknown op: ${op}` : "op is required");
      return { index, op: op || "(missing)", ref, ok: false, errors };
    }

    if (ref && declaredRefDup.has(ref)) errors.push(`duplicate ref ${ref}`);
    if (CREATE_OPS.includes(op as (typeof CREATE_OPS)[number]) && !isTempRef(ref)) {
      errors.push(`${op} requires a 'ref' starting with "tmp:"`);
    }

    switch (op) {
      case "create_epic": {
        validateTitle(raw.title, errors, true);
        validateDescription(raw.description, errors);
        validatePrincipal(raw.assignee, errors, "assignee");
        validatePrincipal(raw.actingManager, errors, "actingManager");
        break;
      }
      case "create_task": {
        validateTitle(raw.title, errors, true);
        validateDescription(raw.description, errors);
        validateEpicLink(raw.epic, errors);
        if (isTempRef(raw.epic)) {
          errors.push("create_task under a newly created Epic is not allowed; approve the Epic Action Plan first, then the Epic acting manager can create the initial top-level task breakdown.");
        }
        if (
          typeof raw.epic === "string" &&
          raw.epic &&
          !isTempRef(raw.epic) &&
          (topLevelTaskCountByEpic.get(raw.epic) ?? 0) > 0
        ) {
          errors.push("epic already has top-level tasks; do not create additional Epic implementation tasks from an agent proposal. Use create_subtask for task-local checklist steps or ask a human to add another Epic task explicitly.");
        }
        if (typeof raw.epic === "string" && raw.epic && !isTempRef(raw.epic)) {
          const epic = loadedEpics.get(raw.epic);
          if (epic && !epic.approvedOn) {
            errors.push("Epic Action Plan must be approved before creating top-level Epic tasks.");
          }
          if (epic && epic.actingManagerId !== actor.userId) {
            errors.push("Only the Epic acting manager can create the initial top-level task breakdown.");
          }
        }
        validatePrincipal(raw.assignee, errors, "assignee");
        validatePrincipal(raw.actingManager, errors, "actingManager");
        const h = checkHierarchy({ level: "task", parentTaskId: null });
        if (!h.ok) errors.push(h.message);
        break;
      }
      case "create_subtask": {
        validateTitle(raw.title, errors, true);
        validateDescription(raw.description, errors);
        validateParentLink(raw.parent, errors, true);
        if (isTempRef(raw.parent)) {
          errors.push("create_subtask requires an existing approved parent Task; newly created Tasks need Action Plan approval before subtasks can be created.");
        }
        if (typeof raw.parent === "string" && raw.parent && !isTempRef(raw.parent)) {
          const parent = loadedTasks.get(raw.parent);
          if (parent?.parentTaskId) {
            errors.push("Subtasks can only be created directly under top-level Tasks, not under another subtask.");
          }
          if (parent && !parent.approvedOn) {
            errors.push("Task Action Plan must be approved before creating task-local subtasks.");
          }
          if (parent && parent.assigneeId !== actor.userId) {
            errors.push("Only the task assignee can create task-local subtasks.");
          }
          if ((childTaskCountByParent.get(raw.parent) ?? 0) > 0) {
            errors.push("Task-local subtasks can only be created when the parent Task has no existing child subtasks.");
          }
        }
        validatePrincipal(raw.assignee, errors, "assignee");
        validatePrincipal(raw.actingManager, errors, "actingManager");
        const parentId = typeof raw.parent === "string" ? raw.parent : "x";
        const h = checkHierarchy({ level: "subtask", parentTaskId: parentId });
        if (!h.ok) errors.push(h.message);
        break;
      }
      case "update_epic": {
        requireExistingEpic(raw.target, errors);
        validateTitle(raw.title, errors, false);
        validateDescription(raw.description, errors);
        validatePrincipal(raw.assignee, errors, "assignee");
        validatePrincipal(raw.actingManager, errors, "actingManager");
        if (raw.status !== undefined && !EPIC_STATUSES.includes(raw.status as EpicStatus)) {
          errors.push(`unknown epic status: ${String(raw.status)}`);
        }
        break;
      }
      case "update_task": {
        const row = requireExistingTask(raw.target, errors);
        validateTitle(raw.title, errors, false);
        validateDescription(raw.description, errors);
        validateEpicLink(raw.epic, errors);
        if (raw.parent !== undefined) {
          validateParentLink(raw.parent, errors, false);
          if (typeof raw.parent === "string" && raw.parent === raw.target) {
            errors.push("a task cannot be its own parent");
          }
        }
        validatePrincipal(raw.assignee, errors, "assignee");
        validatePrincipal(raw.actingManager, errors, "actingManager");
        validateTaskStatus(raw.status, errors, row?.status ?? null);
        break;
      }
      case "comment_task": {
        requireExistingTask(raw.target, errors);
        if (typeof raw.body !== "string" || !raw.body.trim()) {
          errors.push("comment body must be a non-empty string");
        } else if (raw.body.length > MAX_BODY) {
          errors.push(`comment body exceeds ${MAX_BODY} chars`);
        }
        break;
      }
    }

    return { index, op, ref, ok: errors.length === 0, errors };
  });

  return {
    ok: results.every((r) => r.ok),
    opCount: ops.length,
    results,
  };
}
