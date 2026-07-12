import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";

const execFileP = promisify(execFile);

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "user-lifecycle-"));
  const originalDbUrl = process.env.DATABASE_URL;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const dbMod = await import("../lib/db");
    const { getHumanUserRemovalStatus } = await import("../lib/users/removal");
    const { revokeDisabledHumanAccountAccess } = await import("../lib/users/lifecycle");
    db = dbMod.db as PrismaClient;
    const prisma = db;

    const owner = await prisma.user.create({
      data: {
        username: "owner-lifecycle",
        email: "owner-lifecycle@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const removable = await prisma.user.create({
      data: {
        username: "removable-lifecycle",
        email: "removable-lifecycle@example.test",
        kind: "human",
        mustRotatePassword: false,
      },
    });
    const project = await prisma.project.create({
      data: {
        slug: "lifecycle-project",
        name: "Lifecycle Project",
        members: { create: { userId: removable.id } },
      },
    });

    // These are account-local records rather than shared history. They do not
    // make an otherwise unused account ineligible for removal.
    await Promise.all([
      prisma.passwordResetToken.create({
        data: {
          userId: removable.id,
          tokenHash: "a".repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      prisma.chatReadCursor.create({
        data: { userId: removable.id, agentSlug: "task:unused" },
      }),
      prisma.webPushSubscription.create({
        data: {
          userId: removable.id,
          endpoint: "https://push.example.test/removable",
          p256dh: "key",
          auth: "auth",
        },
      }),
    ]);

    const removableStatus = await getHumanUserRemovalStatus(removable.id);
    assert.equal(removableStatus.removable, true, "project access and passive account rows do not block removal");
    assert.deepEqual(removableStatus.blockers, [], "the removable user has no retained history");

    const ownerStatus = await getHumanUserRemovalStatus(owner.id);
    assert.equal(ownerStatus.removable, false, "the Mission Control owner is never removable");
    assert.equal(ownerStatus.isOwner, true, "owner protection is reported to the UI");

    const disabledUser = await prisma.user.create({
      data: {
        username: "disabled-lifecycle",
        email: "disabled-lifecycle@example.test",
        kind: "human",
        mustRotatePassword: false,
      },
    });
    await Promise.all([
      prisma.passwordResetToken.create({
        data: {
          userId: disabledUser.id,
          tokenHash: "b".repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      prisma.webPushSubscription.create({
        data: {
          userId: disabledUser.id,
          endpoint: "https://push.example.test/disabled",
          p256dh: "key",
          auth: "auth",
        },
      }),
    ]);
    await prisma.$transaction((tx) => revokeDisabledHumanAccountAccess(tx, disabledUser.id, new Date()));
    assert.equal(
      await prisma.passwordResetToken.count({ where: { userId: disabledUser.id, usedAt: null } }),
      0,
      "disabling invalidates unused password reset tokens",
    );
    assert.equal(
      await prisma.webPushSubscription.count({ where: { userId: disabledUser.id } }),
      0,
      "disabling removes device push subscriptions",
    );

    const historyUser = await prisma.user.create({
      data: {
        username: "history-lifecycle",
        email: "history-lifecycle@example.test",
        kind: "human",
        mustRotatePassword: false,
      },
    });
    const epic = await prisma.epic.create({
      data: {
        projectId: project.id,
        title: "Historical Epic",
        reporterId: historyUser.id,
        actingManagerId: historyUser.id,
        deployReviewerId: historyUser.id,
        workers: { create: { userId: historyUser.id } },
      },
    });
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        title: "Historical Task",
        reporterId: historyUser.id,
        assigneeId: historyUser.id,
        actingManagerId: historyUser.id,
      },
    });
    await Promise.all([
      prisma.comment.create({ data: { taskId: task.id, userId: historyUser.id, body: "Historical comment" } }),
      prisma.activityLog.create({ data: { taskId: task.id, projectId: project.id, userId: historyUser.id, kind: "task.test" } }),
      prisma.project.create({
        data: {
          slug: "deleted-by-history-user",
          name: "Deleted by History User",
          deletedAt: new Date(),
          deletedById: historyUser.id,
        },
      }),
      prisma.deploymentPullRequest.create({
        data: {
          projectId: project.id,
          taskId: task.id,
          epicId: epic.id,
          provider: "test",
          providerPrId: "lifecycle-pr",
          url: "https://example.test/lifecycle-pr",
          sourceBranch: "feature/lifecycle",
          targetBranch: "main",
          latestCommitSha: "abc123",
          reporterUserId: historyUser.id,
          reporterName: "History User",
          reporterEmail: historyUser.email,
          localChangeApprovedById: historyUser.id,
        },
      }),
      prisma.pmEventDelivery.create({
        data: {
          dedupeKey: "lifecycle-event",
          eventId: "lifecycle-event",
          kind: "task.updated",
          taskId: task.id,
          taskKey: "LIF-1",
          projectKey: "lifecycle-project",
          actorId: historyUser.id,
          envelope: "{}",
        },
      }),
      prisma.descriptionDraft.create({
        data: {
          scope: "task",
          targetId: task.id,
          requesterUserId: historyUser.id,
          agentSlug: "agent-test",
          body: "Historical request",
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ]);

    const historyStatus = await getHumanUserRemovalStatus(historyUser.id);
    assert.equal(historyStatus.removable, false, "workflow and conversation history blocks removal");
    assert.deepEqual(
      new Set(historyStatus.blockers.map(({ key }) => key)),
      new Set([
        "assignedTasks",
        "actingManagerOf",
        "reportedTasks",
        "actingManagerOfEpic",
        "deployReviewerOfEpics",
        "reportedEpics",
        "epicWorkerAssignments",
        "comments",
        "activity",
        "descriptionDrafts",
        "deploymentReports",
        "deploymentApprovals",
        "pmEventDeliveries",
        "deletedProjects",
      ]),
      "all reporter, assignee, manager, reviewer, worker, and linked-history roles are surfaced",
    );

    // The helper accepts a transaction client so the production delete action
    // can re-check eligibility immediately before removing the account.
    await prisma.$transaction(async (tx) => {
      const status = await getHumanUserRemovalStatus(removable.id, tx);
      assert.equal(status.removable, true, "transactional eligibility check remains usable");
    });

    console.log("user-lifecycle-test: ok");
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
