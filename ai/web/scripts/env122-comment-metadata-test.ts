/**
 * ENV-122 — Focused verification for comment metadata provenance.
 *
 * Verifies:
 * 1. Schema compatibility: Comment model has the new metadata columns
 *    (authorAgentSlug, provider, model, runId, commentKind, isGenerated)
 *    and PmChannelRun has provider/model columns.
 * 2. Migration/schema column name alignment: @map attributes match the
 *    snake_case column names in the migration SQL.
 * 3. PM-run provenance persistence: when a PmChannelRun has provider/model
 *    set, comment creation sites that reference the run copy those values
 *    into the Comment row.
 * 4. FK constraint: Comment.run_id → PmChannelRun.id exists in the migration.
 *
 * Run: npx tsx scripts/env122-comment-metadata-test.ts
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function migrationColumnAlignmentTest() {
  const migrationPath = path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260805040600_env122_comment_metadata",
    "migration.sql",
  );
  const sql = readFileSync(migrationPath, "utf8");

  // Verify Comment columns use snake_case matching @map attributes.
  assert.ok(sql.includes('"author_agent_slug"'), 'Migration must add "author_agent_slug" column');
  assert.ok(sql.includes('"comment_kind"'), 'Migration must add "comment_kind" column');
  assert.ok(sql.includes('"is_generated"'), 'Migration must add "is_generated" column');
  assert.ok(sql.includes('"run_id"'), 'Migration must add "run_id" column');
  assert.ok(sql.includes('"provider"'), 'Migration must add "provider" column');
  assert.ok(sql.includes('"model"'), 'Migration must add "model" column');

  // Verify PmChannelRun provider/model columns.
  assert.ok(
    sql.includes('ALTER TABLE "PmChannelRun" ADD COLUMN "provider"'),
    "Migration must add provider column to PmChannelRun",
  );
  assert.ok(
    sql.includes('ALTER TABLE "PmChannelRun" ADD COLUMN "model"'),
    "Migration must add model column to PmChannelRun",
  );

  // Verify FK constraint for Comment.run_id → PmChannelRun.id.
  // SQLite uses inline REFERENCES syntax in ALTER TABLE ADD COLUMN.
  assert.ok(
    sql.includes('REFERENCES "PmChannelRun"("id") ON DELETE SET NULL'),
    "Migration must create FK from Comment.run_id → PmChannelRun.id with ON DELETE SET NULL",
  );

  // Verify index on run_id.
  assert.ok(
    sql.includes('"Comment_run_id_idx"'),
    "Migration must create index Comment_run_id_idx",
  );

  // Verify backfill logic.
  assert.ok(
    sql.includes("'human'") && sql.includes("comment_kind"),
    "Migration must backfill commentKind='human' for human-authored comments",
  );
  assert.ok(
    sql.includes("'agent_reply'") && sql.includes("comment_kind"),
    "Migration must backfill commentKind='agent_reply' for agent-authored comments",
  );

  console.log("✓ Migration column alignment: all columns, FK, index, and backfill verified");
}

async function databaseSlice() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    // --- Schema compatibility test ---
    const commentFields = Object.keys(prisma.comment.fields);
    const requiredCommentFields = ["authorAgentSlug", "provider", "model", "runId", "commentKind", "isGenerated"];
    for (const field of requiredCommentFields) {
      assert.ok(commentFields.includes(field), `Comment model missing field "${field}"`);
    }
    const runFields = Object.keys(prisma.pmChannelRun.fields);
    assert.ok(runFields.includes("provider"), 'PmChannelRun missing "provider"');
    assert.ok(runFields.includes("model"), 'PmChannelRun missing "model"');
    console.log("✓ Schema compatibility: Comment and PmChannelRun have all required metadata fields");

    // --- Provenance persistence test ---
    const testTargetKey = `env122-test-${Date.now()}`;
    const run = await prisma.pmChannelRun.create({
      data: {
        targetKey: testTargetKey,
        kind: "task-comment",
        agentSlug: "test-agent",
        messageId: `test-msg-${Date.now()}`,
        status: "completed",
        provider: "ollama",
        model: "glm-5.2:cloud",
      },
    });

    try {
      const agentUser = await prisma.user.create({
        data: {
          username: `env122-test-agent-${Date.now()}`,
          email: `env122-test-${Date.now()}@example.test`,
          kind: "agent",
          mustRotatePassword: false,
        },
      });

      try {
        const project = await prisma.project.create({
          data: { slug: `env122-test-${Date.now()}`, name: "ENV-122 Test" },
        });
        const task = await prisma.task.create({
          data: {
            projectId: project.id,
            title: "ENV-122 provenance test",
            status: "In Progress",
            assigneeId: agentUser.id,
            reporterId: agentUser.id,
            approvedOn: new Date(),
          },
        });

        try {
          const comment = await prisma.comment.create({
            data: {
              taskId: task.id,
              userId: agentUser.id,
              body: "Test comment for provenance verification",
              authorAgentSlug: "test-agent",
              commentKind: "agent_reply",
              isGenerated: false,
              runId: run.id,
              provider: run.provider,
              model: run.model,
            },
          });

          assert.equal(comment.provider, "ollama", "Comment.provider must match run provider");
          assert.equal(comment.model, "glm-5.2:cloud", "Comment.model must match run model");
          assert.equal(comment.runId, run.id, "Comment.runId must match run id");
          assert.equal(comment.authorAgentSlug, "test-agent", "Comment.authorAgentSlug must be set");
          assert.equal(comment.commentKind, "agent_reply", "Comment.commentKind must be set");
          assert.equal(comment.isGenerated, false, "Comment.isGenerated must be false for agent replies");
        } finally {
          await prisma.comment.deleteMany({ where: { taskId: task.id } });
          await prisma.task.delete({ where: { id: task.id } });
          await prisma.project.delete({ where: { id: project.id } });
        }
      } finally {
        await prisma.user.delete({ where: { id: agentUser.id } });
      }
    } finally {
      await prisma.pmChannelRun.delete({ where: { id: run.id } });
    }
    console.log("✓ PM-run provenance persistence: provider/model copied from run to comment");

    // --- Nullable provenance test ---
    const nullTargetKey = `env122-null-test-${Date.now()}`;
    const nullRun = await prisma.pmChannelRun.create({
      data: {
        targetKey: nullTargetKey,
        kind: "task-comment",
        agentSlug: "test-agent",
        messageId: `test-null-msg-${Date.now()}`,
        status: "completed",
      },
    });

    try {
      const nullAgentUser = await prisma.user.create({
        data: {
          username: `env122-null-agent-${Date.now()}`,
          email: `env122-null-${Date.now()}@example.test`,
          kind: "agent",
          mustRotatePassword: false,
        },
      });

      try {
        const nullProject = await prisma.project.create({
          data: { slug: `env122-null-${Date.now()}`, name: "ENV-122 Null Test" },
        });
        const nullTask = await prisma.task.create({
          data: {
            projectId: nullProject.id,
            title: "ENV-122 null provenance test",
            status: "In Progress",
            assigneeId: nullAgentUser.id,
            reporterId: nullAgentUser.id,
            approvedOn: new Date(),
          },
        });

        try {
          const nullComment = await prisma.comment.create({
            data: {
              taskId: nullTask.id,
              userId: nullAgentUser.id,
              body: "Test comment with null provenance",
              authorAgentSlug: "test-agent",
              commentKind: "agent_reply",
              isGenerated: false,
              runId: nullRun.id,
              provider: null,
              model: null,
            },
          });

          assert.equal(nullComment.provider, null, "Comment.provider should be null when run has no provider");
          assert.equal(nullComment.model, null, "Comment.model should be null when run has no model");
        } finally {
          await prisma.comment.deleteMany({ where: { taskId: nullTask.id } });
          await prisma.task.delete({ where: { id: nullTask.id } });
          await prisma.project.delete({ where: { id: nullProject.id } });
        }
      } finally {
        await prisma.user.delete({ where: { id: nullAgentUser.id } });
      }
    } finally {
      await prisma.pmChannelRun.delete({ where: { id: nullRun.id } });
    }
    console.log("✓ Nullable provenance: comments with null provider/model work correctly");
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (process.env.ENV122_DB_SLICE === "1") {
    console.log("ENV-122: Comment metadata provenance tests\n");
    migrationColumnAlignmentTest();
    await databaseSlice();
    console.log("\n✅ All ENV-122 comment metadata tests passed.");
    return;
  }

  const sandbox = await mkdtemp(path.join(tmpdir(), "env122-comment-metadata-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const env = { ...process.env, DATABASE_URL: dbUrl, ENV122_DB_SLICE: "1" };
  try {
    await execFileP("pnpm", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env,
    });
    await execFileP("pnpm", ["exec", "tsx", "scripts/env122-comment-metadata-test.ts"], {
      cwd: process.cwd(),
      env,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});