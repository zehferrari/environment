import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function main() {
  const sandbox = mkdtempSync(path.join(tmpdir(), "task-hard-reset-"));
  const databasePath = path.join(sandbox, "test.db");
  const repositoryPath = path.join(sandbox, "repo");
  const worktreesRoot = `${repositoryPath}.worktrees`;
  const worktreePath = path.join(worktreesRoot, "ph-reset");
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.PM_OPENCLAW_CHANNEL_TOKEN = "reset-test-token";

  execFileSync("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
  });
  git(sandbox, ["init", repositoryPath]);
  git(repositoryPath, ["config", "user.name", "Reset Test"]);
  git(repositoryPath, ["config", "user.email", "reset@example.invalid"]);
  writeFileSync(path.join(repositoryPath, "base.txt"), "base\n");
  git(repositoryPath, ["add", "base.txt"]);
  git(repositoryPath, ["commit", "-m", "base"]);
  git(repositoryPath, ["branch", "-M", "main"]);
  git(repositoryPath, ["branch", "ph-reset"]);
  git(repositoryPath, ["worktree", "add", worktreePath, "ph-reset"]);
  writeFileSync(path.join(worktreePath, "uncommitted.txt"), "must be discarded\n");

  const { db } = await import("@/lib/db");
  try {
    const { quiesceTaskForHardReset } = await import("@/lib/tasks/hard-reset");
    const { runEpicMergeSpoolJob } = await import("@/lib/deploy/epic-merge");

    const owner = await db.user.create({
      data: { username: "owner", email: "owner@example.invalid", kind: "human", isOwner: true },
    });
    const agentProfile = await db.agent.create({
      data: { slug: "reset-agent", name: "Reset Agent", role: "coding", gatewayPort: 19991 },
    });
    const agent = await db.user.create({
      data: {
        username: "reset-agent",
        email: "reset-agent@example.invalid",
        kind: "agent",
        agentId: agentProfile.id,
      },
    });
    const project = await db.project.create({
      data: {
        slug: "hard-reset",
        name: "Hard reset",
        repositoryPath,
        workItemKeyPrefix: "RST",
      },
    });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Reset me",
        description: "Task definition survives",
        workItemKey: "RST-1",
        branchName: "ph-reset",
        commitPrefix: "RST-1",
        status: "In Progress",
        assigneeId: agent.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        approvedById: owner.id,
        deploymentStatus: "Pending",
        workflowVersion: 7,
        alertReporter: true,
      },
    });
    await db.activityLog.createMany({
      data: [
        { projectId: project.id, taskId: task.id, userId: owner.id, kind: "task.create", payload: JSON.stringify({ title: task.title }) },
        { projectId: project.id, taskId: task.id, userId: agent.id, kind: "task.chat.reply" },
      ],
    });
    const run = await db.pmChannelRun.create({
      data: {
        targetKey: "hard-reset-run",
        kind: "task-chat",
        agentSlug: "reset-agent",
        messageId: "reset-message",
        projectId: project.id,
        taskId: task.id,
        sessionKey: "pm:task:rst-1:old",
        gatewayPort: 19991,
        status: "streaming",
        admittedAt: new Date(),
        streamingAt: new Date(),
      },
    });
    await Promise.all([
      db.pmChannelJob.create({
        data: { runId: run.id, agentSlug: "reset-agent", kind: "task-chat", payload: "{}", status: "claimed" },
      }),
      db.comment.create({
        data: { taskId: task.id, userId: agent.id, body: "agent work", runId: run.id, authorAgentSlug: "reset-agent" },
      }),
      db.agentChatMessage.create({
        data: { projectId: project.id, taskId: task.id, agentSlug: "reset-agent", senderUserId: owner.id, body: "work on this" },
      }),
      db.taskRepositoryRun.create({
        data: { taskId: task.id, repositoryPath, branchName: "ph-reset", worktreePath, phase: "working" },
      }),
      db.taskExecutionState.create({
        data: { taskId: task.id, projectId: project.id, state: "running", reasonCode: "live_run" },
      }),
      db.taskExecutionEpisode.create({
        data: {
          taskId: task.id,
          projectId: project.id,
          episodeNo: 1,
          agentSlug: "reset-agent",
          cycleBudget: 8,
          status: "open",
        },
      }),
      db.agentSessionBinding.create({
        data: {
          scopeType: "task",
          scopeId: task.id,
          agentSlug: "reset-agent",
          openclawSessionKey: "pm:task:rst-1:old",
          openclawSessionId: "pm:task:rst-1:old",
          lastDispatchedMessageId: "reset-message",
          lastDispatchedAt: new Date(),
        },
      }),
      db.subTask.create({ data: { taskId: task.id, text: "temporary implementation step" } }),
    ]);
    const plan = await db.actionPlan.create({
      data: {
        taskId: task.id,
        summary: "temporary plan",
        status: "approved",
        authorId: agent.id,
        approvedOn: new Date(),
        approvedById: owner.id,
      },
    });
    await db.actionPlanRevision.create({
      data: {
        actionPlanId: plan.id,
        taskId: task.id,
        version: 1,
        summary: "temporary plan",
        status: "approved",
        authorId: agent.id,
        approvedById: owner.id,
        approvedOn: new Date(),
        contentHash: "reset-test",
      },
    });

    const gatewayRequests: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      gatewayRequests.push({ url: String(input), body: String(init?.body ?? "") });
      if (String(input).endsWith("/pm-channel/cancel")) {
        return new Response(JSON.stringify({ aborted: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ steered: true }), { status: 200 });
    }) as typeof fetch;

    const prepared = await quiesceTaskForHardReset({
      taskId: task.id,
      actorUserId: owner.id,
      actorUsername: owner.username,
      fetchImpl: fakeFetch,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    assert.deepEqual(
      gatewayRequests.map((request) => new URL(request.url).pathname),
      ["/pm-channel/steer", "/pm-channel/cancel"],
      "hard reset must tell the agent to stop and then abort the live gateway session",
    );
    assert.match(gatewayRequests[0].body, /Stop all work immediately/);

    const fenced = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(fenced.status, "Backlog");
    assert.equal(fenced.assigneeId, null);
    assert.equal(fenced.actingManagerId, null);
    const fencedRun = await db.pmChannelRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(fencedRun.status, "cancelled");
    assert.ok(fencedRun.cancellationAcknowledgedAt);

    await runEpicMergeSpoolJob({
      kind: "reset",
      jobId: `reset-${task.id}-${prepared.preparation.resetToken}`,
      taskId: task.id,
      projectId: project.id,
      requestedByUserId: owner.id,
      requestedByUsername: owner.username,
      resetToken: prepared.preparation.resetToken,
      repositoryPath,
      branchName: "ph-reset",
      stoppedAgents: prepared.preparation.stoppedAgents,
      enqueuedAt: new Date().toISOString(),
    });

    assert.equal(existsSync(worktreePath), false, "dirty task worktree should be removed");
    assert.throws(
      () => git(repositoryPath, ["show-ref", "--verify", "--quiet", "refs/heads/ph-reset"]),
      "local task branch should be removed",
    );
    const resetTask = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(resetTask.status, "Backlog");
    assert.equal(resetTask.assigneeId, null);
    assert.equal(resetTask.actingManagerId, null);
    assert.equal(resetTask.approvedOn, null);
    assert.equal(resetTask.approvedById, null);
    assert.equal(resetTask.branchName, null);
    assert.equal(resetTask.commitPrefix, null);
    assert.equal(resetTask.workflowVersion, 0);
    assert.equal(resetTask.description, "Task definition survives");

    const [comments, chats, plans, revisions, checklist, runs, repositoryRuns, executionStates, episodes] = await Promise.all([
      db.comment.count({ where: { taskId: task.id } }),
      db.agentChatMessage.count({ where: { taskId: task.id } }),
      db.actionPlan.count({ where: { taskId: task.id } }),
      db.actionPlanRevision.count({ where: { taskId: task.id } }),
      db.subTask.count({ where: { taskId: task.id } }),
      db.pmChannelRun.count({ where: { taskId: task.id } }),
      db.taskRepositoryRun.count({ where: { taskId: task.id } }),
      db.taskExecutionState.count({ where: { taskId: task.id } }),
      db.taskExecutionEpisode.count({ where: { taskId: task.id } }),
    ]);
    assert.deepEqual(
      { comments, chats, plans, revisions, checklist, runs, repositoryRuns, executionStates, episodes },
      { comments: 0, chats: 0, plans: 0, revisions: 0, checklist: 0, runs: 0, repositoryRuns: 0, executionStates: 0, episodes: 0 },
    );
    const activities = await db.activityLog.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(activities.map((activity) => activity.kind), ["task.create", "task.reset"]);
    const binding = await db.agentSessionBinding.findUniqueOrThrow({
      where: { scopeType_scopeId_agentSlug: { scopeType: "task", scopeId: task.id, agentSlug: "reset-agent" } },
    });
    assert.match(binding.openclawSessionKey, /:recovery:reset-/);
    assert.notEqual(binding.openclawSessionKey, "pm:task:rst-1:old");
    assert.equal(binding.lastDispatchedMessageId, null);

    console.log("task-hard-reset-test ok");
  } finally {
    await db.$disconnect();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
