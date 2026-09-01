import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

import { NextRequest } from "next/server";
import { discussionMessageCapabilities } from "../lib/agents/chat/capabilities";
import { createEpicDescriptionWriteToken } from "../lib/agents/workflow/chat/epic/token";
import { createTaskDescriptionWriteToken } from "../lib/agents/workflow/chat/task/token";

const execFileP = promisify(execFile);

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

async function dbPush(dbUrl: string) {
  await execFileP(
    "pnpm",
    [
      "prisma",
      "db",
      "push",
      "--skip-generate",
      "--accept-data-loss",
      "--schema=prisma/schema.prisma",
    ],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
}

function request(url: string, messageId: string, token: string, description: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId, token, description }),
  });
}

async function main() {
  process.env.AUTH_SECRET ??= "description-draft-test-secret";

  const descriptionCapabilities = discussionMessageCapabilities({
    actorKind: "human",
    canTriggerAgents: true,
    originChannel: "description",
  });
  check("Description control grants direct draft write-back", descriptionCapabilities.allowDescriptionEdit);
  check("Description control grants no proposal capability", !descriptionCapabilities.allowWorkItemManagement);
  const ordinaryChatCapabilities = discussionMessageCapabilities({
    actorKind: "human",
    canTriggerAgents: true,
    originChannel: "chat",
  });
  check("Ordinary owner chat keeps description capability", ordinaryChatCapabilities.allowDescriptionEdit);
  check("Ordinary owner chat keeps proposal capability", ordinaryChatCapabilities.allowWorkItemManagement);

  const [descriptionFieldSource, chatActionsSource] = await Promise.all([
    readFile(path.join(process.cwd(), "components/description-field.tsx"), "utf8"),
    readFile(path.join(process.cwd(), "lib/agents/chat/actions.ts"), "utf8"),
  ]);
  check(
    "Description popup exposes dispatch errors",
    descriptionFieldSource.includes("setAiSubmitError")
      && descriptionFieldSource.includes('role="alert"')
      && descriptionFieldSource.includes("The request could not be started"),
  );
  check(
    "Undispatched description grants are retired without stealing durable runs",
    chatActionsSource.includes("invalidateUndispatchedDescriptionGrant")
      && chatActionsSource.includes("tx.pmChannelRun.findFirst")
      && chatActionsSource.includes("if (run) return false"),
  );

  const sandbox = await mkdtemp(path.join(tmpdir(), "description-draft-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const originalDbUrl = process.env.DATABASE_URL;
  let disconnect: (() => Promise<void>) | undefined;

  try {
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;

    const [{ db }, taskRoute, epicRoute, speculativeContext] = await Promise.all([
      import("../lib/db"),
      import("../app/api/tasks/[id]/description/route"),
      import("../app/api/epics/[id]/description/route"),
      import("../lib/agents/context/speculative"),
    ]);
    disconnect = () => db.$disconnect();

    const agent = await db.agent.create({
      data: { slug: "draft-agent", name: "Draft Agent", role: "manager" },
    });
    const agentUser = await db.user.create({
      data: {
        username: "draft-agent",
        email: "draft-agent@example.test",
        kind: "agent",
        agentId: agent.id,
      },
    });
    const owner = await db.user.create({
      data: {
        username: "draft-owner",
        email: "draft-owner@example.test",
        kind: "human",
        isOwner: true,
      },
    });
    const project = await db.project.create({
      data: { slug: "description-draft-test", name: "Description Draft Test" },
    });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Task description target",
        description: "Saved task description",
      },
    });
    const epic = await db.epic.create({
      data: {
        projectId: project.id,
        title: "Empty Epic description target",
        description: "",
        actingManagerId: agentUser.id,
      },
    });

    await db.$executeRawUnsafe(
      `INSERT INTO "ActivityLog" ("id", "projectId", "kind", "createdAt") VALUES ('malformed-description-date', '${project.id}', 'test.malformed_date', '2026-08-19 02:25:57')`,
    );
    const degradedRevision = JSON.parse(await speculativeContext.chatContextRevision({
      projectId: project.id,
      epicId: epic.id,
    })) as { a?: [number, number] };
    check(
      "Malformed historical activity cannot block description dispatch",
      degradedRevision.a?.[0] === -1 && Number.isFinite(degradedRevision.a?.[1]),
      degradedRevision,
    );

    const staleOrphan = await db.agentChatMessage.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        agentSlug: "room",
        senderUserId: owner.id,
        body: "stale undispatched description request",
        allowDescriptionEdit: true,
        originChannel: "description",
        createdAt: new Date(Date.now() - 120_000),
      },
    });
    const freshOrphan = await db.agentChatMessage.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        agentSlug: "room",
        senderUserId: owner.id,
        body: "fresh description request",
        allowDescriptionEdit: true,
        originChannel: "description",
      },
    });
    const durableRequest = await db.agentChatMessage.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        agentSlug: "room",
        senderUserId: owner.id,
        body: "description request with durable run",
        allowDescriptionEdit: true,
        originChannel: "description",
        createdAt: new Date(Date.now() - 120_000),
      },
    });
    await db.pmChannelRun.create({
      data: {
        targetKey: `description-test:${durableRequest.id}`,
        kind: "epic-chat",
        agentSlug: agent.slug,
        messageId: durableRequest.id,
        projectId: project.id,
        epicId: epic.id,
        status: "queued",
      },
    });

    const migrationSql = await readFile(
      path.join(
        process.cwd(),
        "prisma/migrations/20260831034000_normalize_activity_log_datetime_storage/migration.sql",
      ),
      "utf8",
    );
    for (const statement of migrationSql.split(";").map((part) => part.trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }
    const normalized = await db.$queryRawUnsafe<Array<{ storageType: string }>>(
      `SELECT typeof("createdAt") AS "storageType" FROM "ActivityLog" WHERE "id" = 'malformed-description-date'`,
    );
    check("Timestamp migration normalizes ISO text to epoch storage", normalized[0]?.storageType === "integer", normalized);
    const repairedRevision = JSON.parse(await speculativeContext.chatContextRevision({
      projectId: project.id,
      epicId: epic.id,
    })) as { a?: [number, number] };
    check("Repaired activity participates in context revision", repairedRevision.a?.[0] === 1, repairedRevision);

    const [staleAfter, freshAfter, durableAfter] = await Promise.all([
      db.agentChatMessage.findUniqueOrThrow({ where: { id: staleOrphan.id } }),
      db.agentChatMessage.findUniqueOrThrow({ where: { id: freshOrphan.id } }),
      db.agentChatMessage.findUniqueOrThrow({ where: { id: durableRequest.id } }),
    ]);
    check("Migration retires stale request with no run", staleAfter.editGrantUsedAt !== null);
    check("Migration preserves fresh request grace window", freshAfter.editGrantUsedAt === null);
    check("Migration preserves request owned by durable run", durableAfter.editGrantUsedAt === null);

    const taskMessage = await db.agentChatMessage.create({
      data: {
        projectId: project.id,
        taskId: task.id,
        agentSlug: agent.slug,
        senderUserId: owner.id,
        body: "Improve the task description",
        allowDescriptionEdit: true,
        originChannel: "description",
      },
    });
    const taskDraftText = "# Improved task\n\nStill unsaved.";
    const taskResponse = await taskRoute.POST(
      request(
        `http://localhost/api/tasks/${task.id}/description`,
        taskMessage.id,
        createTaskDescriptionWriteToken(taskMessage.id, task.id, agent.slug),
        taskDraftText,
      ),
      { params: Promise.resolve({ id: task.id }) },
    );
    const taskAfter = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    const taskDraft = await db.descriptionDraft.findUnique({
      where: {
        scope_targetId_requesterUserId: {
          scope: "task",
          targetId: task.id,
          requesterUserId: owner.id,
        },
      },
    });
    check("Task Ask AI write-back succeeds", taskResponse.status === 200, await taskResponse.text());
    check("Task saved description is unchanged", taskAfter.description === "Saved task description", taskAfter.description);
    check("Task form draft receives agent text", taskDraft?.body === taskDraftText, taskDraft?.body);

    const epicMessage = await db.agentChatMessage.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        agentSlug: agent.slug,
        senderUserId: owner.id,
        body: "Improve the epic description",
        allowDescriptionEdit: true,
        originChannel: "description",
      },
    });
    const epicDraftText = "# Improved Epic\n\nStill unsaved.";
    const epicResponse = await epicRoute.POST(
      request(
        `http://localhost/api/epics/${epic.id}/description`,
        epicMessage.id,
        createEpicDescriptionWriteToken(epicMessage.id, epic.id, agent.slug),
        epicDraftText,
      ),
      { params: Promise.resolve({ id: epic.id }) },
    );
    const epicAfter = await db.epic.findUniqueOrThrow({ where: { id: epic.id } });
    const epicDraft = await db.descriptionDraft.findUnique({
      where: {
        scope_targetId_requesterUserId: {
          scope: "epic",
          targetId: epic.id,
          requesterUserId: owner.id,
        },
      },
    });
    check("Epic Ask AI write-back succeeds", epicResponse.status === 200, await epicResponse.text());
    check("Empty Epic remains unsaved", epicAfter.description === "", epicAfter.description);
    check("Epic form draft receives agent text", epicDraft?.body === epicDraftText, epicDraft?.body);

    const legacyEpic = await db.epic.create({
      data: {
        projectId: project.id,
        title: "Manager chat description target",
        description: "",
        actingManagerId: agentUser.id,
      },
    });
    const legacyMessage = await db.agentChatMessage.create({
      data: {
        projectId: project.id,
        epicId: legacyEpic.id,
        agentSlug: agent.slug,
        senderUserId: owner.id,
        body: "Write the initially missing epic description",
        allowDescriptionEdit: true,
        originChannel: "chat",
      },
    });
    const legacyText = "Manager-owned initial description";
    const legacyResponse = await epicRoute.POST(
      request(
        `http://localhost/api/epics/${legacyEpic.id}/description`,
        legacyMessage.id,
        createEpicDescriptionWriteToken(legacyMessage.id, legacyEpic.id, agent.slug),
        legacyText,
      ),
      { params: Promise.resolve({ id: legacyEpic.id }) },
    );
    const legacyAfter = await db.epic.findUniqueOrThrow({ where: { id: legacyEpic.id } });
    check("Unrelated manager-chat initialization still succeeds", legacyResponse.status === 200, await legacyResponse.text());
    check("Manager-chat initialization remains direct", legacyAfter.description === legacyText, legacyAfter.description);

    const draftActivities = await db.activityLog.findMany({
      where: { kind: { in: ["task.description.agent_write", "epic.description.agent_write"] } },
      select: { payload: true },
    });
    check(
      "Ask AI activity is explicitly marked as draft",
      draftActivities.filter((row) => row.payload?.includes('"draft":true')).length === 2,
      draftActivities,
    );

    if (failures > 0) process.exitCode = 1;
    else console.log("[description-draft-writeback] all checks passed");
  } finally {
    if (disconnect) await disconnect();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
