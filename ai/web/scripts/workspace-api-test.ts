import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";

const execFileP = promisify(execFile);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "workspace-api-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;
  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const dbMod = await import("../lib/db");
    const service = await import("../lib/workspaces/service");
    const storage = await import("../lib/workspaces/storage");
    db = dbMod.db as PrismaClient;
    const prisma = db;

    const user = await prisma.user.create({ data: { username: "owner-test", email: "owner-test@example.test", kind: "human", mustRotatePassword: false } });
    const agent = await prisma.agent.create({ data: { slug: "asdrubal-test", name: "Asdrubal Test", role: "coding" } });
    await prisma.user.create({ data: { username: "asdrubal-test", email: "asdrubal-test@example.test", kind: "agent", mustRotatePassword: false, agentId: agent.id } });
    const inactive = await prisma.agent.create({ data: { slug: "inactive-test", name: "Inactive", role: "coding", deactivatedAt: new Date() } });
    const p1 = await prisma.project.create({ data: { slug: "env-test", name: "Environment Test" } });
    const p2 = await prisma.project.create({ data: { slug: "docs-test", name: "Docs Test" } });

    const seeded = await service.seedDefaultWorkspaceFromProjects();
    assert(seeded?.slug === "default", "default workspace seeded");
    assert((await service.seedDefaultWorkspaceFromProjects()) === null, "default seed is idempotent");

    const created = await service.createWorkspace({ name: "Client A", slug: "client-a", type: "client", projectIds: [p1.id], agentIds: [agent.id] });
    assert(created.slug === "client-a", "workspace created");
    assert(created.projects.length === 1 && created.projects[0].slug === "env-test", "project association serialized");
    assert(created.agentPool.length === 1 && created.agentPool[0].slug === "asdrubal-test", "agent pool serialized");
    await service.createWorkspace({ name: "Bad", slug: "bad", agentIds: [inactive.id] }).then(
      () => { throw new Error("inactive agent accepted"); },
      () => undefined,
    );

    const updated = await service.updateWorkspace("client-a", { name: "Client Alpha", slug: "client-alpha", projectIds: [p1.id, p2.id], agentIds: [] });
    assert(updated?.slug === "client-alpha", "workspace slug updated");
    assert(updated.projects.length === 2, "project associations replaced");
    assert(updated.agentPool.length === 0, "agent pool replaced");
    assert(updated.logo === null, "logo serializes as null before upload");

    assert(storage.normalizeLogoMimeType("multipart/form-data; boundary=x", "logo.PNG") === "image/png", "logo MIME falls back to filename for multipart uploads");
    assert(storage.normalizeLogoMimeType("image/jpeg", "logo.png") === "image/jpeg", "explicit supported logo MIME wins");
    assert(!storage.validateLogoMimeType("text/plain"), "unsupported logo MIME rejected");
    assert(storage.MAX_WORKSPACE_LOGO_BYTES === 2 * 1024 * 1024, "logo size cap exported");

    const logoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const logoPath = await storage.writeWorkspaceLogo(created.id, "image/png", logoBytes);
    assert((await readFile(logoPath)).equals(logoBytes), "workspace logo bytes written");
    assert((await stat(logoPath)).size === logoBytes.length, "workspace logo size is readable");
    await prisma.workspace.update({ where: { slug: "client-alpha" }, data: { logoPath, logoMimeType: "image/png", logoSizeBytes: logoBytes.length, logoUpdatedAt: new Date(0) } });
    const withLogo = (await service.listWorkspaces()).find((w) => w.slug === "client-alpha");
    assert(withLogo?.logo?.url.includes("/api/workspaces/client-alpha/logo"), "logo URL serialized");
    await storage.deleteWorkspaceLogo(logoPath);
    await stat(logoPath).then(
      () => { throw new Error("workspace logo file was not deleted"); },
      () => undefined,
    );

    const archived = await service.archiveWorkspace("client-alpha", user.id);
    assert(archived?.archivedAt, "workspace archived");
    const archivedAgain = await service.archiveWorkspace("client-alpha", user.id);
    assert(archivedAgain?.archivedAt === archived.archivedAt, "archive is idempotent");
    assert(!(await service.listWorkspaces()).some((w) => w.slug === "client-alpha"), "archived excluded by default");
    assert((await service.listWorkspaces(true)).some((w) => w.slug === "client-alpha"), "archived included when requested");
    assert((await service.getWorkspaceBySlug("client-alpha"))?.archivedAt, "direct archived workspace lookup remains available");
    const restored = await service.restoreWorkspace("client-alpha");
    assert(restored && restored.archivedAt === null, "workspace restored");
    const restoredAgain = await service.restoreWorkspace("client-alpha");
    assert(restoredAgain && restoredAgain.archivedAt === null, "restore is idempotent");
    assert((await service.listWorkspaces()).some((w) => w.slug === "client-alpha"), "restored workspace returns to default list");
    console.log("workspace-api-test: ok");
  } finally {
    await db?.$disconnect();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
