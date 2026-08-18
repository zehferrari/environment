import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "agent-system-message-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  try {
    await execFileP("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    const { db } = await import("@/lib/db");
    const {
      isSilentPmReplyText,
      isPmTerminalFailureText,
      modelFallbackActivityText,
    } = await import("@/lib/agents/ops/pm-silence");
    const { recordModelFallbackActivity } = await import(
      "@/lib/agents/ops/model-fallback-activity"
    );

    const notice = "↪️ Model Fallback: ollama/kimi-k2.6:cloud (selected claude-cli/claude-opus-5; session expired)";
    assert.equal(modelFallbackActivityText(notice), notice);
    assert.equal(modelFallbackActivityText(notice + "\nActual task contribution."), null);
    assert.equal(
      isSilentPmReplyText("PM_SILENT_NO_CONTRIBUTIONPM_SILENT_NO_CONTRIBUTION"),
      true,
    );
    assert.equal(
      isPmTerminalFailureText("⚠️ Model login expired on the gateway for claude-cli. Re-auth and retry."),
      true,
    );
    assert.equal(
      isPmTerminalFailureText("⚠️ Agent couldn't generate a response. Some tools may have run."),
      true,
    );
    assert.equal(
      isPmTerminalFailureText("⚠️ 🛠️ Exec failed: `run test` (workspace)"),
      true,
    );
    assert.equal(
      isPmTerminalFailureText("The agent explained why an exec failed: this is a real reply."),
      false,
    );

    const agent = await db.agent.create({
      data: { slug: "system-test-agent", name: "System Test Agent", role: "coding" },
    });
    const user = await db.user.create({
      data: {
        username: "system-test-agent",
        email: "system-test-agent@example.test",
        kind: "agent",
        agentId: agent.id,
      },
    });
    const project = await db.project.create({
      data: { slug: "system-message-test", name: "System Message Test" },
    });
    const task = await db.task.create({
      data: { projectId: project.id, title: "No fallback spam" },
    });
    const input = {
      agentUserId: user.id,
      agentSlug: agent.slug,
      projectId: project.id,
      taskId: task.id,
      messageId: "first-transport-message",
      message: notice,
      driver: "test",
    };
    assert.equal((await recordModelFallbackActivity(input)).created, true);
    assert.equal((await recordModelFallbackActivity({
      ...input,
      messageId: "duplicate-transport-message",
    })).created, false);
    assert.equal(
      await db.activityLog.count({ where: { kind: "agent.model_fallback" } }),
      1,
      "the same fallback notice must be stored once per task and agent",
    );
    await db.$disconnect();
    console.log("[agent-system-message] PASS");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
