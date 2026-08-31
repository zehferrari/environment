import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import type { Viewer } from "../lib/auth/permissions";

const execFileP = promisify(execFile);

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "human-role-policy-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await execFileP(
      "pnpm",
      ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
      { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
    );
    process.env.DATABASE_URL = dbUrl;

    const permissions = await import("../lib/auth/permissions");
    const dbMod = await import("../lib/db");
    db = dbMod.db as PrismaClient;

    assert.equal(permissions.resolveHumanRole({ kind: "human", isOwner: true }), "owner");
    assert.equal(
      permissions.resolveHumanRole({ kind: "human", isOwner: false, rolePermission: { name: "admin" } }),
      "admin",
    );
    assert.equal(
      permissions.resolveHumanRole({ kind: "human", isOwner: false, rolePermission: { name: "owner" } }),
      "customer",
      "a role row cannot manufacture Owner authority",
    );
    assert.equal(permissions.resolveHumanRole({ kind: "human", isOwner: false }), "customer");
    assert.equal(
      permissions.resolveHumanRole({ kind: "agent", isOwner: true, rolePermission: { name: "owner" } }),
      null,
      "agent accounts stay outside human roles",
    );
    assert.deepEqual(
      (["owner", "admin", "customer", null] as const).map(permissions.agentVisibilityForRole),
      ["full", "masked", "hidden", "hidden"],
    );

    const [ownerUser, adminUser, peerAdminUser, customerUser, agentUser] = await Promise.all([
      db.user.create({ data: { username: "owner", email: "owner@example.test", kind: "human", isOwner: true } }),
      db.user.create({ data: { username: "admin", email: "admin@example.test", kind: "human" } }),
      db.user.create({ data: { username: "peer-admin", email: "peer-admin@example.test", kind: "human" } }),
      db.user.create({ data: { username: "customer", email: "customer@example.test", kind: "human" } }),
      db.user.create({ data: { username: "agent", email: "agent@example.test", kind: "agent" } }),
    ]);
    const [scopedProject, outsideProject] = await Promise.all([
      db.project.create({
        data: { slug: "admin-scope", name: "Admin scope", members: { create: { userId: adminUser.id } } },
      }),
      db.project.create({ data: { slug: "outside-scope", name: "Outside scope" } }),
    ]);

    const viewer = (
      user: { id: string; username: string },
      role: Viewer["role"],
      agentVisibility: Viewer["agentVisibility"],
    ): Viewer => ({
      id: user.id,
      username: user.username,
      kind: role ? "human" : "agent",
      role,
      agentVisibility,
      canAccessOwnerFeatures: role === "owner",
    });
    const owner = viewer(ownerUser, "owner", "full");
    const admin = viewer(adminUser, "admin", "masked");
    const customer = viewer(customerUser, "customer", "hidden");

    const target = (user: { id: string }, role: Viewer["role"], kind: "human" | "agent" = "human") => ({
      id: user.id,
      kind,
      role,
    });

    assert.equal(await permissions.canManageAccessFor(admin, target(customerUser, "customer"), [scopedProject.id]), true);
    assert.equal(await permissions.canManageAccessFor(admin, target(adminUser, "admin"), [scopedProject.id]), false);
    assert.equal(await permissions.canManageAccessFor(admin, target(peerAdminUser, "admin"), [scopedProject.id]), false);
    assert.equal(await permissions.canManageAccessFor(admin, target(ownerUser, "owner"), [scopedProject.id]), false);
    assert.equal(await permissions.canManageAccessFor(admin, target(agentUser, null, "agent"), [scopedProject.id]), false);
    assert.equal(await permissions.canManageAccessFor(admin, target(customerUser, "customer"), [outsideProject.id]), false);
    assert.equal(await permissions.canManageAccessFor(customer, target(customerUser, "customer"), [scopedProject.id]), false);
    assert.equal(await permissions.canManageAccessFor(owner, target(adminUser, "admin"), [outsideProject.id]), true);
    assert.equal(await permissions.canManageAccessFor(owner, target(ownerUser, "owner"), [outsideProject.id]), false);

    await assert.rejects(
      permissions.requireCanManageAccessFor(admin, target(peerAdminUser, "admin"), [scopedProject.id]),
      /Not authorized to manage this user's access/,
    );

    console.log("human-role-policy-test: ok");
  } finally {
    await db?.$disconnect();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
