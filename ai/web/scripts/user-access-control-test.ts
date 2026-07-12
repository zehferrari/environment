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

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "user-access-control-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const dbMod = await import("../lib/db");
    const permissions = await import("../lib/auth/permissions");
    const actorVisibility = await import("../lib/users/actor-visibility");
    const workspaceService = await import("../lib/workspaces/service");
    const contextApi = await import("../lib/agents/context/api/serialize");
    const agentAttachmentAccess = await import("../lib/attachments/agent-access");
    db = dbMod.db as PrismaClient;
    const prisma = db;

    const ownerUser = await prisma.user.create({
      data: {
        username: "owner-test",
        email: "owner-test@example.test",
        kind: "human",
        name: "Mission Control Owner",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const memberUser = await prisma.user.create({
      data: {
        username: "member-test",
        email: "member-test@example.test",
        kind: "human",
        name: "Project Member",
        mustRotatePassword: false,
      },
    });
    const otherHuman = await prisma.user.create({
      data: {
        username: "other-human-test",
        email: "other-human-test@example.test",
        kind: "human",
        mustRotatePassword: false,
      },
    });
    const agent = await prisma.agent.create({
      data: { slug: "agent-test", name: "Agent Test", role: "coding", avatar: "AT" },
    });
    const agentUser = await prisma.user.create({
      data: {
        username: "agent-test",
        email: "agent-test@example.test",
        kind: "agent",
        mustRotatePassword: false,
        agentId: agent.id,
      },
    });

    const visibleProject = await prisma.project.create({
      data: {
        slug: "visible-project",
        name: "Visible Project",
        members: { create: { userId: memberUser.id } },
      },
    });
    const hiddenProject = await prisma.project.create({
      data: { slug: "hidden-project", name: "Hidden Project" },
    });
    const publicEpic = await prisma.epic.create({
      data: { projectId: visibleProject.id, title: "Public Epic" },
    });
    const privateEpic = await prisma.epic.create({
      data: { projectId: visibleProject.id, title: "Private Epic", private: true },
    });
    const publicTask = await prisma.task.create({
      data: { projectId: visibleProject.id, title: "Public Task" },
    });
    const privateTask = await prisma.task.create({
      data: {
        projectId: visibleProject.id,
        title: "Private Task",
        private: true,
        assigneeId: agentUser.id,
      },
    });
    const publicTaskWithPrivateBlocker = await prisma.task.create({
      data: {
        projectId: visibleProject.id,
        title: "Public Task With Private Blocker",
        blockedById: privateTask.id,
      },
    });
    const privateParentTask = await prisma.task.create({
      data: { projectId: visibleProject.id, title: "Private Parent Task", private: true },
    });
    const privateParentChild = await prisma.task.create({
      data: {
        projectId: visibleProject.id,
        title: "Public Child Under Private Parent",
        parentTaskId: privateParentTask.id,
      },
    });
    const privateEpicTask = await prisma.task.create({
      data: { projectId: visibleProject.id, epicId: privateEpic.id, title: "Private Epic Task" },
    });
    const publicParentInPrivateEpic = await prisma.task.create({
      data: {
        projectId: visibleProject.id,
        epicId: privateEpic.id,
        title: "Public Parent Under Private Epic",
      },
    });
    const publicChildOfParentInPrivateEpic = await prisma.task.create({
      data: {
        projectId: visibleProject.id,
        parentTaskId: publicParentInPrivateEpic.id,
        title: "Public Child Under Parent In Private Epic",
      },
    });
    const privateTaskAttachment = await prisma.attachment.create({
      data: {
        projectId: visibleProject.id,
        taskId: privateTask.id,
        uploaderId: ownerUser.id,
        filename: "private.txt",
        storagePath: "private.txt",
        mimeType: "text/plain",
        sizeBytes: 7,
        sha256: "a".repeat(64),
      },
    });
    await prisma.workspace.create({
      data: {
        slug: "mixed-workspace",
        name: "Mixed Workspace",
        projects: {
          create: [
            { projectId: visibleProject.id },
            { projectId: hiddenProject.id },
          ],
        },
        agentPool: { create: { agentId: agent.id } },
      },
    });
    await prisma.workspace.create({
      data: {
        slug: "hidden-workspace",
        name: "Hidden Workspace",
        projects: { create: { projectId: hiddenProject.id } },
      },
    });

    const owner: Viewer = {
      id: ownerUser.id,
      username: ownerUser.username,
      kind: "human",
      isOwner: true,
    };
    const member: Viewer = {
      id: memberUser.id,
      username: memberUser.username,
      kind: "human",
      isOwner: false,
    };
    const agentViewer: Viewer = {
      id: agentUser.id,
      username: agentUser.username,
      kind: "agent",
      isOwner: false,
    };

    const memberProjects = await prisma.project.findMany({
      where: permissions.accessibleProjectWhere(member),
      select: { slug: true },
      orderBy: { slug: "asc" },
    });
    assert.deepEqual(
      memberProjects.map(({ slug }) => slug),
      ["visible-project"],
      "members only see projects granted through ProjectMember",
    );

    const ownerProjects = await prisma.project.findMany({
      where: permissions.accessibleProjectWhere(owner),
      select: { slug: true },
      orderBy: { slug: "asc" },
    });
    assert.deepEqual(
      ownerProjects.map(({ slug }) => slug),
      ["hidden-project", "visible-project"],
      "the owner has global project access",
    );

    const memberEpics = await prisma.epic.findMany({
      where: permissions.accessibleEpicWhere(member),
      select: { id: true },
    });
    assert.deepEqual(memberEpics.map(({ id }) => id), [publicEpic.id], "members cannot see private Epics");

    const memberTasks = await prisma.task.findMany({
      where: permissions.accessibleTaskWhere(member),
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      memberTasks.map(({ id }) => id),
      [publicTask.id, publicTaskWithPrivateBlocker.id],
      "members cannot see private Tasks or Tasks nested under a private Epic, parent Task, or parent Epic",
    );

    const ownerTasks = await prisma.task.findMany({
      where: permissions.accessibleTaskWhere(owner, { projectId: visibleProject.id }),
      select: { id: true },
    });
    assert.deepEqual(
      new Set(ownerTasks.map(({ id }) => id)),
      new Set([
        publicTask.id,
        privateTask.id,
        publicTaskWithPrivateBlocker.id,
        privateParentTask.id,
        privateParentChild.id,
        privateEpicTask.id,
        publicParentInPrivateEpic.id,
        publicChildOfParentInPrivateEpic.id,
      ]),
      "the owner can see all public and private Tasks",
    );
    assert.equal(await permissions.canAccessTask(member, privateTask.id), false, "private Task direct access is denied");
    assert.equal(await permissions.canAccessEpic(member, privateEpic.id), false, "private Epic direct access is denied");
    const visiblePrivateBlocker = await prisma.task.findMany({
      where: permissions.accessibleTaskWhere(member, { id: privateTask.id }),
      select: { id: true },
    });
    assert.deepEqual(visiblePrivateBlocker, [], "private blocker metadata is not visible to members");

    const agentEpics = await prisma.epic.findMany({
      where: permissions.accessibleEpicWhere(agentViewer, { projectId: visibleProject.id }),
      select: { id: true },
    });
    assert.deepEqual(agentEpics, [], "browser-authenticated agents cannot see Epics");
    const agentTasks = await prisma.task.findMany({
      where: permissions.accessibleTaskWhere(agentViewer, { projectId: visibleProject.id }),
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      agentTasks.map(({ id }) => id),
      [],
      "browser-authenticated agents cannot see Tasks",
    );
    assert.equal(await permissions.canAccessTask(agentViewer, privateTask.id), false, "agent private Task direct access is denied");
    assert.equal(await permissions.canAccessEpic(agentViewer, privateEpic.id), false, "agent private Epic direct access is denied");
    assert.equal(await contextApi.buildTaskContextJson(privateTask.id), null, "agent task context omits private Tasks");
    assert.equal(await contextApi.buildEpicContextJson(privateEpic.id), null, "agent Epic context omits private Epics");
    const agentProjectContext = await contextApi.buildProjectContextJson(visibleProject.id);
    assert.deepEqual(
      agentProjectContext?.epics.map(({ id }) => id),
      [publicEpic.id],
      "agent project context omits private Epics",
    );
    assert.deepEqual(
      agentProjectContext?.openTasks.map(({ id }) => id),
      [publicTask.id, publicTaskWithPrivateBlocker.id],
      "agent project context omits private Tasks",
    );
    assert.deepEqual(
      await agentAttachmentAccess.checkAgentAttachmentReadAccess({
        attachmentId: privateTaskAttachment.id,
        agentSlug: agent.slug,
      }),
      { allowed: false, reason: "forbidden" },
      "agents cannot read attachments on private Tasks even when assigned",
    );

    const activity = await Promise.all([
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, taskId: publicTask.id, kind: "task.public-test" },
      }),
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, taskId: privateTask.id, kind: "task.private-test" },
      }),
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, kind: "epic.public-test", payload: JSON.stringify({ epicId: publicEpic.id }) },
      }),
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, kind: "epic.private-test", payload: JSON.stringify({ epicId: privateEpic.id }) },
      }),
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, kind: "project.public-test" },
      }),
    ]);
    const memberActivity = await prisma.activityLog.findMany({
      where: await permissions.accessibleActivityWhere(member, { projectId: visibleProject.id }),
      select: { id: true },
    });
    assert.deepEqual(
      new Set(memberActivity.map(({ id }) => id)),
      new Set([activity[0].id, activity[2].id, activity[4].id]),
      "member activity feeds omit private Task and Epic activity",
    );
    const agentActivity = await prisma.activityLog.findMany({
      where: await permissions.accessibleActivityWhere(agentViewer, { projectId: visibleProject.id }),
      select: { id: true },
    });
    assert.deepEqual(
      new Set(agentActivity.map(({ id }) => id)),
      new Set(),
      "browser-authenticated agents do not receive activity",
    );

    await prisma.project.update({
      where: { id: hiddenProject.id },
      data: {
        archivedAt: new Date(),
        members: { create: { userId: memberUser.id } },
      },
    });

    const memberWorkspaces = await workspaceService.listWorkspaces(false, member);
    assert.deepEqual(
      memberWorkspaces.map(({ slug }) => slug),
      ["mixed-workspace"],
      "workspace access is derived from an accessible project",
    );
    assert.deepEqual(
      memberWorkspaces[0]?.projects.map(({ slug }) => slug),
      ["visible-project"],
      "inaccessible, archived projects are omitted from an otherwise visible workspace",
    );
    assert.deepEqual(
      memberWorkspaces[0]?.agentPool,
      [],
      "agent pools remain hidden from members",
    );
    assert.equal(
      "defaults" in (memberWorkspaces[0] ?? {}),
      false,
      "workspace integration and deployment defaults remain owner-only",
    );
    assert.deepEqual(
      (await workspaceService.listWorkspaces(false, agentViewer)).map(({ slug }) => slug),
      [],
      "browser-authenticated agents cannot receive workspace identity data",
    );

    const ownerWorkspaces = await workspaceService.listWorkspaces(false, owner);
    assert.deepEqual(
      ownerWorkspaces.map(({ slug }) => slug),
      ["hidden-workspace", "mixed-workspace"],
      "the owner sees every workspace",
    );
    assert.equal(
      ownerWorkspaces.find(({ slug }) => slug === "mixed-workspace")?.agentPool.length,
      1,
      "the owner retains workspace agent visibility",
    );

    await assert.rejects(
      permissions.assertAgentAssignmentAllowed(member, [agentUser.id]),
      /Only the Mission Control owner can assign agents/,
      "members cannot assign agents",
    );
    await assert.doesNotReject(
      permissions.assertAgentAssignmentAllowed(member, [otherHuman.id]),
      "members can assign human users",
    );
    await assert.doesNotReject(
      permissions.assertAgentAssignmentAllowed(owner, [agentUser.id]),
      "the owner can assign agents",
    );

    const agentActor = await prisma.user.findUniqueOrThrow({
      where: { id: agentUser.id },
      select: {
        id: true,
        username: true,
        kind: true,
        name: true,
        avatarUpdatedAt: true,
        agent: { select: { slug: true, name: true, avatar: true } },
      },
    });
    const memberVisibility = await actorVisibility.getActorVisibility(member);
    const maskedActor = actorVisibility.serializeVisibleActor(agentActor, memberVisibility);
    assert.equal(maskedActor?.id, ownerUser.id, "members see the owner identity in place of an agent");
    assert.equal(maskedActor?.kind, "human", "the masked identity is exposed as human");
    assert.equal(maskedActor?.agent, null, "masked identities do not leak agent metadata");

    const ownerVisibility = await actorVisibility.getActorVisibility(owner);
    const ownerActor = actorVisibility.serializeVisibleActor(agentActor, ownerVisibility);
    assert.equal(ownerActor?.id, agentUser.id, "the owner sees the real agent identity");
    assert.equal(ownerActor?.agent?.slug, agent.slug, "the owner retains agent metadata");

    console.log("user-access-control-test: ok");
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
