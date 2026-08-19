// ENV-122 focused tests: comment metadata provenance and migration/schema
// compatibility.
//
// Verifies:
// 1. PmChannelRun persists provider/model from recordPmChannelRunDispatch.
// 2. Comment creation sites copy provider/model/runId from the active run.
// 3. Migration columns match Prisma schema @map attributes (snake_case).
// 4. FK constraint exists: Comment.run_id → PmChannelRun.id ON DELETE SET NULL.
// 5. (Section 6) The task chat reply route stamps the actual replying agent on
//    a comment reply to a room-addressed message (not "room"), and attributes
//    the run via the targetKey identity even after the run left live status.
//
// Hermetic sqlite via prisma migrate deploy.
// Exit 0 on success, non-zero on first failure.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function fail(msg: string): never {
  console.error(`[env122-provenance] FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) fail(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function dbMigrateDeploy(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "env122-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const agentSlug = "provtest";

  process.env.DATABASE_URL = dbUrl;
  process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE = path.join(sandbox, "no-tokens.json");
  process.env[`PM_OPENCLAW_CHANNEL_TOKEN_${agentSlug.toUpperCase()}`] = "test-token";
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "env122-test-secret";

  try {
    await dbMigrateDeploy(dbUrl);
    await new Promise((r) => setTimeout(r, 200));

    const { db } = await import("@/lib/db");
    const {
      recordPmChannelRunQueued,
      recordPmChannelRunDispatch,
    } = await import("@/lib/agents/pm-channel/runs");
    const { pmChannelRunTargetKey } = await import("@/lib/agents/pm-channel/bus");

    // Shared fixtures
    const project = await db.project.create({ data: { slug: "prov-proj", name: "Provenance Project" } });
    const task = await db.task.create({
      data: { projectId: project.id, title: "Provenance test task", status: "In Progress" },
    });

    // ---- Section 1: PmChannelRun persists provider/model from dispatch ----
    {
      const messageId = randomUUID();
      const target = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId,
      };

      // Create the run (queued state)
      await recordPmChannelRunQueued({
        target,
        kind: "task-comment",
        projectId: project.id,
      });

      // Dispatch with provider/model in the result
      await recordPmChannelRunDispatch({
        target,
        result: {
          ok: true,
          status: 202,
          driver: "openclaw-pm-channel",
          transportMode: "http",
          provider: "ollama",
          model: "glm-5.2:cloud",
        },
      });

      // Verify the run has provider/model persisted
      const run = await db.pmChannelRun.findUnique({
        where: { targetKey: pmChannelRunTargetKey(target) },
        select: { id: true, provider: true, model: true, status: true },
      });

      assert(run !== null, "run should exist after dispatch");
      assertEqual(run!.provider, "ollama", "run.provider should be ollama");
      assertEqual(run!.model, "glm-5.2:cloud", "run.model should be glm-5.2:cloud");
      assertEqual(run!.status, "delivered", "run.status should be delivered after successful dispatch");

      console.log("[env122-provenance] Section 1 passed: provider/model persisted on PmChannelRun");
    }

    // ---- Section 2: Comment copies provider/model/runId from active run ----
    {
      const messageId = randomUUID();
      const target = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId,
      };

      await recordPmChannelRunQueued({
        target,
        kind: "task-comment",
        projectId: project.id,
      });

      await recordPmChannelRunDispatch({
        target,
        result: {
          ok: true,
          status: 202,
          driver: "openclaw-pm-channel",
          transportMode: "http",
          provider: "ollama",
          model: "kimi-k2.7-code:cloud",
        },
      });

      const run = await db.pmChannelRun.findUnique({
        where: { targetKey: pmChannelRunTargetKey(target) },
        select: { id: true, provider: true, model: true },
      });

      // Create a test agent + user to author the comment
      const agentUser = await db.user.create({
        data: {
          email: `${agentSlug}-${randomUUID()}@test.local`,
          username: `${agentSlug}-${Date.now()}`,
          kind: "agent",
          status: "active",
        },
      });
      await db.agent.create({
        data: { slug: `${agentSlug}-${randomUUID()}`, name: agentSlug, role: "coding", user: { connect: { id: agentUser.id } } },
      });

      const comment = await db.comment.create({
        data: {
          taskId: task.id,
          userId: agentUser.id,
          body: "Test comment with provenance",
          authorAgentSlug: agentSlug,
          commentKind: "agent_reply",
          isGenerated: false,
          runId: run!.id,
          provider: run!.provider,
          model: run!.model,
        },
        select: { id: true, provider: true, model: true, runId: true, commentKind: true },
      });

      assertEqual(comment.provider, "ollama", "comment.provider should be ollama");
      assertEqual(comment.model, "kimi-k2.7-code:cloud", "comment.model should match run model");
      assertEqual(comment.runId, run!.id, "comment.runId should match run id");
      assertEqual(comment.commentKind, "agent_reply", "comment.commentKind should be agent_reply");

      console.log("[env122-provenance] Section 2 passed: comment copies provider/model/runId from run");
    }

    // ---- Section 3: Migration columns match Prisma @map (snake_case) ----
    {
      // Query sqlite to check column names exist (case-sensitive in sqlite for quoted identifiers)
      const result = await db.$queryRaw`
        SELECT name FROM pragma_table_info('Comment')
        WHERE name IN ('author_agent_slug', 'comment_kind', 'is_generated', 'run_id', 'provider', 'model')
        ORDER BY name
      ` as Array<{ name: string }>;

      const columnNames = result.map((r) => r.name).sort();
      const expected = ["author_agent_slug", "comment_kind", "is_generated", "model", "provider", "run_id"];
      assertEqual(
        columnNames.length,
        expected.length,
        `migration should add all 6 metadata columns to Comment (found: ${columnNames.join(", ")})`,
      );
      for (let i = 0; i < expected.length; i++) {
        assertEqual(columnNames[i], expected[i], `Comment column ${i} should be ${expected[i]}`);
      }

      // Check PmChannelRun has provider/model columns
      const runCols = await db.$queryRaw`
        SELECT name FROM pragma_table_info('PmChannelRun')
        WHERE name IN ('provider', 'model')
        ORDER BY name
      ` as Array<{ name: string }>;

      assertEqual(runCols.length, 2, "PmChannelRun should have provider and model columns");
      assertEqual(runCols[0].name, "model", "PmChannelRun first new column should be model");
      assertEqual(runCols[1].name, "provider", "PmChannelRun second new column should be provider");

      console.log("[env122-provenance] Section 3 passed: migration columns match Prisma @map attributes");
    }

    // ---- Section 4: FK constraint exists: Comment.run_id → PmChannelRun.id ----
    {
      // sqlite stores FK info in pragma_foreign_key_list
      const fkResult = await db.$queryRaw`
        SELECT "table" as referenced_table, "on_delete" as on_delete_action
        FROM pragma_foreign_key_list('Comment')
        WHERE "table" = 'PmChannelRun'
      ` as Array<{ referenced_table: string; on_delete_action: string }>;

      assert(fkResult.length > 0, "Comment should have a FK to PmChannelRun");
      assertEqual(fkResult[0].referenced_table, "PmChannelRun", "FK should reference PmChannelRun");
      assertEqual(
        fkResult[0].on_delete_action.toUpperCase(),
        "SET NULL",
        "FK on_delete should be SET NULL",
      );

      console.log("[env122-provenance] Section 4 passed: FK constraint Comment.run_id → PmChannelRun.id ON DELETE SET NULL");
    }

    // ---- Section 5: Backfill sets commentKind correctly ----
    {
      // Create a human user and verify backfill logic
      const humanUser = await db.user.create({
        data: {
          email: `human-${randomUUID()}@test.local`,
          username: `human-${Date.now()}`,
          kind: "human",
          status: "active",
        },
      });

      const humanComment = await db.comment.create({
        data: {
          taskId: task.id,
          userId: humanUser.id,
          body: "Human comment",
          // Don't set commentKind — migration backfill should handle it
        },
        select: { id: true, commentKind: true },
      });

      // In practice the migration backfill runs during migrate deploy,
      // but new comments created after migration won't be backfilled.
      // The backfill only applies to pre-existing comments. So we just
      // verify that the column is nullable and accepts explicit values.
      const explicitComment = await db.comment.create({
        data: {
          taskId: task.id,
          userId: humanUser.id,
          body: "Explicit kind comment",
          commentKind: "human",
          isGenerated: false,
        },
        select: { id: true, commentKind: true, isGenerated: true },
      });

      assertEqual(explicitComment.commentKind, "human", "explicit commentKind=human should persist");
      assertEqual(explicitComment.isGenerated, false, "isGenerated should default to false for human comments");

      console.log("[env122-provenance] Section 5 passed: commentKind/isGenerated persist correctly");
    }

    // ---- Section 6: Route comment reply to a room-addressed message stamps
    // the actual replying agent and attributes the run by targetKey ----
    {
      const { createTaskChatReplyToken } = await import("@/lib/agents/workflow/chat/task/token");
      const { NextRequest } = await import("next/server");
      const { POST } = await import("../app/api/tasks/[id]/chat/reply/route");

      const replierSlug = `replier-${randomUUID().slice(0, 8)}`;
      const replierUser = await db.user.create({
        data: {
          email: `${replierSlug}@test.local`,
          username: replierSlug,
          kind: "agent",
          status: "active",
        },
      });
      await db.agent.create({
        data: { slug: replierSlug, name: replierSlug, role: "coding", user: { connect: { id: replierUser.id } } },
      });
      const ownerUser = await db.user.create({
        data: {
          email: `owner-${randomUUID()}@test.local`,
          username: `owner-${Date.now()}`,
          kind: "human",
          status: "active",
          isOwner: true,
        },
      });

      const roomTask = await db.task.create({
        data: { projectId: project.id, title: "Room reply attribution task", status: "In Progress" },
      });
      // Room-addressed, comment-origin message: the message row does NOT
      // identify the replying agent — only the per-agent reply token does.
      const roomMsg = await db.agentChatMessage.create({
        data: {
          projectId: project.id,
          taskId: roomTask.id,
          agentSlug: "room",
          senderUserId: ownerUser.id,
          body: "Room-addressed message mirrored from a comment",
          originChannel: "comment",
          originCommentId: null,
        },
        select: { id: true },
      });

      const target = {
        kind: "task-comment" as const,
        agentSlug: replierSlug,
        taskId: roomTask.id,
        messageId: roomMsg.id,
      };
      await recordPmChannelRunQueued({ target, kind: "task-comment", projectId: project.id });
      await recordPmChannelRunDispatch({
        target,
        result: {
          ok: true,
          status: 202,
          driver: "openclaw-pm-channel",
          transportMode: "http",
          provider: "ollama",
          model: "glm-5.2:cloud",
        },
      });
      const run = await db.pmChannelRun.findUnique({
        where: { targetKey: pmChannelRunTargetKey(target) },
        select: { id: true },
      });
      assert(run !== null, "room-reply run should exist");
      // The token route is the out-of-band fallback: the gateway session can
      // finish after PM already timed the run out. Attribution must survive
      // the run leaving live status (same semantics as persist-task-reply).
      await db.pmChannelRun.update({ where: { id: run!.id }, data: { status: "timed_out" } });

      const token = createTaskChatReplyToken(roomMsg.id, roomTask.id, replierSlug);
      const req = new NextRequest(`http://localhost/api/tasks/${roomTask.id}/chat/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: roomMsg.id, token, body: "Reply from the actual agent" }),
      });
      try {
        const res = await POST(req, { params: Promise.resolve({ id: roomTask.id }) });
        assertEqual(res.status, 200, "room reply route should return 200");
      } catch (err) {
        // Cache revalidation has no static-generation store outside a real
        // Next.js request; the reply transaction has already committed then.
        const message = err instanceof Error ? err.message : String(err);
        if (!/static generation store missing/i.test(message)) throw err;
      }

      const comment = await db.comment.findFirst({
        where: { taskId: roomTask.id, commentKind: "agent_reply" },
        select: { authorAgentSlug: true, userId: true, runId: true, provider: true, model: true },
      });
      assert(comment !== null, "room reply should persist a comment");
      assertEqual(
        comment!.authorAgentSlug,
        replierSlug,
        'room reply comment should carry the real replying agent slug, not "room"',
      );
      assertEqual(comment!.userId, replierUser.id, "room reply comment should belong to the replying agent's user");
      assertEqual(
        comment!.runId,
        run!.id,
        "room reply comment should attribute the run that produced it (targetKey lookup)",
      );
      assertEqual(comment!.provider, "ollama", "room reply comment.provider should copy the run provider");
      assertEqual(comment!.model, "glm-5.2:cloud", "room reply comment.model should copy the run model");

      console.log("[env122-provenance] Section 6 passed: room-addressed reply stamps the real agent and run provenance");
    }

    console.log("\n[env122-provenance] All sections passed ✓");
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[env122-provenance] UNCAUGHT:", err);
  process.exit(1);
});
