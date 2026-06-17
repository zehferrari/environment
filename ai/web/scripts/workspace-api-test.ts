import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createWorkspace, listWorkspaces, seedDefaultWorkspaceFromProjects, updateWorkspace } from "@/lib/workspaces/service";
import { db } from "@/lib/db";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "workspace-api-"));
  try {
    const prisma = db as PrismaClient;
    await prisma.workspaceAgentPool.deleteMany();
    await prisma.workspaceProject.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.project.deleteMany();
    await prisma.user.deleteMany();
    await prisma.agent.deleteMany();

    const user = await prisma.user.create({ data: { username: "zeh-test", email: "zeh-test@example.test", kind: "human", mustRotatePassword: false } });
    const agent = await prisma.agent.create({ data: { slug: "asdrubal-test", name: "Asdrubal Test", role: "coding" } });
    await prisma.user.create({ data: { username: "asdrubal-test", email: "asdrubal-test@example.test", kind: "agent", mustRotatePassword: false, agentId: agent.id } });
    const inactive = await prisma.agent.create({ data: { slug: "inactive-test", name: "Inactive", role: "coding", deactivatedAt: new Date() } });
    const p1 = await prisma.project.create({ data: { slug: "env-test", name: "Environment Test" } });
    const p2 = await prisma.project.create({ data: { slug: "docs-test", name: "Docs Test" } });

    const seeded = await seedDefaultWorkspaceFromProjects();
    assert(seeded?.slug === "default", "default workspace seeded");
    assert((await seedDefaultWorkspaceFromProjects()) === null, "default seed is idempotent");

    const created = await createWorkspace({ name: "Client A", slug: "client-a", type: "client", projectIds: [p1.id], agentIds: [agent.id] });
    assert(created.slug === "client-a", "workspace created");
    assert(created.projects.length === 1 && created.projects[0].slug === "env-test", "project association serialized");
    assert(created.agentPool.length === 1 && created.agentPool[0].slug === "asdrubal-test", "agent pool serialized");
    await createWorkspace({ name: "Bad", slug: "bad", agentIds: [inactive.id] }).then(
      () => { throw new Error("inactive agent accepted"); },
      () => undefined,
    );

    const updated = await updateWorkspace("client-a", { name: "Client Alpha", slug: "client-alpha", projectIds: [p1.id, p2.id], agentIds: [] });
    assert(updated?.slug === "client-alpha", "workspace slug updated");
    assert(updated.projects.length === 2, "project associations replaced");
    assert(updated.agentPool.length === 0, "agent pool replaced");
    assert(updated.logo === null, "logo serializes as null before upload");

    await prisma.workspace.update({ where: { slug: "client-alpha" }, data: { logoPath: path.join(tmp, "logo.png"), logoMimeType: "image/png", logoSizeBytes: 4, logoUpdatedAt: new Date(0) } });
    const withLogo = (await listWorkspaces()).find((w) => w.slug === "client-alpha");
    assert(withLogo?.logo?.url.includes("/api/workspaces/client-alpha/logo"), "logo URL serialized");

    const archived = await prisma.workspace.update({ where: { slug: "client-alpha" }, data: { archivedAt: new Date(), archivedById: user.id } });
    assert(archived.archivedAt, "workspace archived");
    assert(!(await listWorkspaces()).some((w) => w.slug === "client-alpha"), "archived excluded by default");
    assert((await listWorkspaces(true)).some((w) => w.slug === "client-alpha"), "archived included when requested");
    console.log("workspace-api-test: ok");
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await (db as PrismaClient).$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
