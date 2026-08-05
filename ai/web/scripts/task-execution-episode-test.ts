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
//   B7 the DISPATCHER wiring: brief for continuations, full packet on first
//      contact, one episode per execution turn
//   B8 the rollover BARRIER, driven through the real route: an exhausted
//      message mutates nothing and counts nothing against its successor, and
//      gets exactly one final checkpoint
//   B9 the successor is dispatched in a DIFFERENT session and briefed from
//      that checkpoint rather than told to resume a transcript it never saw
//   B10 the DISPATCH GATE: a `tool:call` that exhausts the tool budget
//      schedules nothing — episode N+1 cannot be dispatched until N's
//      checkpoint is durable, and it is the checkpoint that releases it
//   B10b a fenced turn that ends without checkpointing (it has no way of
//      knowing it was fenced) gets PM's deterministic derived checkpoint, so
//      gating the dispatch cannot turn a rollover into a permanent stall
//   B11 the barrier is single-use UNDER CONCURRENCY: two simultaneous
//      checkpoint submissions, exactly one accepted, no overwrite, one turn
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
/** Small enough that two stream events exhaust it, which keeps B10 readable. */
const TOOL_BUDGET = 2;

async function sectionB(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "task-execution-episode-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "task-execution-episode-test-secret";
  // A small, explicit budget keeps the rollover assertions readable.
  process.env.PM_EPISODE_MAX_CYCLES = "3";
  process.env.PM_EPISODE_MAX_TOOL_CYCLES = String(TOOL_BUDGET);

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

    // ------------------------------------------------------------------
    // B8/B9 — the rollover BARRIER (ENV-121 review).
    //
    // Opening episode N+1 is not a boundary on its own. The turn that spent
    // the budget was still live and every action it kept making was accepted
    // and counted against the successor, so one stable conversation could span
    // arbitrarily many nominal episodes. These cases drive the real route and
    // prove the exhausted message cannot mutate or bank work into its
    // successor, and that the successor is dispatched in a DIFFERENT session.
    // ------------------------------------------------------------------
    const { runRouteHandler } = await import("./lib/next-route-harness");
    const { NextRequest } = await import("next/server");
    const { POST: taskWorkflowPost } = await import(
      "@/app/api/agent/tasks/[taskId]/workflow/route"
    );
    const { createTaskWorkflowToken } = await import("@/lib/agents/workflow/token/task");

    const barrierProject = await db.project.create({
      data: { slug: "episodes-barrier", name: "Episodes Barrier" },
    });
    const barrierTask = await db.task.create({
      data: {
        projectId: barrierProject.id,
        title: "Barrier task",
        status: "In Progress",
        assigneeId: agentUser.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        description: "Fence the exhausted turn.",
      },
    });

    // The first dispatch opens episode 1 and records the session that carries
    // it. That message id is the turn we are going to exhaust.
    const barrierTurn = await sendTaskWorkflowNotification({
      taskId: barrierTask.id,
      targetUserId: agentUser.id,
      actor: { id: owner.id, kind: "human", username: "episode-owner" },
      reason: "monitor_recovery",
      body: "Continue the implementation.",
    });
    assert(barrierTurn, "B8: the dispatcher produced the first barrier turn");
    const exhaustedMessageId = barrierTurn!.messageId;
    const episodeOneSessionKey = (
      await db.taskExecutionEpisode.findFirstOrThrow({
        where: { taskId: barrierTask.id, agentSlug: AGENT_SLUG, episodeNo: 1 },
        select: { sessionKey: true },
      })
    ).sessionKey;
    assert(episodeOneSessionKey, "B8: episode 1 records the session that carried it");

    const callWorkflow = async (action: string, extra: Record<string, unknown> = {}) => {
      const req = new NextRequest(
        `http://127.0.0.1/api/agent/tasks/${barrierTask.id}/workflow`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId: exhaustedMessageId,
            token: createTaskWorkflowToken(exhaustedMessageId, barrierTask.id, AGENT_SLUG),
            action,
            ...extra,
          }),
        },
      );
      const res = await runRouteHandler(() =>
        taskWorkflowPost(req, { params: Promise.resolve({ taskId: barrierTask.id }) }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // Spend the budget (PM_EPISODE_MAX_CYCLES = 3) from ONE message.
    for (let i = 1; i <= 2; i += 1) {
      const step = await callWorkflow("add_subtask", { subtaskText: `barrier step ${i}` });
      assertEqual(step.status, 200, `B8: cycle ${i} is accepted`);
    }
    const exhaustingCall = await callWorkflow("add_subtask", { subtaskText: "barrier step 3" });
    assertEqual(exhaustingCall.status, 200, "B8: the exhausting action itself still succeeds");
    assertEqual(
      exhaustingCall.body.episodeBudgetExhausted,
      true,
      "B8: the response tells the agent its episode is spent",
    );
    const subtasksAtBarrier = await db.subTask.count({ where: { taskId: barrierTask.id } });
    assertEqual(subtasksAtBarrier, 3, "B8: three cycles produced three subtasks");
    assertEqual(
      (
        await db.taskExecutionEpisode.findFirstOrThrow({
          where: { taskId: barrierTask.id, episodeNo: 1 },
          select: { exhaustedByMessageId: true },
        })
      ).exhaustedByMessageId,
      exhaustedMessageId,
      "B8: the closed episode records WHICH message spent it — that is the fence",
    );

    // THE REVIEW FINDING. The same message keeps going. Every progress action
    // must now be rejected, mutate nothing, and count nothing.
    const afterBarrier = await callWorkflow("add_subtask", { subtaskText: "smuggled step 4" });
    assertEqual(afterBarrier.status, 409, "B8: a progress action from the exhausted turn is rejected");
    assertEqual(
      await db.subTask.count({ where: { taskId: barrierTask.id } }),
      subtasksAtBarrier,
      "B8: the rejected action mutated nothing",
    );
    const successorAfterReject = await db.taskExecutionEpisode.findFirstOrThrow({
      where: { taskId: barrierTask.id, episodeNo: 2 },
      select: { cycleCount: true, sessionKey: true, messageId: true },
    });
    assertEqual(
      successorAfterReject.cycleCount,
      0,
      "B8: the exhausted message cannot count work against its successor",
    );
    assertEqual(
      successorAfterReject.sessionKey,
      null,
      "B8: the successor is not yet bound to any session — it has not been dispatched",
    );

    // A terminal action is progress too: an exhausted turn does not get to
    // hand the task to a reviewer. The successor episode reports that.
    const terminalAfterBarrier = await callWorkflow("ready_for_review", { repoTouched: false });
    assertEqual(terminalAfterBarrier.status, 409, "B8: even a terminal action is fenced");
    assertEqual(
      (
        await db.task.findUniqueOrThrow({
          where: { id: barrierTask.id },
          select: { status: true },
        })
      ).status,
      "In Progress",
      "B8: the fenced terminal action did not move the task",
    );

    // The ONE act still permitted: the final structured checkpoint. It lands
    // on the CLOSED episode, not the successor.
    const finalCheckpoint = await callWorkflow("checkpoint", {
      nextAction: "resume the migration in the next episode",
      openChecklist: ["finish the migration"],
    });
    assertEqual(finalCheckpoint.status, 200, "B8: the final checkpoint is accepted");
    assertEqual(finalCheckpoint.body.episodeNo, 1, "B8: it lands on the episode that was exhausted");
    assertEqual(
      finalCheckpoint.body.episodeClosed,
      true,
      "B8: the response says the episode is closed rather than asking for another checkpoint",
    );
    const closedEpisodeOne = await db.taskExecutionEpisode.findFirstOrThrow({
      where: { taskId: barrierTask.id, episodeNo: 1 },
      select: { nextAction: true, barrierReleasedAt: true },
    });
    assertEqual(
      closedEpisodeOne.nextAction,
      "resume the migration in the next episode",
      "B8: the fenced turn's own words are what the successor will be briefed from",
    );
    assert(closedEpisodeOne.barrierReleasedAt, "B8: writing the final checkpoint consumes the barrier");
    assertEqual(
      (
        await db.taskExecutionEpisode.findFirstOrThrow({
          where: { taskId: barrierTask.id, episodeNo: 2 },
          select: { cycleCount: true },
        })
      ).cycleCount,
      0,
      "B8: the final checkpoint spends nothing from the successor either",
    );

    // "Only the FINAL checkpoint": a second one is rejected too.
    const secondCheckpoint = await callWorkflow("checkpoint", { nextAction: "and again" });
    assertEqual(secondCheckpoint.status, 409, "B8: the barrier is single-use");

    // B9 — the successor runs in a DIFFERENT session, briefed rather than
    // resumed. Resuming would point a brand-new model session at a transcript
    // it has never seen.
    const successorTurn = await sendTaskWorkflowNotification({
      taskId: barrierTask.id,
      targetUserId: agentUser.id,
      actor: { id: owner.id, kind: "human", username: "episode-owner" },
      reason: "monitor_recovery",
      body: "Continue the implementation.",
    });
    assert(successorTurn, "B9: the successor episode was dispatched");
    const successorPayload = await dispatchedPrompt(successorTurn!.messageId);
    const successorEpisode = await db.taskExecutionEpisode.findFirstOrThrow({
      where: { taskId: barrierTask.id, episodeNo: 2 },
      select: { sessionKey: true },
    });
    assertEqual(
      successorPayload.sessionKey,
      successorEpisode.sessionKey,
      "B9: the dispatched session is the one recorded on the successor episode",
    );
    assert(
      successorPayload.sessionKey && successorPayload.sessionKey !== episodeOneSessionKey,
      `B9: the successor session key differs from the exhausted episode's (${successorPayload.sessionKey} vs ${episodeOneSessionKey})`,
    );
    assert(
      !successorPayload.systemPrompt?.includes("Incremental PM follow-up"),
      "B9: a fresh episode session is never told to continue from a baseline it has never seen",
    );
    assert(
      successorPayload.systemPrompt?.includes("EXECUTION EPISODE BRIEF"),
      "B9: the successor is briefed from the checkpoint",
    );
    assert(
      successorPayload.systemPrompt?.includes("resume the migration in the next episode"),
      "B9: the brief carries the fenced turn's final next action",
    );

    // ------------------------------------------------------------------
    // B10 — the DISPATCH GATE (ENV-121 second review).
    //
    // Tool-budget exhaustion used to arm the successor continuation on the
    // spot. That scheduled episode N+1 while N had no checkpoint, and since
    // nothing can interrupt a model mid-turn, the fenced message could simply
    // finish without ever calling `checkpoint` — the successor would then be
    // briefed from nothing. So: a `tool:call` rollover must schedule NOTHING.
    // The successor is released only when N's checkpoint is durable.
    // ------------------------------------------------------------------
    const { applyPmChannelStreamCallback } = await import(
      "@/lib/agents/pm-channel/stream-callback"
    );
    const { pmChannelRunTargetKey } = await import("@/lib/agents/pm-channel/runs");
    const { drainPmChannelContinuations } = await import(
      "@/lib/agents/pm-channel/continuation-drain"
    );

    const gateTask = await db.task.create({
      data: {
        projectId: barrierProject.id,
        title: "Tool budget gate",
        status: "In Progress",
        assigneeId: agentUser.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        description: "Gate the successor on a durable checkpoint.",
      },
    });
    const gateTurn = await sendTaskWorkflowNotification({
      taskId: gateTask.id,
      targetUserId: agentUser.id,
      actor: { id: owner.id, kind: "human", username: "episode-owner" },
      reason: "monitor_recovery",
      body: "Continue the implementation.",
    });
    assert(gateTurn, "B10: the dispatcher produced the turn we are going to exhaust");
    const gateMessageId = gateTurn!.messageId;
    const gateTarget = {
      kind: "task-comment" as const,
      agentSlug: AGENT_SLUG,
      taskId: gateTask.id,
      messageId: gateMessageId,
    };
    // The gateway has accepted the turn and is streaming it: that is the state
    // a real `tool:call` arrives in, and the callback refuses a queued target.
    await db.pmChannelRun.update({
      where: { targetKey: pmChannelRunTargetKey(gateTarget) },
      data: { status: "streaming" },
    });

    const toolCall = () =>
      applyPmChannelStreamCallback({
        payload: {
          target: gateTarget,
          event: "tool:call",
          toolStatus: "call",
          toolName: "Bash",
        },
        rateLimit: false,
      });
    for (let i = 1; i <= TOOL_BUDGET; i += 1) {
      const res = await toolCall();
      assertEqual(res.status, 200, `B10: tool call ${i} is accepted by the stream callback`);
    }

    const gateEpisodeOne = await db.taskExecutionEpisode.findFirstOrThrow({
      where: { taskId: gateTask.id, episodeNo: 1 },
      select: {
        status: true,
        closeReason: true,
        exhaustedByMessageId: true,
        barrierReleasedAt: true,
        toolCycleCount: true,
      },
    });
    assertEqual(gateEpisodeOne.status, "closed", "B10: the tool budget closed episode 1");
    assertEqual(
      gateEpisodeOne.closeReason,
      "tool_cycle_budget_exhausted",
      "B10: it closed for the TOOL budget, not the workflow-action backstop",
    );
    assertEqual(
      gateEpisodeOne.exhaustedByMessageId,
      gateMessageId,
      "B10: the streaming turn is the one that gets fenced",
    );
    assertEqual(
      gateEpisodeOne.barrierReleasedAt,
      null,
      "B10: no checkpoint has been written yet, so the barrier is still raised",
    );

    // THE GATE. Nothing may be scheduled for the successor yet.
    assertEqual(
      await db.pmChannelContinuation.count({ where: { taskId: gateTask.id } }),
      0,
      "B10: a tool-budget rollover schedules NOTHING — N+1 waits for N's checkpoint",
    );
    assertEqual(
      (await drainPmChannelContinuations()).dispatched,
      0,
      "B10: the drain cannot dispatch the successor before the checkpoint is durable",
    );
    assertEqual(
      (
        await db.taskExecutionEpisode.findFirstOrThrow({
          where: { taskId: gateTask.id, episodeNo: 2 },
          select: { sessionKey: true },
        })
      ).sessionKey,
      null,
      "B10: the successor is still bound to no session",
    );

    const gateWorkflow = async (action: string, extra: Record<string, unknown> = {}) => {
      const req = new NextRequest(
        `http://127.0.0.1/api/agent/tasks/${gateTask.id}/workflow`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId: gateMessageId,
            token: createTaskWorkflowToken(gateMessageId, gateTask.id, AGENT_SLUG),
            action,
            ...extra,
          }),
        },
      );
      const res = await runRouteHandler(() =>
        taskWorkflowPost(req, { params: Promise.resolve({ taskId: gateTask.id }) }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // A tool-fenced message is fenced for workflow actions too — the two
    // budgets share one barrier.
    assertEqual(
      (await gateWorkflow("add_subtask", { subtaskText: "smuggled" })).status,
      409,
      "B10: the tool-fenced turn cannot take a workflow action either",
    );

    // Now the checkpoint. THIS is what releases the successor.
    const gateCheckpoint = await gateWorkflow("checkpoint", {
      nextAction: "finish the barrier sweep",
      evidence: ["tool budget spent on Bash"],
    });
    assertEqual(gateCheckpoint.status, 200, "B10: the fenced turn's final checkpoint is accepted");
    assertEqual(
      gateCheckpoint.body.successorScheduled,
      true,
      "B10: the checkpoint — and only the checkpoint — schedules the successor",
    );
    const gateContinuation = await db.pmChannelContinuation.findFirstOrThrow({
      where: { taskId: gateTask.id },
      select: { action: true, status: true, messageId: true },
    });
    assertEqual(
      gateContinuation.action,
      "episode_rollover",
      "B10: the successor is scheduled as an episode rollover, not a recovery",
    );
    assertEqual(
      gateContinuation.messageId,
      gateMessageId,
      "B10: the continuation is keyed to the turn whose checkpoint released it",
    );

    // ------------------------------------------------------------------
    // B10b — the fenced turn ENDS without checkpointing.
    //
    // It has no way of knowing it was fenced, so this is the common case, not
    // the exotic one. Gating the dispatch would turn it into a permanent stall
    // unless PM writes a deterministic checkpoint of its own at turn end.
    // ------------------------------------------------------------------
    const endTask = await db.task.create({
      data: {
        projectId: barrierProject.id,
        title: "Turn ends unfenced",
        status: "In Progress",
        assigneeId: agentUser.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        description: "Seal on turn end.",
      },
    });
    const endTurn = await sendTaskWorkflowNotification({
      taskId: endTask.id,
      targetUserId: agentUser.id,
      actor: { id: owner.id, kind: "human", username: "episode-owner" },
      reason: "monitor_recovery",
      body: "Continue the implementation.",
    });
    assert(endTurn, "B10b: the dispatcher produced a turn");
    const endTarget = {
      kind: "task-comment" as const,
      agentSlug: AGENT_SLUG,
      taskId: endTask.id,
      messageId: endTurn!.messageId,
    };
    await db.pmChannelRun.update({
      where: { targetKey: pmChannelRunTargetKey(endTarget) },
      data: { status: "streaming" },
    });
    for (let i = 1; i <= TOOL_BUDGET; i += 1) {
      await applyPmChannelStreamCallback({
        payload: { target: endTarget, event: "tool:call", toolStatus: "call", toolName: "Read" },
        rateLimit: false,
      });
    }
    assertEqual(
      await db.pmChannelContinuation.count({ where: { taskId: endTask.id } }),
      0,
      "B10b: still nothing scheduled at rollover",
    );

    // The turn simply finishes. No checkpoint was ever called.
    await applyPmChannelStreamCallback({
      payload: { target: endTarget, event: "done" },
      rateLimit: false,
    });
    const endEpisodeOne = await db.taskExecutionEpisode.findFirstOrThrow({
      where: { taskId: endTask.id, episodeNo: 1 },
      select: { barrierReleasedAt: true, nextAction: true, risks: true },
    });
    assert(
      endEpisodeOne.barrierReleasedAt,
      "B10b: ending the turn seals the barrier with PM's derived checkpoint",
    );
    assert(
      endEpisodeOne.nextAction && endEpisodeOne.nextAction.length > 0,
      "B10b: the derived checkpoint always carries a next exact action",
    );
    assert(
      endEpisodeOne.risks?.includes("without an agent-authored checkpoint"),
      "B10b: and says plainly that the agent did not write it",
    );
    const endContinuation = await db.pmChannelContinuation.findFirstOrThrow({
      where: { taskId: endTask.id },
      select: { status: true, action: true },
    });
    assertEqual(
      endContinuation.action,
      "episode_rollover",
      "B10b: the successor is released once the derived checkpoint is durable",
    );
    assert(
      endContinuation.status === "queued" || endContinuation.status === "armed",
      `B10b: the released continuation is drainable (got ${endContinuation.status})`,
    );

    // ------------------------------------------------------------------
    // B11 — the barrier is single-use UNDER CONCURRENCY.
    //
    // The previous round read the barrier state and then updated
    // unconditionally, so two concurrent checkpoint submissions (a retry, a
    // duplicate dispatch) both passed the read and both wrote: the second one
    // silently overwrote the first agent's checkpoint — the exact words the
    // successor episode is briefed from — and scheduled a second turn in the
    // same lane. The consume is now one conditional atomic UPDATE.
    // ------------------------------------------------------------------
    const raceTask = await db.task.create({
      data: {
        projectId: barrierProject.id,
        title: "Checkpoint race",
        status: "In Progress",
        assigneeId: agentUser.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        description: "Two checkpoints, one barrier.",
      },
    });
    const raceTurn = await sendTaskWorkflowNotification({
      taskId: raceTask.id,
      targetUserId: agentUser.id,
      actor: { id: owner.id, kind: "human", username: "episode-owner" },
      reason: "monitor_recovery",
      body: "Continue the implementation.",
    });
    assert(raceTurn, "B11: the dispatcher produced the racing turn");
    const raceMessageId = raceTurn!.messageId;
    const raceWorkflow = async (action: string, extra: Record<string, unknown> = {}) => {
      const req = new NextRequest(
        `http://127.0.0.1/api/agent/tasks/${raceTask.id}/workflow`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId: raceMessageId,
            token: createTaskWorkflowToken(raceMessageId, raceTask.id, AGENT_SLUG),
            action,
            ...extra,
          }),
        },
      );
      const res = await runRouteHandler(() =>
        taskWorkflowPost(req, { params: Promise.resolve({ taskId: raceTask.id }) }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    // Spend the workflow budget (3) so the barrier is raised.
    for (let i = 1; i <= 3; i += 1) {
      await raceWorkflow("add_subtask", { subtaskText: `race step ${i}` });
    }
    assert(
      (
        await db.taskExecutionEpisode.findFirstOrThrow({
          where: { taskId: raceTask.id, episodeNo: 1 },
          select: { exhaustedByMessageId: true },
        })
      ).exhaustedByMessageId === raceMessageId,
      "B11: the barrier is raised against the racing turn",
    );

    // Both submissions are in flight before either has committed.
    const [raceA, raceB] = await Promise.all([
      raceWorkflow("checkpoint", { nextAction: "checkpoint A" }),
      raceWorkflow("checkpoint", { nextAction: "checkpoint B" }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    assertEqual(
      JSON.stringify(raceStatuses),
      JSON.stringify([200, 409]),
      `B11: exactly one concurrent checkpoint succeeds (got ${JSON.stringify(raceStatuses)})`,
    );

    const winnerNextAction = raceA.status === 200 ? "checkpoint A" : "checkpoint B";
    const storedNextAction = (
      await db.taskExecutionEpisode.findFirstOrThrow({
        where: { taskId: raceTask.id, episodeNo: 1 },
        select: { nextAction: true },
      })
    ).nextAction;
    assertEqual(
      storedNextAction,
      winnerNextAction,
      "B11: the stored checkpoint is the winner's and was not overwritten by the loser",
    );
    assertEqual(
      await db.pmChannelContinuation.count({
        where: { taskId: raceTask.id, action: "episode_rollover" },
      }),
      1,
      "B11: the losing checkpoint does not schedule a second turn in the same lane",
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
