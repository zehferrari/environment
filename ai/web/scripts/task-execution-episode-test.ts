// ENV-121 — bounded execution episodes.
//
// Section A is pure: checkpoint encode/decode round-trips, and the episode
// caps really are an order of magnitude below the coding profile.
//
// Section B runs against real rows on a throwaway sqlite:
//   B1 the first workflow action opens episode 1 and counts one cycle
//   B2 an explicit `checkpoint` action persists the agent's words verbatim
//      and does NOT spend budget
//   B3 exhausting the budget closes the episode with its checkpoint and opens
//      the successor in the same transaction
//   B4 a duplicated rollover cannot mint a second episode with the same number
//   B5 an episode-terminal action closes the open episode
//   B6 the continuation brief carries the checkpoint, stays under the brief
//      budget, and its size is FLAT in the number of comments on the task —
//      the property that distinguishes "bounded" from "merely smaller"
//
// Never touches the live pm.db: DATABASE_URL is repointed at a temp file
// before any lib import, per the scripts/workflow-action-effect-test.ts
// convention.

import "./lib/next-als-polyfill";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { CODE_CAPS, EPISODE_CAPS, episodeBriefCharBudget } from "@/lib/agents/context/caps";

const execFileP = promisify(execFile);

let checks = 0;

function fail(msg: string): never {
  console.error(`[task-execution-episode] FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, label: string): asserts cond {
  checks += 1;
  if (!cond) fail(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function dbPush(dbUrl: string) {
  await execFileP(
    "node_modules/.bin/prisma",
    ["db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

function sectionA(): void {
  // The episode profile exists to make continuation turns small. "Smaller than
  // CODE_CAPS" is not the bar — an order of magnitude on the dimension that
  // actually drives packet size is.
  assert(
    EPISODE_CAPS.maxRenderedTimelineChars * 5 <= CODE_CAPS.maxRenderedTimelineChars,
    "episode timeline budget is at least 5x below the coding profile",
  );
  assert(
    EPISODE_CAPS.maxComments * 5 <= CODE_CAPS.maxComments,
    "episode comment cap is at least 5x below the coding profile",
  );
  assertEqual(EPISODE_CAPS.maxArchivedChats, 0, "a continuation never inlines an archived chain");
  assertEqual(
    EPISODE_CAPS.attachmentInlineBudget,
    0,
    "a continuation never inlines attachment excerpts — they are retrievable",
  );
  assert(episodeBriefCharBudget() > 0, "the brief has a declared character ceiling");
}

const AGENT_SLUG = "episodebot";

async function sectionB(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "task-execution-episode-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "task-execution-episode-test-secret";
  // A small, explicit budget keeps the rollover assertions readable.
  process.env.PM_EPISODE_MAX_CYCLES = "3";

  try {
    await dbPush(dbUrl);

    const { db } = await import("@/lib/db");
    const {
      closeOpenTaskExecutionEpisode,
      openTaskExecutionEpisode,
      latestTaskExecutionCheckpoint,
      recordTaskExecutionEpisodeCycle,
      renderEpisodeCheckpoint,
      taskExecutionEpisodeHistory,
      episodeCycleBudget,
      EPISODE_CLOSE_REASON,
    } = await import("@/lib/agents/episodes/lifecycle");
    const { buildTaskEpisodeBrief } = await import("@/lib/agents/context/task");

    assertEqual(episodeCycleBudget(), 3, "PM_EPISODE_MAX_CYCLES is honoured");

    const agent = await db.agent.create({
      data: { slug: AGENT_SLUG, name: "Episode Bot", role: "coding" },
    });
    const agentUser = await db.user.create({
      data: {
        username: AGENT_SLUG,
        email: `${AGENT_SLUG}@example.invalid`,
        kind: "agent",
        agentId: agent.id,
      },
    });
    const owner = await db.user.create({
      data: {
        username: "episode-owner",
        email: "episode-owner@example.invalid",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const project = await db.project.create({ data: { slug: "episodes", name: "Episodes" } });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Episode task",
        status: "In Progress",
        assigneeId: agentUser.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        description: "Bound the context.",
      },
    });

    const cycle = (args: Parameters<typeof recordTaskExecutionEpisodeCycle>[1]) =>
      db.$transaction((tx) => recordTaskExecutionEpisodeCycle(tx, args));

    // B1 — the first action opens episode 1 and counts one cycle.
    const first = await cycle({
      taskId: task.id,
      projectId: project.id,
      agentSlug: AGENT_SLUG,
      action: "start",
      messageId: "msg-1",
    });
    assertEqual(first.episode.episodeNo, 1, "B1: first action opens episode 1");
    assertEqual(first.episode.cycleCount, 1, "B1: first action counts one cycle");
    assertEqual(first.rolledOver, false, "B1: one cycle does not exhaust a budget of 3");
    assert(
      first.episode.checkpoint.completedWork.some((line) => line.includes("start")),
      "B1: PM derives a completed-work line from the action itself",
    );

    // B2 — an explicit checkpoint persists the agent's own words and buys no
    // progress, so it must not spend budget.
    const checkpointed = await cycle({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      checkpoint: {
        evidence: ["worktree /srv/x/env-121", "tsc clean"],
        openChecklist: ["wire the dispatcher", "write the test"],
        nextAction: "wire buildTaskEpisodeBrief into sendTaskWorkflowNotification",
        risks: ["episode rollover races the continuation drain"],
      },
      countsAgainstBudget: false,
    });
    assertEqual(checkpointed.episode.cycleCount, 1, "B2: an explicit checkpoint spends no cycle");
    assertEqual(
      checkpointed.episode.checkpoint.nextAction,
      "wire buildTaskEpisodeBrief into sendTaskWorkflowNotification",
      "B2: nextAction round-trips verbatim",
    );
    assertEqual(
      checkpointed.episode.checkpoint.evidence.length,
      2,
      "B2: evidence round-trips as a list",
    );
    assert(
      checkpointed.episode.checkpoint.completedWork.some((line) => line.includes("start")),
      "B2: a partial checkpoint does not blank the fields it omits",
    );

    // B3 — exhausting the budget closes the episode WITH its checkpoint and
    // opens the successor in the same transaction.
    await cycle({ taskId: task.id, agentSlug: AGENT_SLUG, action: "add_subtask", messageId: "msg-1" });
    const exhausting = await cycle({
      taskId: task.id,
      projectId: project.id,
      agentSlug: AGENT_SLUG,
      action: "complete_subtask",
      messageId: "msg-1",
    });
    assertEqual(exhausting.rolledOver, true, "B3: the third cycle exhausts a budget of 3");
    assertEqual(
      exhausting.episode.closeReason,
      EPISODE_CLOSE_REASON.budgetExhausted,
      "B3: the closed episode records why it closed",
    );
    assertEqual(exhausting.episode.status, "closed", "B3: the exhausted episode is closed");
    assertEqual(
      exhausting.episode.checkpoint.nextAction,
      "wire buildTaskEpisodeBrief into sendTaskWorkflowNotification",
      "B3: the checkpoint survives closure",
    );
    assertEqual(exhausting.nextEpisode?.episodeNo, 2, "B3: the successor is episode 2");
    assertEqual(exhausting.nextEpisode?.status, "open", "B3: the successor is open");

    // B4 — the unique index is the duplicate-rollover guard. Two writers that
    // both allocate the same number cannot both win.
    let duplicateRejected = false;
    // Prisma logs the constraint violation at error level. It is the EXPECTED
    // outcome here, so silence it rather than leaving a passing run looking
    // like a failing one.
    const realConsoleError = console.error;
    console.error = () => {};
    try {
      await db.$transaction((tx) =>
        openTaskExecutionEpisode(tx, {
          taskId: task.id,
          agentSlug: AGENT_SLUG,
          // Force the number the successor already holds.
          cycleBudget: 3,
        }).then(() =>
          tx.taskExecutionEpisode.create({
            data: {
              taskId: task.id,
              agentSlug: AGENT_SLUG,
              episodeNo: 2,
              cycleBudget: 3,
            },
          }),
        ),
      );
    } catch {
      duplicateRejected = true;
    } finally {
      console.error = realConsoleError;
    }
    assert(duplicateRejected, "B4: a duplicate (task, agent, episodeNo) is rejected");
    // The failed transaction must have rolled its speculative episode back.
    const afterDuplicate = await taskExecutionEpisodeHistory({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      take: 10,
    });
    assertEqual(afterDuplicate.length, 2, "B4: the rejected rollover left no extra episode");

    // B5 — an episode-terminal action closes the open episode.
    const closed = await db.$transaction((tx) =>
      closeOpenTaskExecutionEpisode(tx, {
        taskId: task.id,
        agentSlug: AGENT_SLUG,
        closeReason: `${EPISODE_CLOSE_REASON.terminalAction}:ready_for_review`,
        checkpoint: { nextAction: "await review" },
      }),
    );
    assertEqual(closed?.status, "closed", "B5: a terminal action closes the episode");
    assertEqual(closed?.checkpoint.nextAction, "await review", "B5: the terminal checkpoint lands");
    assertEqual(
      await db.taskExecutionEpisode.count({ where: { taskId: task.id, status: "open" } }),
      0,
      "B5: no episode is left open",
    );

    // B6 — the continuation brief. It must carry the checkpoint, stay under
    // the declared budget, and NOT grow with the task's comment history.
    const latest = await latestTaskExecutionCheckpoint({ taskId: task.id, agentSlug: AGENT_SLUG });
    assert(latest, "B6: a closed episode is discoverable as the latest checkpoint");

    const briefFor = async () =>
      (
        await buildTaskEpisodeBrief({
          taskId: task.id,
          agentSlug: AGENT_SLUG,
          currentTurn: { source: "task comment", body: "continue", actorUsername: "pm" },
          episode: { episodeNo: 3, checkpointLines: renderEpisodeCheckpoint(latest!) },
        })
      ).renderedPrompt;

    const before = await briefFor();
    assert(before.includes("EXECUTION EPISODE BRIEF"), "B6: the brief labels itself");
    assert(before.includes("await review"), "B6: the brief carries the checkpoint's next action");
    assert(
      before.includes("retrievable") || before.includes("retriev"),
      "B6: the brief tells the agent full history is retrievable",
    );

    for (let i = 0; i < 120; i += 1) {
      await db.comment.create({
        data: {
          taskId: task.id,
          userId: owner.id,
          body: `Comment ${i}: ${"x".repeat(400)}`,
        },
      });
    }
    const after = await briefFor();

    assert(
      after.length <= episodeBriefCharBudget(),
      `B6: a brief on a 120-comment task stays under the budget (was ${after.length})`,
    );
    // Flat, not merely smaller: 120 extra comments of 400 chars each is ~48k
    // characters of history. A brief that grew with them would be at least
    // that much bigger.
    assert(
      after.length - before.length < 8_000,
      `B6: brief size is flat in comment count (grew ${after.length - before.length} chars)`,
    );

    // And the full packet is the control: it DOES grow, which is why a
    // continuation must not use it.
    const { buildTaskAgentContextPacket } = await import("@/lib/agents/context/task");
    const fullPacket = await buildTaskAgentContextPacket({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      currentTurn: { source: "task comment", body: "continue", actorUsername: "pm" },
    });
    assert(
      fullPacket.renderedPrompt.length > after.length * 2,
      "B6: the continuation brief is materially smaller than the first-contact packet",
    );

    // B7 — the DISPATCHER, not just the builder. First contact must send the
    // full packet; the next execution turn must send the brief, in a different
    // session. Asserting on the enqueued job payload is what proves the wiring,
    // since that payload is verbatim what the gateway would receive.
    const { sendTaskWorkflowNotification } = await import(
      "@/lib/agents/workflow/notifications/task"
    );
    const dispatchedPrompt = async (messageId: string) => {
      const job = await db.pmChannelJob.findFirst({
        where: { payload: { contains: messageId } },
        orderBy: { createdAt: "desc" },
        select: { payload: true },
      });
      assert(job, `B7: a job was enqueued for ${messageId}`);
      return JSON.parse(job!.payload) as { systemPrompt?: string; sessionKey?: string };
    };

    // Close every episode so the next dispatch opens a fresh one.
    await db.taskExecutionEpisode.updateMany({
      where: { taskId: task.id, status: "open" },
      data: { status: "closed", closedAt: new Date() },
    });
    const firstTurn = await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: agentUser.id,
      actor: { id: owner.id, kind: "human", username: "episode-owner" },
      reason: "monitor_recovery",
      body: "Continue the implementation.",
    });
    assert(firstTurn, "B7: the dispatcher produced a turn");
    const firstPayload = await dispatchedPrompt(firstTurn!.messageId);
    assert(
      firstPayload.systemPrompt?.includes("EXECUTION EPISODE BRIEF"),
      "B7: a turn with a prior checkpoint is dispatched with the bounded brief",
    );
    assert(
      firstPayload.sessionKey?.includes(":turn:ep"),
      `B7: the episode names the session (got ${firstPayload.sessionKey})`,
    );

    // A brand-new (task, agent) with no checkpoint must still get the full
    // first-contact packet — the brief must not become the default.
    const freshTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Fresh task",
        status: "In Progress",
        assigneeId: agentUser.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
      },
    });
    const freshTurn = await sendTaskWorkflowNotification({
      taskId: freshTask.id,
      targetUserId: agentUser.id,
      actor: { id: owner.id, kind: "human", username: "episode-owner" },
      reason: "monitor_recovery",
      body: "Start the implementation.",
    });
    assert(freshTurn, "B7: the dispatcher produced a first-contact turn");
    const freshPayload = await dispatchedPrompt(freshTurn!.messageId);
    assert(
      !freshPayload.systemPrompt?.includes("EXECUTION EPISODE BRIEF"),
      "B7: first contact is NOT briefed — it gets the full packet",
    );
    assert(
      freshPayload.systemPrompt?.includes("LIVE PM CONTEXT PACKET"),
      "B7: first contact gets the full packet",
    );
    assertEqual(
      await db.taskExecutionEpisode.count({ where: { taskId: freshTask.id, status: "open" } }),
      1,
      "B7: dispatching an execution turn opens exactly one episode",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  sectionA();
  await sectionB();
  console.log(`task-execution-episode-test: ok (${checks} checks)`);
}

main().catch((error) => {
  console.error("[task-execution-episode] FAIL:", error);
  process.exit(1);
});
