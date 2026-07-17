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
  checkStatusTransition,
  checkHierarchy,
  isTaskStatus,
} from "@/lib/workflow";

export const MAX_OPS = 100;
const MAX_TITLE = 200;
const MAX_BODY = 8000;
const MAX_DESCRIPTION = 20000;

export const EPIC_STATUSES = ["Backlog", "In Progress", "Ready to Deploy", "Done"] as const;
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
      actingManager?: PrincipalRef;
      deployReviewer?: PrincipalRef;
    }
  | {
      op: "create_task";
      ref: string;
      title: string;
      description?: string | null;
      epic?: string | null;
      blockedBy?: string | null;
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
      actingManager?: PrincipalRef;
      deployReviewer?: PrincipalRef;
      status?: string;
      alert_reporter?: boolean | number | string | null;
      alertReporter?: boolean | number | string | null;
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
      blockedBy?: string | null;
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
  const subtaskRefs = new Set<string>();
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
        else {
          taskRefs.add(ref);
          if (op === "create_subtask") subtaskRefs.add(ref);
        }
      }
    }
    if (op === "create_task") {
      addExistingEpic(raw.epic);
      addExistingTask(raw.blockedBy);
    }
    if (op === "create_subtask") addExistingTask(raw.parent);
    if (op === "update_epic") addExistingEpic(raw.target);
    if (op === "update_task") {
      addExistingTask(raw.target);
      addExistingEpic(raw.epic);
      addExistingTask(raw.parent);
      addExistingTask(raw.blockedBy);
    }
    if (op === "comment_task") addExistingTask(raw.target);
  }

  const [loadedEpicRows, loadedTaskRows, principals] = await Promise.all([
    epicIds.size
      ? db.epic.findMany({
          where: {
            id: { in: [...epicIds] },
            projectId,
            private: false,
            archivedAt: null,
            deletedAt: null,
          },
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
    taskIds.size
      ? db.task.findMany({
          where: {
            id: { in: [...taskIds] },
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
          select: { id: true, parentTaskId: true, status: true, blockedById: true },
        })
      : Promise.resolve([] as Array<{
          id: string;
          parentTaskId: string | null;
          status: string;
          blockedById: string | null;
        }>),
    listAssignablePrincipals(),
  ]);

  const loadedEpics = new Map(loadedEpicRows.map((e) => [e.id, e]));
  const loadedTasks = new Map(loadedTaskRows.map((t) => [t.id, t]));
  const byUsername = new Map(principals.map((p) => [p.username, p]));

  // Match the human edit form's current-blocker guard: an inaccessible
  // blocker cannot be replaced or cleared through a proposal. Deliberately
  // omit lifecycle filters here because the form still permits disconnecting
  // an already-linked public blocker after it is archived/deleted.
  const blockedByUpdateTargets = new Set(
    ops
      .filter((raw) => raw.op === "update_task" && raw.blockedBy !== undefined)
      .map((raw) => raw.target)
      .filter((id): id is string => typeof id === "string"),
  );
  const currentBlockerIds = [...new Set(
    loadedTaskRows
      .filter((task) => blockedByUpdateTargets.has(task.id))
      .map((task) => task.blockedById)
      .filter((id): id is string => Boolean(id)),
  )];
  const visibleCurrentBlockerRows = currentBlockerIds.length
    ? await db.task.findMany({
        where: {
          id: { in: currentBlockerIds },
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
      })
    : [];
  const visibleCurrentBlockers = new Set(visibleCurrentBlockerRows.map((task) => task.id));

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
    label: "assignee" | "actingManager" | "deployReviewer",
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
    if (label === "deployReviewer" && principal.kind !== "agent") {
      errors.push("deployReviewer must be an active coding agent");
      return;
    }
    if (principal.id === actor.userId || principal.agentSlug === actor.agentSlug) {
      errors.push(`agents cannot set themselves as ${label}`);
    }
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

  // Hard dependency reference for create_task.blockedBy /
  // update_task.blockedBy. A newly proposed top-level task is valid, but a
  // checklist-item ref is not a Task and therefore cannot be a blocker.
  const validateBlockedByLink = (value: unknown, errors: string[]) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string" || !value) {
      errors.push("blockedBy must be a task ref/id string or null");
      return;
    }
    if (isTempRef(value)) {
      if (!taskRefs.has(value) || subtaskRefs.has(value)) {
        errors.push(`blockedBy ref ${value} is not declared by a create_task in this proposal`);
      }
    } else if (!loadedTasks.has(value)) {
      // Intentionally identical for missing, cross-project, private, and
      // otherwise invisible rows so validation cannot disclose private work.
      errors.push("blocking task not found in this project");
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

  const validateTaskStatus = (value: unknown, errors: string[]) => {
    if (value === undefined) return;
    if (!isTaskStatus(value)) {
      errors.push(`unknown task status: ${String(value)}`);
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
        if (raw.actingManager !== undefined && raw.actingManager !== null) {
          errors.push("agent-created epics cannot set an acting manager; the requester is recorded as reporter");
        }
        if (raw.deployReviewer !== undefined && raw.deployReviewer !== null) {
          errors.push("agent-created epics cannot set a deploy reviewer; the requester is recorded as reporter");
        }
        break;
      }
      case "create_task": {
        validateTitle(raw.title, errors, true);
        validateDescription(raw.description, errors);
        validateEpicLink(raw.epic, errors);
        validateBlockedByLink(raw.blockedBy, errors);
        if (typeof raw.blockedBy === "string" && raw.blockedBy === raw.ref) {
          errors.push("A task cannot be blocked by itself.");
        }
        if (raw.assignee !== undefined && raw.assignee !== null) {
          errors.push("agent-created tasks cannot set an assignee; the requester is recorded as reporter");
        }
        if (raw.actingManager !== undefined && raw.actingManager !== null) {
          errors.push("agent-created tasks cannot set a reviewer/acting manager; the requester is recorded as reporter");
        }
        const h = checkHierarchy({ level: "task", parentTaskId: null });
        if (!h.ok) errors.push(h.message);
        break;
      }
      case "create_subtask": {
        validateTitle(raw.title, errors, true);
        validateDescription(raw.description, errors);
        validateParentLink(raw.parent, errors, true);
        if (typeof raw.parent === "string" && isTempRef(raw.parent) && subtaskRefs.has(raw.parent)) {
          errors.push("Subtasks can only be created directly under top-level Tasks, not under another subtask.");
        }
        if (typeof raw.parent === "string" && raw.parent && !isTempRef(raw.parent)) {
          const parent = loadedTasks.get(raw.parent);
          if (parent?.parentTaskId) {
            errors.push("Subtasks can only be created directly under top-level Tasks, not under another subtask.");
          }
        }
        if (raw.assignee !== undefined && raw.assignee !== null) {
          errors.push("agent-created subtasks cannot set an assignee; the requester is recorded as reporter");
        }
        if (raw.actingManager !== undefined && raw.actingManager !== null) {
          errors.push("agent-created subtasks cannot set a reviewer/acting manager; the requester is recorded as reporter");
        }
        const parentId = typeof raw.parent === "string" ? raw.parent : "x";
        const h = checkHierarchy({ level: "subtask", parentTaskId: parentId });
        if (!h.ok) errors.push(h.message);
        break;
      }
      case "update_epic": {
        requireExistingEpic(raw.target, errors);
        validateTitle(raw.title, errors, false);
        validateDescription(raw.description, errors);
        validatePrincipal(raw.actingManager, errors, "actingManager");
        validatePrincipal(raw.deployReviewer, errors, "deployReviewer");
        if (raw.status !== undefined) {
          if (!EPIC_STATUSES.includes(raw.status as EpicStatus)) {
            errors.push(`unknown epic status: ${String(raw.status)}`);
          } else {
            errors.push("agents cannot change Epic status");
          }
        }
        break;
      }
      case "update_task": {
        const target = requireExistingTask(raw.target, errors);
        validateTitle(raw.title, errors, false);
        validateDescription(raw.description, errors);
        validateEpicLink(raw.epic, errors);
        validateBlockedByLink(raw.blockedBy, errors);
        if (raw.blockedBy !== undefined && target?.blockedById && !visibleCurrentBlockers.has(target.blockedById)) {
          errors.push("blockedBy is not editable for this task");
        }
        if (typeof raw.blockedBy === "string" && raw.blockedBy === raw.target) {
          errors.push("A task cannot be blocked by itself.");
        }
        if (raw.parent !== undefined) {
          validateParentLink(raw.parent, errors, false);
          if (typeof raw.parent === "string" && raw.parent === raw.target) {
            errors.push("a task cannot be its own parent");
          }
        }
        validatePrincipal(raw.assignee, errors, "assignee");
        validatePrincipal(raw.actingManager, errors, "actingManager");
        validateTaskStatus(raw.status, errors);
        if (typeof raw.status === "string" && isTaskStatus(raw.status) && target) {
          const transition = checkStatusTransition({
            from: target.status,
            to: raw.status,
            actor: { id: actor.userId, kind: "agent" },
          });
          if (!transition.ok) errors.push(transition.message);
        }
        if (raw.alert_reporter !== undefined && raw.alertReporter !== undefined) errors.push("use only one of alert_reporter or alertReporter");
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

  // Simulate the proposal's dependency graph in apply order before it is
  // stored. This catches cycles spanning several operations (including tmp
  // refs) that a per-operation DB check cannot see. Existing graph tails are
  // followed from the database; a pre-existing unrelated cycle is tolerated
  // like validateBlockedBy(), while a path returning to the changed source is
  // not.
  const dependencyChanges = new Map<string, string | null>();
  const createdDependencies: Array<{ source: string; index: number }> = [];
  for (const [index, raw] of ops.entries()) {
    if (raw.op === "create_task" && typeof raw.ref === "string" && isTempRef(raw.ref)) {
      dependencyChanges.set(raw.ref, typeof raw.blockedBy === "string" ? raw.blockedBy : null);
      createdDependencies.push({ source: raw.ref, index });
    }
  }

  const storedDependency = new Map<string, string | null>();
  const nextDependency = async (taskRef: string): Promise<string | null> => {
    if (dependencyChanges.has(taskRef)) return dependencyChanges.get(taskRef) ?? null;
    if (isTempRef(taskRef)) return null;
    if (storedDependency.has(taskRef)) return storedDependency.get(taskRef) ?? null;
    const row = await db.task.findUnique({
      where: { id: taskRef },
      select: { blockedById: true },
    });
    const next = row?.blockedById ?? null;
    storedDependency.set(taskRef, next);
    return next;
  };

  const validateDependencyPath = async (source: string, index: number) => {
    if (results[index]?.errors.length) return;
    const seen = new Set<string>([source]);
    let current = dependencyChanges.get(source) ?? null;
    while (current) {
      if (current === source) {
        results[index]?.errors.push(
          "That would create a circular block — the chosen task already depends on this one.",
        );
        return;
      }
      if (seen.has(current)) return;
      seen.add(current);
      current = await nextDependency(current);
    }
  };

  // All create_task operations are committed before updates, with tmp blocker
  // refs treated as creation dependencies. Validate that initial graph first.
  for (const change of createdDependencies) {
    await validateDependencyPath(change.source, change.index);
  }

  // Updates are then committed in operation order. Model each edge before
  // validating it so even a transient cycle in a multi-update proposal is
  // rejected exactly where commitProposal() would reject it.
  for (const [index, raw] of ops.entries()) {
    if (
      raw.op !== "update_task"
      || typeof raw.target !== "string"
      || raw.blockedBy === undefined
      || (typeof raw.blockedBy !== "string" && raw.blockedBy !== null)
    ) continue;
    dependencyChanges.set(raw.target, raw.blockedBy);
    await validateDependencyPath(raw.target, index);
  }

  for (const result of results) result.ok = result.errors.length === 0;

  return {
    ok: results.every((r) => r.ok),
    opCount: ops.length,
    results,
  };
}
