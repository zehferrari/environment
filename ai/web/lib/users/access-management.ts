// Transactional core for scoped human-access management (ENV-164).
//
// Server actions in actions.ts resolve the viewer (requireViewer) and parse
// form data, then delegate here. This module owns every scope/role decision
// through the pure policy core (access-policy.ts) and writes the Owner-visible
// audit trail in the SAME transaction as the mutation, so a failed mutation
// rolls its audit rows back with it. Forms and UI never make the decision.

import { createHash, randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/permissions";
import { resolveHumanRole, type HumanRole } from "@/lib/auth/roles";
import { evaluateAccessPolicy, type AccessPolicySubject } from "@/lib/users/access-policy";

type TransactionClient = Prisma.TransactionClient;

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLE_DESCRIPTIONS: Record<"admin" | "customer", string> = {
  admin: "Administrator - manages Customers within own project scope",
  customer: "Customer-facing project member",
};

export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function subjectFromViewer(viewer: Viewer): AccessPolicySubject {
  return { id: viewer.id, kind: viewer.kind, role: viewer.role };
}

async function viewerProjectIds(viewer: Viewer): Promise<string[]> {
  // Owner scope is global; the policy core never consults it for owners.
  if (viewer.role === "owner") return [];
  const memberships = await db.projectMember.findMany({
    where: { userId: viewer.id },
    select: { projectId: true },
  });
  return memberships.map((membership) => membership.projectId);
}

async function humanSubject(userId: string): Promise<AccessPolicySubject | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, kind: true, isOwner: true, rolePermission: { select: { name: true } } },
  });
  if (!user) return null;
  return {
    id: user.id,
    kind: user.kind === "agent" ? "agent" : "human",
    role: resolveHumanRole(user),
  };
}

/**
 * Role strings reaching the policy core must be a known human role. "owner"
 * flows into the policy so its typed owner_role_not_assignable rejection
 * fires; anything else is rejected here.
 */
function assertRoleShape(role: string): void {
  if (role !== "customer" && role !== "admin" && role !== "owner") {
    throw new Error("A valid role is required.");
  }
}

async function validateProjectIds(projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const count = await db.project.count({
    where: { id: { in: projectIds }, deletedAt: null },
  });
  if (count !== projectIds.length) throw new Error("One or more projects are unavailable.");
}

type AccessAuditRow = {
  action: "grant" | "revoke" | "promote" | "demote";
  oldRole: string | null;
  newRole: string | null;
  oldProjectIds: string[];
  newProjectIds: string[];
};

async function writeAuditRow(
  tx: TransactionClient,
  actorUserId: string,
  affectedUserId: string,
  row: AccessAuditRow,
): Promise<void> {
  await tx.accessAuditLog.create({
    data: {
      actorUserId,
      affectedUserId,
      action: row.action,
      oldRole: row.oldRole,
      newRole: row.newRole,
      oldProjectIds: JSON.stringify(row.oldProjectIds),
      newProjectIds: JSON.stringify(row.newProjectIds),
    },
  });
}

export type InviteHumanUserInput = {
  username: string;
  email: string;
  displayName: string | null;
  /** Requested initial role: "customer" or "admin"; "owner" is policy-rejected. */
  role: string;
  projectIds: string[];
};

/**
 * Invite a human user with an initial role and project access. The policy
 * core rejects Admin-granted roles, out-of-scope projects, and the owner
 * role before anything is written. The invitation itself is the initial
 * grant and writes one audit row capturing the account's starting scope.
 */
export async function inviteHumanUserCore(
  viewer: Viewer,
  input: InviteHumanUserInput,
): Promise<{ userId: string; token: string }> {
  assertRoleShape(input.role);

  const decision = evaluateAccessPolicy({
    intent: "invite",
    viewer: subjectFromViewer(viewer),
    viewerProjectIds: await viewerProjectIds(viewer),
    target: null,
    requestedRole: input.role as HumanRole,
    requestedProjectIds: input.projectIds,
  });
  if (!decision.allowed) throw new Error(decision.message);

  await validateProjectIds(input.projectIds);

  const role = input.role as "admin" | "customer";
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);

  const userId = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: input.username,
        email: input.email,
        name: input.displayName,
        kind: "human",
        status: "invited",
        isOwner: false,
        rolePermission: {
          connectOrCreate: {
            where: { name: role },
            create: { name: role, description: ROLE_DESCRIPTIONS[role] },
          },
        },
        mustRotatePassword: false,
      },
      select: { id: true },
    });
    if (input.projectIds.length > 0) {
      await tx.projectMember.createMany({
        data: input.projectIds.map((projectId) => ({ projectId, userId: user.id, role: "member" })),
      });
    }
    await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: inviteTokenHash(token), expiresAt },
    });
    await writeAuditRow(tx, viewer.id, user.id, {
      action: "grant",
      oldRole: null,
      newRole: role,
      oldProjectIds: [],
      newProjectIds: input.projectIds,
    });
    return user.id;
  });

  return { userId, token };
}

export type UpdateHumanAccessInput = {
  userId: string;
  /** Full replacement project set for the target. */
  projectIds: string[];
  /** Optional combined role change from the unified edit form. */
  role?: string;
};

/**
 * Combined project-access (and optional role) edit. The policy core is
 * evaluated server-side for both intents — including forged payloads — and
 * the mutation plus its grant/revoke/promote/demote audit rows commit in a
 * single transaction: a failure rolls the audit rows back with it.
 */
