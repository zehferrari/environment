import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SESSION_RECOVERY_PATH } from "@/lib/auth/session-recovery";
import { db } from "@/lib/db";

export type Viewer = {
  id: string;
  username: string;
  kind: "human" | "agent";
  isOwner: boolean;
};

export async function getViewer(): Promise<Viewer | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;

  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, username: true, kind: true, status: true, isOwner: true },
  });
  if (!user || user.status !== "active") return null;

  return {
    id: user.id,
    username: user.username,
    kind: user.kind === "agent" ? "agent" : "human",
    isOwner: user.kind === "human" && user.isOwner,
  };
}

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  // Middleware can verify the JWT signature without a database lookup, while
  // Auth.js intentionally re-checks account status and passwordSetAt here. A
  // stale but correctly signed browser token can therefore pass middleware
  // and fail here. Recover it as an expired session instead of throwing a 500
  // from every concurrently rendered layout/page.
  if (!viewer) redirect(SESSION_RECOVERY_PATH);
  return viewer;
}

export async function requireOwner(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!viewer.isOwner) throw new Error("Not authorized");
  return viewer;
}

export async function isOwnerUserId(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { kind: true, status: true, isOwner: true },
  });
  return Boolean(user?.kind === "human" && user.status === "active" && user.isOwner);
}

export function hasGlobalProjectAccess(viewer: Viewer): boolean {
  return viewer.isOwner;
}

export function projectAccessWhere(viewer: Viewer): Prisma.ProjectWhereInput {
  if (viewer.isOwner) return {};
  // Browser-authenticated agent accounts are never PM viewers. Native agent
  // workflows use their scoped bearer/token APIs instead of this session path.
  if (viewer.kind === "agent") return { id: { equals: "__no-browser-agent-access__" } };
  return { members: { some: { userId: viewer.id } } };
}

export function accessibleProjectWhere(
  viewer: Viewer,
  where: Prisma.ProjectWhereInput = {},
): Prisma.ProjectWhereInput {
  const access = projectAccessWhere(viewer);
  return Object.keys(access).length === 0 ? where : { AND: [where, access] };
}

/**
 * Private Epics are owner-only. This applies to agent contexts as well as
 * human member sessions so private work cannot be inferred through workflows.
 */
export function accessibleEpicWhere(
  viewer: Viewer,
  where: Prisma.EpicWhereInput = {},
): Prisma.EpicWhereInput {
  const access = projectAccessWhere(viewer);
  const clauses: Prisma.EpicWhereInput[] = [where];
  if (Object.keys(access).length > 0) clauses.push({ project: access });
  if (!viewer.isOwner) clauses.push({ private: false });
  return clauses.length === 1 ? where : { AND: clauses };
}

/**
 * Tasks inside a private Epic are private as well. Otherwise a member could
 * infer the Epic title and workflow from its child task rows.
 */
export function accessibleTaskWhere(
  viewer: Viewer,
  where: Prisma.TaskWhereInput = {},
): Prisma.TaskWhereInput {
  const access = projectAccessWhere(viewer);
  const clauses: Prisma.TaskWhereInput[] = [where];
  if (Object.keys(access).length > 0) clauses.push({ project: access });
  if (!viewer.isOwner) {
    clauses.push({
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
    });
  }
  return clauses.length === 1 ? where : { AND: clauses };
}

export async function accessibleActivityWhere(
  viewer: Viewer,
  where: Prisma.ActivityLogWhereInput = {},
): Promise<Prisma.ActivityLogWhereInput> {
  if (viewer.isOwner) return where;
  if (viewer.kind === "agent") {
    return { AND: [where, { id: { in: [] } }] };
  }

  const visibleEpicIds = (await db.epic.findMany({
    where: accessibleEpicWhere(viewer),
    select: { id: true },
  })).map((epic) => epic.id);
  const nonTaskActivity: Prisma.ActivityLogWhereInput = {
    taskId: null,
    NOT: { kind: { startsWith: "task." } },
    AND: visibleEpicIds.length > 0
      ? [{
          OR: [
            { NOT: { kind: { startsWith: "epic." } } },
            {
              AND: [
                { kind: { startsWith: "epic." } },
                { OR: visibleEpicIds.map((id) => ({ payload: { contains: id } })) },
              ],
            },
          ],
        }]
      : [{ NOT: { kind: { startsWith: "epic." } } }],
  };

  return {
    AND: [
      where,
      {
        OR: [
          { task: { is: accessibleTaskWhere(viewer) } },
          nonTaskActivity,
        ],
      },
    ],
  };
}

export function workspaceAccessWhere(viewer: Viewer): Prisma.WorkspaceWhereInput {
  if (hasGlobalProjectAccess(viewer)) return {};
  if (viewer.kind === "agent") {
    return { id: { equals: "__no-browser-agent-workspace-access__" } };
  }
  return {
    projects: {
      some: {
        project: {
          deletedAt: null,
          archivedAt: null,
          members: { some: { userId: viewer.id } },
        },
      },
    },
  };
}

export async function canAccessProject(
  viewer: Viewer,
  target: { id?: string; slug?: string },
): Promise<boolean> {
  if (hasGlobalProjectAccess(viewer)) return true;
  if (!target.id && !target.slug) return false;
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, {
      ...(target.id ? { id: target.id } : {}),
      ...(target.slug ? { slug: target.slug } : {}),
    }),
    select: { id: true },
  });
  return Boolean(project);
}

export async function requireProjectAccess(
  viewer: Viewer,
  target: { id?: string; slug?: string },
): Promise<void> {
  if (!(await canAccessProject(viewer, target))) throw new Error("Not authorized");
}

export async function canAccessEpic(viewer: Viewer, epicId: string): Promise<boolean> {
  const epic = await db.epic.findFirst({
    where: accessibleEpicWhere(viewer, { id: epicId }),
    select: { id: true },
  });
  return Boolean(epic);
}

export async function requireEpicAccess(viewer: Viewer, epicId: string): Promise<void> {
  if (!(await canAccessEpic(viewer, epicId))) throw new Error("Not authorized");
}

export async function canAccessTask(viewer: Viewer, taskId: string): Promise<boolean> {
  const task = await db.task.findFirst({
    where: accessibleTaskWhere(viewer, { id: taskId }),
    select: { id: true },
  });
  return Boolean(task);
}

export async function requireTaskAccess(viewer: Viewer, taskId: string): Promise<void> {
  if (!(await canAccessTask(viewer, taskId))) throw new Error("Not authorized");
}

export async function assertAgentAssignmentAllowed(
  viewer: Viewer,
  targetUserIds: Array<string | null | undefined>,
): Promise<void> {
  if (viewer.isOwner) return;
  const ids = [...new Set(targetUserIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  const agent = await db.user.findFirst({
    where: { id: { in: ids }, kind: "agent" },
    select: { id: true },
  });
  if (agent) {
    throw new Error("Only the Mission Control owner can assign agents.");
  }
}
