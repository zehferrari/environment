// ENV-164 — server-layer coverage for scoped access management
// (ai/web/lib/users/access-management.ts). Proves every policy rejection
// fires at the transactional core (server-side, not UI hiding), and that
// grant/revoke/promote/demote audit rows are written with each mutation.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import type { Viewer } from "../lib/auth/permissions";

const execFileP = promisify(execFile);

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

function viewerFor(user: { id: string; username: string }, role: "owner" | "admin" | "customer"): Viewer {
  return {
    id: user.id,
    username: user.username,
    kind: "human",
    role,
    agentVisibility: role === "owner" ? "full" : role === "admin" ? "masked" : "hidden",
    canAccessOwnerFeatures: role === "owner",
  };
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(tmpdir(), "access-management-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const dbMod = await import("../lib/db");
    const {
      inviteHumanUserCore,
      setHumanUserRoleCore,
      updateHumanAccessCore,
    } = await import("../lib/users/access-management");
    db = dbMod.db as PrismaClient;
    const prisma = db;

    async function assertRejected(promise: Promise<unknown>, messagePart: string): Promise<void> {
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof Error, "rejection must be an Error");
        assert.ok(
          error.message.includes(messagePart),
          `expected rejection message to include "${messagePart}", got: ${error.message}`,
        );
        return true;
      });
    }

    const adminRoleData = {
      connectOrCreate: {
        where: { name: "admin" },
        create: { name: "admin", description: "Administrator - manages Customers within own project scope" },
      },
    };
    const customerRoleData = {
      connectOrCreate: {
        where: { name: "customer" },
        create: { name: "customer", description: "Customer-facing project member" },
      },
    };

    const [p1, p2, p3] = await Promise.all(
      [1, 2, 3].map((n) =>
        prisma.project.create({ data: { slug: `am-project-${n}`, name: `AM Project ${n}` } }),
      ),
    );

    const ownerUser = await prisma.user.create({
      data: {
        username: "am-owner", email: "am-owner@example.test", kind: "human",
        isOwner: true, mustRotatePassword: false,
      },
    });
    const adminA = await prisma.user.create({
      data: {
        username: "am-admin-a", email: "am-admin-a@example.test", kind: "human",
        mustRotatePassword: false, rolePermission: adminRoleData,
        projectMembers: { create: [{ projectId: p1.id }, { projectId: p2.id }] },
      },
    });
    const adminB = await prisma.user.create({
      data: {
        username: "am-admin-b", email: "am-admin-b@example.test", kind: "human",
        mustRotatePassword: false, rolePermission: adminRoleData,
      },
    });
    const customerC = await prisma.user.create({
      data: {
        username: "am-customer-c", email: "am-customer-c@example.test", kind: "human",
        mustRotatePassword: false, rolePermission: customerRoleData,
        projectMembers: { create: [{ projectId: p1.id }] },
      },
    });
    const customerD = await prisma.user.create({
      data: {
        username: "am-customer-d", email: "am-customer-d@example.test", kind: "human",
        mustRotatePassword: false, rolePermission: customerRoleData,
        projectMembers: { create: [{ projectId: p3.id }] },
      },
    });

    const owner = viewerFor(ownerUser, "owner");
    const admin = viewerFor(adminA, "admin");
    const customer = viewerFor(customerC, "customer");
    const auditCount = () => prisma.accessAuditLog.count();
    let auditBefore: number;

    // ---- 1. Customers never manage access (typed server-side rejection).
    await assertRejected(
      inviteHumanUserCore(customer, {
        username: "am-x1", email: "am-x1@example.test", displayName: null,
        role: "customer", projectIds: [],
      }),
      "Only the Mission Control owner or an Admin can manage access.",
    );

    // ---- 2. Admin invites an in-scope Customer; the initial grant is audited.
    const invite = await inviteHumanUserCore(admin, {
      username: "am-invited", email: "am-invited@example.test", displayName: "Invited Person",
      role: "customer", projectIds: [p1.id],
    });
    assert.ok(invite.token.length > 20, "invite returns a shareable token");
    const invitedUser = await prisma.user.findUniqueOrThrow({
      where: { username: "am-invited" },
      select: {
        id: true, status: true,
        rolePermission: { select: { name: true } },
        projectMembers: { select: { projectId: true } },
      },
    });
    assert.equal(invitedUser.status, "invited");
    assert.equal(invitedUser.rolePermission?.name, "customer");
    assert.deepEqual(invitedUser.projectMembers.map((m) => m.projectId), [p1.id]);
    assert.equal(
      await prisma.passwordResetToken.count({ where: { userId: invitedUser.id } }),
      1,
      "invitation token row created",
    );
    const inviteAudit = await prisma.accessAuditLog.findFirstOrThrow({
      where: { affectedUserId: invitedUser.id },
    });
    assert.equal(inviteAudit.action, "grant");
    assert.equal(inviteAudit.actorUserId, adminA.id);
    assert.equal(inviteAudit.oldRole, null);
    assert.equal(inviteAudit.newRole, "customer");
    assert.equal(inviteAudit.oldProjectIds, "[]");
    assert.deepEqual(JSON.parse(inviteAudit.newProjectIds), [p1.id]);

    auditBefore = await auditCount();

    // ---- 3. Admin cannot invite an Admin (role assignment is Owner-only).
    await assertRejected(
      inviteHumanUserCore(admin, {
        username: "am-x2", email: "am-x2@example.test", displayName: null,
        role: "admin", projectIds: [],
      }),
      "Only the Mission Control owner can grant the Admin role.",
    );
    assert.equal(await prisma.user.count({ where: { username: "am-x2" } }), 0, "rejected invite writes no user");
    assert.equal(await auditCount(), auditBefore, "rejected invite writes no audit rows");

    // ---- 4. Admin cannot invite with an out-of-scope project.
    await assertRejected(
      inviteHumanUserCore(admin, {
        username: "am-x3", email: "am-x3@example.test", displayName: null,
        role: "customer", projectIds: [p3.id],
      }),
      "Access can only be granted within your own project scope.",
    );
    assert.equal(await prisma.user.count({ where: { username: "am-x3" } }), 0);

    // ---- 5. Owner may invite an Admin directly; the grant row records the role.
    const adminInvite = await inviteHumanUserCore(owner, {
      username: "am-invited-admin", email: "am-invited-admin@example.test", displayName: null,
      role: "admin", projectIds: [p2.id],
    });
    assert.ok(adminInvite.token);
    const invitedAdmin = await prisma.user.findUniqueOrThrow({
      where: { username: "am-invited-admin" },
      select: { id: true, rolePermission: { select: { name: true } } },
    });
    assert.equal(invitedAdmin.rolePermission?.name, "admin");
    const adminInviteAudit = await prisma.accessAuditLog.findFirstOrThrow({
      where: { affectedUserId: invitedAdmin.id },
    });
    assert.equal(adminInviteAudit.newRole, "admin");
    assert.deepEqual(JSON.parse(adminInviteAudit.newProjectIds), [p2.id]);

    auditBefore = await auditCount();

    // ---- 6. Admin access-edit guardrails (every rejection is server-side).
    await assertRejected(
      updateHumanAccessCore(admin, { userId: adminA.id, projectIds: [p1.id] }),
      "An Admin cannot edit their own access.",
    );
    await assertRejected(
      updateHumanAccessCore(admin, { userId: adminB.id, projectIds: [p1.id] }),
      "An Admin can only manage Customer access.",
    );
    await assertRejected(
      updateHumanAccessCore(admin, { userId: ownerUser.id, projectIds: [p1.id] }),
      "The Mission Control owner has access to every project.",
    );
    await assertRejected(
      updateHumanAccessCore(admin, { userId: customerD.id, projectIds: [p3.id] }),
      "Access can only be granted or revoked within your own project scope.",
    );
    await assertRejected(
      updateHumanAccessCore(admin, { userId: "missing-user", projectIds: [p1.id] }),
      "Human user not found.",
    );
    // Forged role payload on the combined edit is rejected too.
    await assertRejected(
      updateHumanAccessCore(admin, { userId: customerC.id, projectIds: [p1.id], role: "admin" }),
      "Only the Mission Control owner can promote or demote.",
    );
    assert.equal(await auditCount(), auditBefore, "rejected access edits write no audit rows");
    const cRole = await prisma.user.findUniqueOrThrow({
      where: { id: customerC.id },
      select: { rolePermission: { select: { name: true } } },
    });
    assert.equal(cRole.rolePermission?.name, "customer", "forged role payload did not change the role");

    // ---- 7. Admin edits an in-scope Customer: grant and revoke are audited.
    const grantEdit = await updateHumanAccessCore(admin, {
      userId: customerC.id, projectIds: [p1.id, p2.id],
    });
    assert.equal(grantEdit.changed, true);
    assert.deepEqual(
      (await prisma.projectMember.findMany({ where: { userId: customerC.id }, select: { projectId: true } }))
        .map((m) => m.projectId)
        .sort(),
      [p1.id, p2.id].sort(),
    );
    const grantRow = await prisma.accessAuditLog.findFirstOrThrow({
      where: { affectedUserId: customerC.id, action: "grant" },
    });
    assert.deepEqual(JSON.parse(grantRow.newProjectIds), [p2.id]);
    assert.equal(grantRow.actorUserId, adminA.id);

    const revokeEdit = await updateHumanAccessCore(admin, { userId: customerC.id, projectIds: [p2.id] });
    assert.equal(revokeEdit.changed, true);
    const revokeRow = await prisma.accessAuditLog.findFirstOrThrow({
      where: { affectedUserId: customerC.id, action: "revoke" },
    });
    assert.deepEqual(JSON.parse(revokeRow.oldProjectIds), [p1.id]);
    assert.deepEqual(JSON.parse(revokeRow.newProjectIds), []);
    assert.deepEqual(
      (await prisma.projectMember.findMany({ where: { userId: customerC.id }, select: { projectId: true } }))
        .map((m) => m.projectId),
      [p2.id],
    );

    // No-op replacement set: no writes, no audit rows.
    auditBefore = await auditCount();
    const noOp = await updateHumanAccessCore(admin, { userId: customerC.id, projectIds: [p2.id] });
    assert.equal(noOp.changed, false);
    assert.equal(await auditCount(), auditBefore, "no-op edit writes no audit rows");

    // ---- 8. Owner edits an Admin's access (any non-owner human).
    const ownerEdit = await updateHumanAccessCore(owner, { userId: adminB.id, projectIds: [p3.id] });
    assert.equal(ownerEdit.changed, true);
    const ownerGrantRow = await prisma.accessAuditLog.findFirstOrThrow({
      where: { affectedUserId: adminB.id, action: "grant" },
    });
    assert.equal(ownerGrantRow.actorUserId, ownerUser.id);

    // ---- 9. Role changes: Owner-only, audited as promote / demote.
    await assertRejected(
      setHumanUserRoleCore(admin, { userId: customerC.id, role: "admin" }),
      "Only the Mission Control owner can promote or demote.",
    );
    await assertRejected(
      setHumanUserRoleCore(owner, { userId: customerC.id, role: "owner" }),
      "The owner role cannot be granted through user management.",
    );
    await assertRejected(
      setHumanUserRoleCore(owner, { userId: ownerUser.id, role: "customer" }),
      "The Mission Control owner's status cannot be removed.",
    );
    await assertRejected(
      setHumanUserRoleCore(owner, { userId: customerC.id, role: "banana" }),
      "A valid role is required.",
    );

    const promote = await setHumanUserRoleCore(owner, { userId: customerC.id, role: "admin" });
    assert.deepEqual(promote, { changed: true, username: "am-customer-c" });
    const promoted = await prisma.user.findUniqueOrThrow({
      where: { id: customerC.id },
      select: { rolePermission: { select: { name: true } } },
    });
    assert.equal(promoted.rolePermission?.name, "admin", "role takes effect on the next read");
    const promoteRow = await prisma.accessAuditLog.findFirstOrThrow({
      where: { affectedUserId: customerC.id, action: "promote" },
    });
    assert.equal(promoteRow.actorUserId, ownerUser.id);
    assert.equal(promoteRow.oldRole, "customer");
    assert.equal(promoteRow.newRole, "admin");

    const demote = await setHumanUserRoleCore(owner, { userId: customerC.id, role: "customer" });
    assert.equal(demote.changed, true);
    const demoteRow = await prisma.accessAuditLog.findFirstOrThrow({
      where: { affectedUserId: customerC.id, action: "demote" },
    });
    assert.equal(demoteRow.oldRole, "admin");
    assert.equal(demoteRow.newRole, "customer");

    const noOpRole = await setHumanUserRoleCore(owner, { userId: customerC.id, role: "customer" });
    assert.equal(noOpRole.changed, false, "same-role request is a no-op");
    assert.equal(
      await prisma.accessAuditLog.count({ where: { affectedUserId: customerC.id, action: "demote" } }),
      1,
      "no-op role change writes no second audit row",
    );

    // ---- 10. Combined edit: role + project access commit in one transaction.
    const combined = await updateHumanAccessCore(owner, {
      userId: customerC.id, projectIds: [p1.id, p2.id], role: "admin",
    });
    assert.equal(combined.changed, true);
    const combinedUser = await prisma.user.findUniqueOrThrow({
      where: { id: customerC.id },
      select: { rolePermission: { select: { name: true } }, projectMembers: { select: { projectId: true } } },
    });
    assert.equal(combinedUser.rolePermission?.name, "admin");
    assert.deepEqual(
      combinedUser.projectMembers.map((m) => m.projectId).sort(),
      [p1.id, p2.id].sort(),
    );
    const roleRows = await prisma.accessAuditLog.findMany({
      where: { affectedUserId: customerC.id, action: { in: ["promote", "demote"] } },
      orderBy: { createdAt: "asc" },
    });
    assert.ok(roleRows.length >= 3, "promote, demote and combined promote rows exist");
    const lastRoleRow = roleRows[roleRows.length - 1];
    assert.equal(lastRoleRow.oldRole, "customer");
    assert.equal(lastRoleRow.newRole, "admin");

    // ---- 11. A failed mutation rolls its audit rows back with it.
    auditBefore = await auditCount();
    await assertRejected(
      inviteHumanUserCore(owner, {
        username: "am-dup", email: "am-invited@example.test", displayName: null,
        role: "customer", projectIds: [p1.id],
      }),
      "",
    );
    assert.equal(await prisma.user.count({ where: { username: "am-dup" } }), 0, "failed invite rolls back the user");
    assert.equal(await auditCount(), auditBefore, "failed invite rolls back its audit rows");

    console.log("access-management-test: ok");
  } finally {
    process.env.DATABASE_URL = originalDbUrl;
    await db?.$disconnect();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});