export async function updateHumanAccessCore(
  viewer: Viewer,
  input: UpdateHumanAccessInput,
): Promise<{ changed: boolean; username: string }> {
  const target = await humanSubject(input.userId);
  if (!target) throw new Error("Human user not found.");

  const roleProvided = typeof input.role === "string" && input.role.length > 0;
  if (roleProvided && input.role) assertRoleShape(input.role);
  const roleChanges = roleProvided && input.role !== target.role;
  const nextRole: "admin" | "customer" | null =
    roleChanges && input.role ? (input.role as "admin" | "customer") : null;

  const viewerSubject = subjectFromViewer(viewer);
  const scopeIds = await viewerProjectIds(viewer);

  if (nextRole) {
    const roleDecision = evaluateAccessPolicy({
      intent: "role_change",
      viewer: viewerSubject,
      viewerProjectIds: scopeIds,
      target,
      requestedRole: nextRole,
      requestedProjectIds: [],
    });
    if (!roleDecision.allowed) throw new Error(roleDecision.message);
  }

  const accessDecision = evaluateAccessPolicy({
    intent: "access_edit",
    viewer: viewerSubject,
    viewerProjectIds: scopeIds,
    target,
    requestedRole: target.role,
    requestedProjectIds: input.projectIds,
  });
  if (!accessDecision.allowed) throw new Error(accessDecision.message);

  await validateProjectIds(input.projectIds);

  return db.$transaction(async (tx) => {
    const current = await tx.projectMember.findMany({
      where: { userId: input.userId },
      select: { projectId: true },
    });
    const oldIds = current.map((membership) => membership.projectId);
    const newIds = [...new Set(input.projectIds)];
    const added = newIds.filter((projectId) => !oldIds.includes(projectId));
    const removed = oldIds.filter((projectId) => !newIds.includes(projectId));

    const changed = added.length > 0 || removed.length > 0 || roleChanges;

    if (nextRole) {
      const newRole = nextRole;
      await tx.user.update({
        where: { id: input.userId },
        data: {
          rolePermission: {
            connectOrCreate: {
              where: { name: newRole },
              create: { name: newRole, description: ROLE_DESCRIPTIONS[newRole] },
            },
          },
        },
      });
      await writeAuditRow(tx, viewer.id, input.userId, {
        action: newRole === "admin" ? "promote" : "demote",
        oldRole: target.role,
        newRole,
        oldProjectIds: oldIds,
        newProjectIds: oldIds,
      });
    }

    if (removed.length > 0) {
      await tx.projectMember.deleteMany({
        where: { userId: input.userId, projectId: { in: removed } },
      });
      for (const projectId of removed) {
        await writeAuditRow(tx, viewer.id, input.userId, {
          action: "revoke",
          oldRole: null,
          newRole: null,
          oldProjectIds: [projectId],
          newProjectIds: [],
        });
      }
    }
    if (added.length > 0) {
      await tx.projectMember.createMany({
        data: added.map((projectId) => ({ projectId, userId: input.userId, role: "member" })),
      });
      for (const projectId of added) {
        await writeAuditRow(tx, viewer.id, input.userId, {
          action: "grant",
          oldRole: null,
          newRole: null,
          oldProjectIds: [],
          newProjectIds: [projectId],
        });
      }
    }

    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { username: true },
    });
    return { changed, username: user?.username ?? "" };
  });
}

/**
 * Promote or demote a human user. Only the Owner passes the policy core;
 * role changes by an Admin, the owner role itself, and the Owner's own
 * status are all rejected server-side. The promote/demote audit row commits
 * in the same transaction as the role change.
 */
export async function setHumanUserRoleCore(
  viewer: Viewer,
  input: { userId: string; role: string },
): Promise<{ changed: boolean; username: string }> {
  assertRoleShape(input.role);

  const target = await humanSubject(input.userId);
  if (!target) throw new Error("Human user not found.");

  if (target.role === input.role) {
    const user = await db.user.findUnique({
      where: { id: input.userId },
      select: { username: true },
    });
    return { changed: false, username: user?.username ?? "" };
  }

  const decision = evaluateAccessPolicy({
    intent: "role_change",
    viewer: subjectFromViewer(viewer),
    viewerProjectIds: await viewerProjectIds(viewer),
    target,
    requestedRole: input.role as HumanRole,
    requestedProjectIds: [],
  });
  if (!decision.allowed) throw new Error(decision.message);

  const newRole = input.role as "admin" | "customer";

  return db.$transaction(async (tx) => {
    const current = await tx.projectMember.findMany({
      where: { userId: input.userId },
      select: { projectId: true },
    });
    const memberIds = current.map((membership) => membership.projectId);
    await tx.user.update({
      where: { id: input.userId },
      data: {
        rolePermission: {
          connectOrCreate: {
            where: { name: newRole },
            create: { name: newRole, description: ROLE_DESCRIPTIONS[newRole] },
          },
        },
      },
    });
    await writeAuditRow(tx, viewer.id, input.userId, {
      action: newRole === "admin" ? "promote" : "demote",
      oldRole: target.role,
      newRole,
      oldProjectIds: memberIds,
      newProjectIds: memberIds,
    });
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { username: true },
    });
    return { changed: true, username: user?.username ?? "" };
  });
}