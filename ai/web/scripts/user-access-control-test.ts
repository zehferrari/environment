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
    const agentContentPolicy = await import("../lib/users/agent-content-policy");
    const { buildAgentRedactor } = await import("../lib/users/redact-agents");
    const workspaceService = await import("../lib/workspaces/service");
    const taskCache = await import("../lib/tasks/cache");
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
    const hiddenAgent = await prisma.agent.create({
      data: { slug: "hidden-agent-test", name: "Hidden Agent Test", role: "coding", avatar: "HA" },
    });
    const hiddenAgentUser = await prisma.user.create({
      data: {
        username: "hidden-agent-test",
        email: "hidden-agent-test@example.test",
        kind: "agent",
        mustRotatePassword: false,
        agentId: hiddenAgent.id,
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
      data: {
        slug: "hidden-project",
        name: "Hidden Project",
        members: { create: { userId: otherHuman.id } },
      },
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
    const publicAgentComment = await prisma.comment.create({
      data: {
        taskId: publicTask.id,
        userId: agentUser.id,
        authorAgentSlug: agent.slug,
        body: "@member-test this is still an internal agent note",
      },
    });
    const generatedComment = await prisma.comment.create({
      data: {
        taskId: publicTask.id,
        userId: ownerUser.id,
        body: "system workflow trace",
        commentKind: "workflow_action",
        isGenerated: true,
      },
    });
    const publicHumanComment = await prisma.comment.create({
      data: { taskId: publicTask.id, userId: memberUser.id, body: "customer-safe note" },
    });
    const publicAgentAttachment = await prisma.attachment.create({
      data: {
        projectId: visibleProject.id,
        taskId: publicTask.id,
        uploaderId: agentUser.id,
        filename: "internal.txt",
        storagePath: "internal.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
        sha256: "b".repeat(64),
      },
    });
    const publicHumanAttachment = await prisma.attachment.create({
      data: {
        projectId: visibleProject.id,
        taskId: publicTask.id,
        uploaderId: memberUser.id,
        filename: "shared.txt",
        storagePath: "shared.txt",
        mimeType: "text/plain",
        sizeBytes: 6,
        sha256: "c".repeat(64),
      },
    });
    const hiddenTask = await prisma.task.create({
      data: { projectId: hiddenProject.id, title: "Hidden Project Task" },
    });
    const hiddenHumanComment = await prisma.comment.create({
      data: { taskId: hiddenTask.id, userId: otherHuman.id, body: "hidden project note" },
    });
    const hiddenHumanAttachment = await prisma.attachment.create({
      data: {
        projectId: hiddenProject.id,
        taskId: hiddenTask.id,
        uploaderId: otherHuman.id,
        filename: "hidden.txt",
        storagePath: "hidden.txt",
        mimeType: "text/plain",
        sizeBytes: 6,
        sha256: "d".repeat(64),
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
        agentPool: { create: { agentId: hiddenAgent.id } },
      },
    });

    const owner: Viewer = {
      id: ownerUser.id,
      username: ownerUser.username,
      kind: "human",
      role: "owner",
      agentVisibility: "full",
      canAccessOwnerFeatures: true,
    };
    const member: Viewer = {
      id: memberUser.id,
      username: memberUser.username,
      kind: "human",
      role: "customer",
      agentVisibility: "hidden",
      canAccessOwnerFeatures: false,
    };
    const agentViewer: Viewer = {
      id: agentUser.id,
      username: agentUser.username,
      kind: "agent",
      role: null,
      agentVisibility: "hidden",
      canAccessOwnerFeatures: false,
    };
    const admin: Viewer = { ...member, role: "admin", agentVisibility: "masked" };

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

    const memberUsers = await prisma.user.findMany({
      where: permissions.accessibleUserWhere(member),
      select: { id: true },
    });
    assert.deepEqual(
      new Set(memberUsers.map(({ id }) => id)),
      new Set([ownerUser.id, memberUser.id]),
      "project-scoped viewers cannot enumerate unrelated humans or agent identities",
    );
    const adminUsers = await prisma.user.findMany({
      where: permissions.accessibleUserWhere(admin),
      select: { id: true },
    });
    assert.deepEqual(
      new Set(adminUsers.map(({ id }) => id)),
      new Set([ownerUser.id, memberUser.id, agentUser.id]),
      "Admin retains in-scope agent identities without discovering out-of-scope humans or agents",
    );
    assert.equal(
      adminUsers.some(({ id }) => id === hiddenAgentUser.id),
      false,
      "Admin cannot resolve an agent that exists only in an out-of-scope workspace",
    );

    const customerComments = await prisma.comment.findMany({
      where: permissions.accessibleCommentWhere(member, { taskId: publicTask.id }),
      select: { id: true },
    });
    assert.deepEqual(
      customerComments.map(({ id }) => id),
      [publicHumanComment.id],
      "Customer comment rows exclude Customer-addressed agent content and generated workflow traces before serialization",
    );
    const adminComments = await prisma.comment.findMany({
      where: permissions.accessibleCommentWhere(admin, { taskId: publicTask.id }),
      select: { id: true },
    });
    assert.deepEqual(
      new Set(adminComments.map(({ id }) => id)),
      new Set([publicAgentComment.id, publicHumanComment.id, generatedComment.id]),
      "Admin retains scoped agent and generated comments for masked presentation",
    );
    const allAdminComments = await prisma.comment.findMany({
      where: permissions.accessibleCommentWhere(admin),
      select: { id: true },
    });
    assert.equal(allAdminComments.some(({ id }) => id === hiddenHumanComment.id), false, "Admin cannot discover comments from an out-of-scope project");

    const customerAttachments = await prisma.attachment.findMany({
      where: permissions.accessibleAttachmentWhere(member, { taskId: publicTask.id }),
      select: { id: true },
    });
    assert.deepEqual(customerAttachments.map(({ id }) => id), [publicHumanAttachment.id], "Customer attachment rows exclude agent uploads");
    const adminAttachments = await prisma.attachment.findMany({
      where: permissions.accessibleAttachmentWhere(admin, { taskId: publicTask.id }),
      select: { id: true },
    });
    assert.deepEqual(new Set(adminAttachments.map(({ id }) => id)), new Set([publicAgentAttachment.id, publicHumanAttachment.id]), "Admin retains scoped attachments");
    const allAdminAttachments = await prisma.attachment.findMany({
      where: permissions.accessibleAttachmentWhere(admin),
      select: { id: true },
    });
    assert.equal(allAdminAttachments.some(({ id }) => id === hiddenHumanAttachment.id), false, "Admin cannot discover attachments from an out-of-scope project");

    assert.deepEqual(
      (await taskCache.getCachedTaskComments(publicTask.id, member)).map(({ id }) => id),
      [publicHumanComment.id],
      "the Task detail reader filters Customer comments at its query boundary",
    );
    assert.deepEqual(
      (await taskCache.getCachedTaskAttachments(publicTask.id, member)).map(({ id }) => id),
      [publicHumanAttachment.id],
      "the Task detail reader filters Customer attachments at its query boundary",
    );
    const rawTaskShell = {
      createdAt: new Date(0),
      updatedAt: new Date(1),
      assigneeId: agentUser.id,
      assignee: { id: agentUser.id },
      actingManagerId: agentUser.id,
      actingManager: { id: agentUser.id },
      approvedById: agentUser.id,
      approvedBy: { id: agentUser.id },
      approvedOn: new Date(1),
      archivedById: agentUser.id,
      archivedBy: { id: agentUser.id },
      actionPlan: { id: "internal-plan" },
      checklist: [{ id: "internal-step" }],
      executionState: { state: "running" },
      repositoryRun: { phase: "validating" },
      branchName: "internal-agent-branch",
      commitPrefix: "INTERNAL",
      alertReporter: true,
      statusChangedAt: new Date(1),
      project: { repositoryPath: "/internal/repo", deploymentProductionBranch: "main" },
      epic: { actingManagerId: agentUser.id, actingManager: { id: agentUser.id }, branchName: "internal-epic", commitPrefix: "EPIC" },
    };
    const customerTaskShell = taskCache.projectTaskDetailShellForViewer(rawTaskShell, member);
    assert.equal(customerTaskShell?.assigneeId, null, "Customer cached Task payloads exclude agent assignments");
    assert.equal(customerTaskShell?.actingManagerId, null, "Customer cached Task payloads exclude reviewer fields");
    assert.equal(customerTaskShell?.branchName, null, "Customer cached Task payloads exclude internal source-control metadata");
    assert.equal(customerTaskShell?.alertReporter, false, "Customer cached Task payloads exclude workflow alert state");
    assert.equal(
      customerTaskShell?.updatedAt.getTime(),
      customerTaskShell?.createdAt.getTime(),
      "Customer cached Task timestamps do not reveal hidden workflow updates",
    );
    const adminTaskShell = taskCache.projectTaskDetailShellForViewer(rawTaskShell, admin);
    assert.equal(adminTaskShell?.assigneeId, agentUser.id, "Admin cached Task payloads retain masked-mode assignments");
    assert.equal(adminTaskShell?.actingManagerId, agentUser.id, "Admin cached Task payloads retain masked-mode reviewer fields");
    assert.equal(adminTaskShell?.branchName, "internal-agent-branch", "Admin cached Task payloads retain source-control state");
    assert.deepEqual(
      (await taskCache.getCachedProjectEpics(visibleProject.id, member)).map(({ id }) => id),
      [publicEpic.id],
      "the Task detail Epic picker excludes private Epics before serialization",
    );

    const pagedTasks = await prisma.task.findMany({
      where: permissions.accessibleTaskWhere(admin, { deletedAt: null }),
      orderBy: { createdAt: "desc" },
      take: 1,
      select: { id: true },
    });
    const scopedTaskCount = await prisma.task.count({ where: permissions.accessibleTaskWhere(admin, { deletedAt: null }) });
    assert.notEqual(pagedTasks[0]?.id, hiddenTask.id, "scope filtering happens before pagination");
    assert.equal(scopedTaskCount, 2, "totals are computed from the post-scope task set");
    const groupedTasks = await prisma.task.groupBy({
      by: ["status"],
      where: permissions.accessibleTaskWhere(admin, { deletedAt: null }),
      _count: { _all: true },
    });
    assert.equal(groupedTasks.reduce((sum, group) => sum + group._count._all, 0), 2, "grouped totals are computed after project scoping");
    assert.equal(await permissions.canAccessTask(admin, hiddenTask.id), false, "out-of-scope deep links fail closed");
    assert.equal(await permissions.canAccessTask(admin, "absent-task"), false, "absent deep links have the same authorization result");

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
        data: { projectId: visibleProject.id, taskId: publicTask.id, userId: agentUser.id, kind: "task.public-test" },
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
      prisma.activityLog.create({
        data: { projectId: hiddenProject.id, taskId: hiddenTask.id, kind: "task.hidden-project-test" },
      }),
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, taskId: publicTask.id, userId: memberUser.id, kind: "task.customer-visible-update" },
      }),
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, taskId: publicTask.id, kind: "task.customer-system-trace" },
      }),
      prisma.activityLog.create({
        data: { projectId: visibleProject.id, taskId: publicTask.id, userId: agentUser.id, kind: "task.customer-addressed-agent-update" },
      }),
    ]);
    const memberActivityWhere = await permissions.accessibleActivityWhere(member, { projectId: visibleProject.id });
    const [memberActivity, memberActivityCount, newestMemberActivity] = await Promise.all([
      prisma.activityLog.findMany({ where: memberActivityWhere, select: { id: true } }),
      prisma.activityLog.count({ where: memberActivityWhere }),
      prisma.activityLog.findFirst({ where: memberActivityWhere, orderBy: { createdAt: "desc" }, select: { id: true } }),
    ]);
    assert.deepEqual(
      new Set(memberActivity.map(({ id }) => id)),
      new Set([activity[6].id]),
      "Customer activity feeds retain only human-authored rows from the accessible set",
    );
    assert.equal(memberActivityCount, 1, "Customer activity totals are computed after hidden agent/system rows are removed");
    assert.equal(newestMemberActivity?.id, activity[6].id, "hidden activity cannot consume the newest Customer pagination slot");
    const adminActivityWhere = await permissions.accessibleActivityWhere(admin);
    const [pagedAdminActivity, adminActivityCount] = await Promise.all([
      prisma.activityLog.findMany({ where: adminActivityWhere, orderBy: { createdAt: "desc" }, take: 1, select: { id: true } }),
      prisma.activityLog.count({ where: adminActivityWhere }),
    ]);
    assert.notEqual(pagedAdminActivity[0]?.id, activity[5].id, "out-of-scope activity cannot consume a pagination slot");
    assert.equal(adminActivityCount, 6, "Admin activity totals retain ordinary in-scope rows after project scoping");
    const adminActivity = await prisma.activityLog.findMany({
      where: adminActivityWhere,
      select: { id: true },
    });
    assert.deepEqual(
      new Set(adminActivity.map(({ id }) => id)),
      new Set([activity[0].id, activity[2].id, activity[4].id, activity[6].id, activity[7].id, activity[8].id]),
      "Admin retains in-scope agent activity while out-of-scope activity stays hidden",
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

    const memberWorkspaces = await workspaceService.listWorkspaces(false, member);
    assert.deepEqual(
      memberWorkspaces.map(({ slug }) => slug),
      ["mixed-workspace"],
      "workspace access is derived from an accessible project",
    );
    assert.deepEqual(
      memberWorkspaces[0]?.projects.map(({ slug }) => slug),
      ["visible-project"],
      "an active out-of-scope sibling project is omitted from an otherwise visible workspace",
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
    assert.deepEqual(
      agentContentPolicy.agentContentPolicy(member),
      {
        mode: "hidden",
        excludeAgentRecords: true,
        maskAgentRecords: false,
        redactAgentReferences: true,
      },
      "Customer policy removes agent rows and redacts references that survive in human-authored bodies",
    );
    const hiddenActor = actorVisibility.serializeVisibleActor(agentActor, memberVisibility);
    assert.equal(hiddenActor, null, "Customers receive no agent identity or placeholder");
    assert.equal(
      buildAgentRedactor(memberVisibility.agentIdentities, memberVisibility.redactAgentReferences)(
        "Agent Test rebased it; ask @agent-test",
      ),
      "an agent rebased it; ask @agent",
      "Customer body redaction removes bare-name and username references from human-authored comments",
    );

    const adminVisibility = await actorVisibility.getActorVisibility(admin);
    assert.equal(
      actorVisibility.serializeVisibleActorAs(agentActor, "reviewer", adminVisibility)?.id,
      "synthetic:review",
      "Admin reviewer projection retains the Feedback / Review mask",
    );
    assert.equal(
      actorVisibility.serializeVisibleActorAs(agentActor, "assignee", adminVisibility)?.id,
      ownerUser.id,
      "Admin assignee projection retains Owner re-attribution",
    );
    assert.equal(
      buildAgentRedactor(adminVisibility.agentIdentities, adminVisibility.redactAgentReferences)("Ask @agent-test"),
      "Ask @agent",
      "Admin body redaction remains enabled",
    );

    const ownerVisibility = await actorVisibility.getActorVisibility(owner);
    const ownerActor = actorVisibility.serializeVisibleActor(agentActor, ownerVisibility);
    assert.equal(ownerActor?.id, agentUser.id, "the owner sees the real agent identity");
    assert.equal(ownerActor?.agent?.slug, agent.slug, "the owner retains agent metadata");
    assert.equal(
      buildAgentRedactor(ownerVisibility.agentIdentities, ownerVisibility.redactAgentReferences)(
        "Agent Test rebased it; ask @agent-test",
      ),
      "Agent Test rebased it; ask @agent-test",
      "Owner body rendering remains unredacted",
    );

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
