import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  agentVisibilityForRole,
  hasAdminRole,
  hasOwnerRole,
  isActiveOwnerPrincipal,
  resolveHumanRole,
  type AgentVisibilityMode,
  type HumanRole,
} from "@/lib/auth/roles";
import { SESSION_RECOVERY_PATH } from "@/lib/auth/session-recovery";
import { db } from "@/lib/db";

export {
  AGENT_VISIBILITY_MODES,
  HUMAN_ROLES,
  agentVisibilityForRole,
  hasAdminRole,
  hasCustomerRole,
  hasImmutableOwnerCapability,
  hasOwnerRole,
  hasRole,
  isActiveOwnerPrincipal,
  resolveHumanRole,
} from "@/lib/auth/roles";
export type { AgentVisibilityMode, HumanRole } from "@/lib/auth/roles";

export type Viewer = {
  id: string;
  username: string;
  kind: "human" | "agent";
  role: HumanRole | null;
  agentVisibility: AgentVisibilityMode;
  /** Centralized compatibility capability for existing Owner-only surfaces. */
  canAccessOwnerFeatures: boolean;
};

export async function getViewer(): Promise<Viewer | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;

  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      kind: true,
      status: true,
      isOwner: true,
      rolePermission: { select: { name: true } },
    },
  });
  if (!user || user.status !== "active") return null;

  const role = resolveHumanRole(user);

  return {
    id: user.id,
    username: user.username,
    kind: user.kind === "agent" ? "agent" : "human",
    role,
    agentVisibility: agentVisibilityForRole(role),
    canAccessOwnerFeatures: role === "owner",
  };
}

/**
 * Session-free viewer resolution by user id (ENV-168). Long-lived stream
 * guards re-check authorization after an access-change hub event or on their
 * heartbeat; auth()/headers() are not available inside a streaming interval,
 * so the check re-reads role/status from the database — authorization never
 * derives from JWT claims. Returns null when the account is gone or
 * deactivated, which stream guards treat as a terminal authz close.
 */
export async function getViewerByUserId(userId: string): Promise<Viewer | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      kind: true,
      status: true,
      isOwner: true,
      rolePermission: { select: { name: true } },
    },
  });
  if (!user || user.status !== "active") return null;

  const role = resolveHumanRole(user);

  return {
    id: user.id,
    username: user.username,
    kind: user.kind === "agent" ? "agent" : "human",
    role,
    agentVisibility: agentVisibilityForRole(role),
    canAccessOwnerFeatures: role === "owner",
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
  if (!hasOwnerRole(viewer)) throw new Error("Not authorized");
  return viewer;
}

export async function isOwnerUserId(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { kind: true, status: true, isOwner: true },
  });
  return isActiveOwnerPrincipal(user);
}

export function hasGlobalProjectAccess(viewer: Viewer): boolean {
  return hasOwnerRole(viewer);
}

export function projectAccessWhere(viewer: Viewer): Prisma.ProjectWhereInput {
  if (hasGlobalProjectAccess(viewer)) return {};
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
  if (!hasOwnerRole(viewer)) clauses.push({ private: false });
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
  if (!hasOwnerRole(viewer)) {
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
  if (hasOwnerRole(viewer)) return where;
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

export type AccessManagementTarget = {
  id: string;
  kind: "human" | "agent";
  role: HumanRole | null;
};

async function requestedProjectsAreWithinScope(
  viewer: Viewer,
  projectIds: readonly string[],
): Promise<boolean> {
  const uniqueIds = [...new Set(projectIds.filter(Boolean))];
  if (uniqueIds.length === 0 || hasOwnerRole(viewer)) return true;
  const count = await db.project.count({
    where: accessibleProjectWhere(viewer, { id: { in: uniqueIds } }),
  });
  return count === uniqueIds.length;
}

/**
 * Owner may manage any non-Owner human. Admin may manage Customers only, may
 * never target themselves, and may grant/revoke only projects already in the
 * Admin's membership scope. Customers and browser agent sessions cannot
 * manage access.
 */
export async function canManageAccessFor(
  viewer: Viewer,
  target: AccessManagementTarget,
  projectIds: readonly string[] = [],
): Promise<boolean> {
  if (viewer.kind !== "human" || target.kind !== "human" || target.role === "owner") return false;
  if (hasOwnerRole(viewer)) return true;
  if (!hasAdminRole(viewer) || target.id === viewer.id || target.role !== "customer") return false;
  return requestedProjectsAreWithinScope(viewer, projectIds);
}

export async function requireCanManageAccessFor(
  viewer: Viewer,
  target: AccessManagementTarget,
  projectIds: readonly string[] = [],
): Promise<void> {
  if (!(await canManageAccessFor(viewer, target, projectIds))) {
    throw new Error("Not authorized to manage this user's access.");
  }
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
  if (hasOwnerRole(viewer)) return;
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
