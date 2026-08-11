// Task hard-dependency graph.
//
// `blockedById` is the legacy single-prerequisite field. New manager-created
// work uses TaskDependency, while every reader below deliberately consumes the
// union so old Tasks keep their exact scheduling semantics.

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

type Client = Prisma.TransactionClient | typeof db;

export type PrerequisiteState = {
  id: string;
  status: string;
  workItemKey?: string | null;
  title?: string;
};

export type TaskWithPrerequisites = {
  blockedById?: string | null;
  blockedBy?: PrerequisiteState | null;
  dependencies?: Array<{ prerequisite: PrerequisiteState }>;
};

export function taskPrerequisites(task: TaskWithPrerequisites) {
  const prerequisites = new Map<string, PrerequisiteState>();
  if (task.blockedById && task.blockedBy) prerequisites.set(task.blockedBy.id, task.blockedBy);
  for (const edge of task.dependencies ?? []) {
    prerequisites.set(edge.prerequisite.id, edge.prerequisite);
  }
  return [...prerequisites.values()];
}

export function unresolvedTaskPrerequisites(task: TaskWithPrerequisites) {
  return taskPrerequisites(task).filter((prerequisite) => prerequisite.status !== "Done");
}

export type BlockedByCode =
  | "SELF"
  | "NOT_FOUND"
  | "PRIVATE"
  | "WRONG_PROJECT"
  | "NO_SHARED_WORKSPACE"
  | "CYCLE";
export type BlockedByResult = { ok: true } | { ok: false; code: BlockedByCode; message: string };

async function projectsShareActiveWorkspace(
  client: Client,
  leftProjectId: string,
  rightProjectId: string,
) {
  if (leftProjectId === rightProjectId) return true;
  const shared = await client.workspaceProject.findFirst({
    where: {
      projectId: leftProjectId,
      workspace: {
        archivedAt: null,
        projects: { some: { projectId: rightProjectId } },
      },
    },
    select: { id: true },
  });
  return Boolean(shared);
}

export async function validateTaskDependency(args: {
  taskId: string;
  projectId: string;
  prerequisiteTaskId: string;
  allowSharedWorkspace?: boolean;
  client?: Client;
}): Promise<BlockedByResult> {
  const client = args.client ?? db;
  if (args.prerequisiteTaskId === args.taskId) {
    return { ok: false, code: "SELF", message: "A task cannot depend on itself." };
  }
  const prerequisite = await client.task.findUnique({
    where: { id: args.prerequisiteTaskId },
    select: {
      id: true,
      projectId: true,
      private: true,
      deletedAt: true,
      epic: { select: { private: true, deletedAt: true } },
      parent: { select: { private: true, deletedAt: true, epic: { select: { private: true, deletedAt: true } } } },
    },
  });
  if (!prerequisite || prerequisite.deletedAt) {
    return { ok: false, code: "NOT_FOUND", message: "Prerequisite task unavailable." };
  }
  if (
    prerequisite.private || prerequisite.epic?.private || prerequisite.epic?.deletedAt ||
    prerequisite.parent?.private || prerequisite.parent?.deletedAt ||
    prerequisite.parent?.epic?.private || prerequisite.parent?.epic?.deletedAt
  ) {
    return { ok: false, code: "PRIVATE", message: "Prerequisite task unavailable." };
  }
  if (prerequisite.projectId !== args.projectId) {
    if (!args.allowSharedWorkspace) {
      return { ok: false, code: "WRONG_PROJECT", message: "Blocking task must be in the same project." };
    }
    if (!(await projectsShareActiveWorkspace(client, args.projectId, prerequisite.projectId))) {
      return {
        ok: false,
        code: "NO_SHARED_WORKSPACE",
        message: "Cross-project prerequisites must belong to projects in the same active workspace.",
      };
    }
  }

  // Walk every outgoing dependency from the proposed prerequisite. Reaching
  // taskId means adding taskId -> prerequisiteTaskId would close a cycle.
  const pending = [args.prerequisiteTaskId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === args.taskId) {
      return {
        ok: false,
        code: "CYCLE",
        message: "That would create a circular dependency.",
      };
    }
    if (seen.has(current)) continue;
    seen.add(current);
    const row = await client.task.findUnique({
      where: { id: current },
      select: {
        blockedById: true,
        dependencies: { select: { prerequisiteTaskId: true } },
      },
    });
    if (!row) continue;
    if (row.blockedById) pending.push(row.blockedById);
    for (const edge of row.dependencies) pending.push(edge.prerequisiteTaskId);
  }
  return { ok: true };
}

// Compatibility validator for the human single-prerequisite editor. Its
// historical same-project boundary remains intentional; manager-created graph
// edges use validateTaskDependency(..., allowSharedWorkspace: true).
export async function validateBlockedBy(args: {
  taskId: string;
  projectId: string;
  blockerId: string;
  client?: Client;
}): Promise<BlockedByResult> {
  return validateTaskDependency({
    taskId: args.taskId,
    projectId: args.projectId,
    prerequisiteTaskId: args.blockerId,
    allowSharedWorkspace: false,
    client: args.client,
  });
}
