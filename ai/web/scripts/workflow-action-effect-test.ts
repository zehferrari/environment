// ENV-118 — workflow action effects and the continuation outbox.
//
// Section A is pure classification: every action the workflow routes accept
// must map to exactly one effect, the continuation set must agree with
// ENV-116's WORKFLOW_ACTION_CLASS, and every implied disposition must come
// from the closed enum.
//
// Section B exercises the runtime against real rows on a throwaway sqlite:
//   B1 a continuation-required action leaves the run and its job unsettled
//   B2 the outbox write is atomic with the caller's transaction
//   B3 repeating an action inside one episode is idempotent
//   B4 an ended turn with an armed continuation settles as `continue`, not
//      as a successful completion, and queues the continuation
//   B5 the drain turns a queued continuation into a fresh execution turn
//   B6 an episode-terminal action settles the run and supersedes the outbox
//   B7 a wait action records waiting_external
//   B8 failure injection at the REAL route boundary: a crash between the task
//      mutation and the outbox arm commits neither
//   B9 the standalone recorder refuses continuation-required actions, so the
//      split path cannot be reopened by copy-paste
//
// Never touches the live pm.db: DATABASE_URL is repointed at a temp file
// before any lib import, per the scripts/pm-acceptance-baseline-test.ts
// convention.

// MUST precede every other import: B8 drives the real route handler, and Next
// captures `globalThis.AsyncLocalStorage` at module-eval time.
import "./lib/next-als-polyfill";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  WORKFLOW_ACTION_EFFECT,
  workflowActionCheckpoint,
  workflowActionDisposition,
  workflowActionEffect,
  workflowActionNextAction,
  workflowActionResult,
} from "@/lib/agents/workflow/action-effect";
import {
  WORKFLOW_ACTION_CLASS,
  WORKFLOW_DISPOSITIONS,
  isWorkflowDisposition,
} from "@/lib/workflow-invariants";

const execFileP = promisify(execFile);

let checks = 0;

function fail(msg: string): never {
  console.error(`[workflow-action-effect] FAIL: ${msg}`);
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

// The routes' own action lists, restated here so a new action added to a route
// without an effect classification fails this suite rather than silently
// defaulting.
const TASK_ROUTE_ACTIONS = [
  "start",
  "checkpoint",
  "publish_checkpoint",
  "ready_for_review",
  "submit_review",
  "review_feedback",
  "review_done",
  "triage_to_todo",
  "approve_plan",
  "assign_after_plan_approval",
  "add_subtask",
  "complete_subtask",
  "remove_subtask",
  "request_subtask",
  "request_task",
  "flag_blocker",
  "clear_blocker",
  "flag_extra_work_blocker",
] as const;

const EPIC_ROUTE_ACTIONS = [
  "advance_queue",
  "assign_next",
  "create_tasks",
  "deploy_review_approve",
  "deploy_review_reject",
] as const;

function sectionA(): void {
  // Completeness: no action reaches the recorder unclassified.
  for (const action of [...TASK_ROUTE_ACTIONS, ...EPIC_ROUTE_ACTIONS]) {
    assert(
      workflowActionEffect(action) !== null,
      `route action "${action}" has an effect classification`,
    );
  }
  for (const action of Object.keys(WORKFLOW_ACTION_CLASS)) {
    assert(
      workflowActionEffect(action) !== null,
      `WORKFLOW_ACTION_CLASS action "${action}" has an effect classification`,
    );
  }

  // The effect table must not invent continuations ENV-116 did not classify,
  // and must not drop any it did.
  for (const [action, effect] of Object.entries(WORKFLOW_ACTION_EFFECT)) {
    const actionClass = WORKFLOW_ACTION_CLASS[action];
    if (effect === "continue") {
      assertEqual(
        actionClass,
        "continuation-required",
        `"${action}" is a continue effect only because ENV-116 classified it continuation-required`,
      );
    } else if (actionClass) {
      assertEqual(
        actionClass,
        "episode-terminal",
        `"${action}" ends the episode, so ENV-116 must classify it episode-terminal`,
      );
    }
  }
  for (const [action, actionClass] of Object.entries(WORKFLOW_ACTION_CLASS)) {
    if (actionClass !== "continuation-required") continue;
    assertEqual(
      workflowActionEffect(action),
      "continue",
      `continuation-required action "${action}" must have the continue effect`,
    );
  }

  // Every implied disposition is inside the closed enum.
  for (const action of Object.keys(WORKFLOW_ACTION_EFFECT)) {
    const disposition = workflowActionDisposition(action);
    assert(
      isWorkflowDisposition(disposition),
      `"${action}" implies a disposition inside the closed enum (got "${disposition}")`,
    );
  }
  assert(
    WORKFLOW_DISPOSITIONS.includes("continue"),
    "the closed disposition enum carries the continue case this task depends on",
  );

  // The specific mappings the task description names.
  assertEqual(workflowActionEffect("start"), "continue", "start → continue");
  assertEqual(workflowActionEffect("add_subtask"), "continue", "add_subtask → continue");
  assertEqual(workflowActionEffect("complete_subtask"), "continue", "complete_subtask → continue");
  assertEqual(workflowActionEffect("clear_blocker"), "continue", "clear_blocker → continue");
  assertEqual(workflowActionEffect("flag_blocker"), "wait", "flag_blocker → wait");
  assertEqual(
    workflowActionEffect("flag_extra_work_blocker"),
    "wait",
    "flag_extra_work_blocker → wait",
  );
  assertEqual(workflowActionEffect("request_task"), "wait", "request_task → wait");
  assertEqual(workflowActionEffect("ready_for_review"), "finish", "ready_for_review → finish");
  assertEqual(workflowActionEffect("review_done"), "finish", "review_done → finish");
  assertEqual(workflowActionEffect("unknown_action"), null, "an unknown action classifies as null");

  assertEqual(
    workflowActionDisposition("start"),
    "continue",
    "start's disposition is continue, not completed",
  );
  assertEqual(
    workflowActionDisposition("flag_blocker"),
    "waiting_external",
    "flag_blocker's disposition is waiting_external",
  );
  assertEqual(
    workflowActionDisposition("ready_for_review"),
    "ready_for_review",
    "ready_for_review's disposition is its own case, not `completed`",
  );
  assertEqual(workflowActionDisposition("review_done"), "completed", "review_done completes");

  assertEqual(workflowActionCheckpoint("start"), "task_started", "start's checkpoint");
  assertEqual(
    workflowActionNextAction("start"),
    "ready_for_review",
    "a mid-episode action points at the terminal action, not a single next step",
  );
  assertEqual(workflowActionNextAction("flag_blocker"), "clear_blocker", "a blocker waits to be cleared");
  assertEqual(workflowActionNextAction("review_done"), "none", "a finished episode has no next action");

  const started = workflowActionResult({ action: "start", taskState: "In Progress" });
  assertEqual(started.actionEffect, "continue", "result carries the effect");
  assertEqual(started.taskState, "In Progress", "result carries the task state");
  assertEqual(started.turnComplete, false, "a continue action does not complete the turn");
  const submitted = workflowActionResult({ action: "ready_for_review", taskState: "In Progress" });
  assertEqual(submitted.turnComplete, true, "an episode-terminal action completes the turn");
  assertEqual(
    workflowActionResult({ action: "start" }).taskState,
    null,
    "an omitted task state is null, never invented",
  );
}

async function dbPush(dbUrl: string): Promise<void> {
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
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

const AGENT_SLUG = "effectbot";

async function sectionB(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "workflow-action-effect-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.PM_ASYNC_DISPATCH = "1";
  // Keep the test hermetic: the enqueue path must not nudge a worker that
  // would try to reach a real gateway.
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "workflow-action-effect-test-secret";

  try {
    await dbPush(dbUrl);

    const { db } = await import("@/lib/db");
    const {
      recordPmChannelRunEvent,
      recordPmChannelRunQueued,
      recordPmChannelRunWorkflowAction,
    } = await import("@/lib/agents/pm-channel/runs");
    const { armPmChannelContinuations } = await import("@/lib/agents/pm-channel/continuations");
    const { drainPmChannelContinuations } = await import(
      "@/lib/agents/pm-channel/continuation-drain"
    );
    const { runWorkflowActionAtomically } = await import(
      "@/lib/agents/workflow/transactional-action"
    );

    // Production runs every continuation-required action through the atomic
    // primitive, and `recordPmChannelRunWorkflowAction` now refuses them
    // outright (see B9). Mirror that here: these cases are about the run/outbox
    // half, so the domain mutation is an intentional no-op.
    const recordAction = async (args: {
      taskId: string;
      agentSlug: string;
      messageId: string;
      action: string;
    }) => (await runWorkflowActionAtomically(args, async () => {})).result;

    const agent = await db.agent.create({
      data: { slug: AGENT_SLUG, name: "Effect Bot", role: "coding" },
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
        username: "effect-owner",
        email: "effect-owner@example.invalid",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const project = await db.project.create({ data: { slug: "effects", name: "Effects" } });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Effect task",
        status: "In Progress",
        assigneeId: agentUser.id,
        reporterId: owner.id,
        approvedOn: new Date(),
      },
    });

    const seedRun = async (messageId: string) => {
      await db.agentChatMessage.create({
        data: {
          id: messageId,
          projectId: project.id,
          taskId: task.id,
          agentSlug: AGENT_SLUG,
          senderUserId: owner.id,
          body: "PM workflow notification for @effectbot",
          originChannel: "comment",
        },
      });
      const run = await recordPmChannelRunQueued({
        target: { kind: "task-comment", agentSlug: AGENT_SLUG, taskId: task.id, messageId },
        kind: "task-comment",
        projectId: project.id,
      });
      if (!run) fail(`could not seed a run for ${messageId}`);
      await db.pmChannelJob.create({
        data: {
          runId: run.id,
          agentSlug: AGENT_SLUG,
          kind: "task-comment",
          payload: JSON.stringify({ turnClass: "notification" }),
          status: "queued",
        },
      });
      return run;
    };

    const runRow = (id: string) =>
      db.pmChannelRun.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          completedAt: true,
          disposition: true,
          settledByAction: true,
          lastAction: true,
          lastActionAt: true,
          jobs: { select: { status: true } },
        },
      });

    // ---- B1: a continuation-required action settles nothing ----
    const b1 = await seedRun("effect-b1");
    const started = await recordAction({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      messageId: "effect-b1",
      action: "start",
    });
    assertEqual(started.actionEffect, "continue", "start returns the continue effect");
    let b1Row = await runRow(b1.id);
    assertEqual(b1Row.status, "queued", "start leaves the run active");
    assertEqual(b1Row.completedAt, null, "start records no completedAt");
    assertEqual(b1Row.disposition, "continue", "start records the continue disposition");
    assertEqual(b1Row.settledByAction, null, "start is not a settling action");
    assertEqual(b1Row.lastAction, "start", "the run remembers the last action taken");
    assert(b1Row.lastActionAt != null, "the run stamps when the action happened");
    assertEqual(b1Row.jobs[0]?.status, "queued", "start leaves the PM job unsettled");
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: b1.id, status: "armed" } }),
      1,
      "start armed a continuation",
    );

    // ---- B2: the outbox write joins the caller's transaction ----
    // A crash between "start task" and "queue next turn" must not be able to
    // commit one without the other.
    const b2 = await seedRun("effect-b2");
    let threw = false;
    try {
      await db.$transaction(async (tx) => {
        await armPmChannelContinuations(tx, {
          runs: [{ id: b2.id, projectId: project.id, taskId: task.id, epicId: null }],
          agentSlug: AGENT_SLUG,
          messageId: "effect-b2",
          action: "start",
          now: new Date(),
        });
        throw new Error("simulated crash mid-transaction");
      });
    } catch {
      threw = true;
    }
    assert(threw, "the simulated crash aborted the transaction");
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: b2.id } }),
      0,
      "an aborted transaction leaves no continuation behind",
    );
    // Retire this scratch run: a second live run in the same lane would (
    // correctly) make the drain below stand down instead of dispatching.
    await db.pmChannelRun.update({
      where: { id: b2.id },
      data: { status: "completed", completedAt: new Date(), disposition: "completed" },
    });
    // Seeding b2 also superseded b1 — queueing a run retires the older run in
    // the same (task, agent) lane (ENV-117). That is correct, but it is not
    // what B3/B4 are about: they need b1 to still be the live run of its
    // episode, exactly as it is in production when an agent calls start and
    // then falls silent. Put it back where recordPmChannelRunQueued left it.
    await db.pmChannelRun.update({
      where: { id: b1.id },
      data: { status: "queued" },
    });

    // ---- B3: repeating an action inside one episode is idempotent ----
    await recordAction({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      messageId: "effect-b1",
      action: "start",
    });
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: b1.id } }),
      1,
      "repeating an action renews its continuation rather than adding another",
    );
    await recordAction({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      messageId: "effect-b1",
      action: "add_subtask",
    });
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: b1.id, status: "armed" } }),
      2,
      "a different continuation action arms its own row",
    );

    // ---- B4: the turn ends with a continuation still armed ----
    // This is the bug the task names: the agent called start and then returned
    // nothing. The run must settle as `continue`, never as a success, and the
    // continuation must become drainable.
    await recordPmChannelRunEvent({
      target: { kind: "task-comment", agentSlug: AGENT_SLUG, taskId: task.id, messageId: "effect-b1" },
      event: "final",
    });
    b1Row = await runRow(b1.id);
    assertEqual(
      b1Row.disposition,
      "continue",
      "an ended turn with work outstanding is `continue`, not a successful completion",
    );
    assertEqual(
      b1Row.settledByAction,
      null,
      "the turn ended on a stream event, so no workflow action settled it",
    );
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: b1.id, status: "queued" } }),
      2,
      "both armed continuations became drainable when the turn ended",
    );

    // ---- B5: the drain schedules a fresh execution turn ----
    const messagesBefore = await db.agentChatMessage.count();
    const drained = await drainPmChannelContinuations();
    assertEqual(drained.dispatched, 1, "the drain dispatched exactly one continuation turn");
    assertEqual(
      drained.superseded,
      1,
      "the second continuation is superseded: the first one's run is now the active turn",
    );
    assert(
      (await db.agentChatMessage.count()) > messagesBefore,
      "the drain enqueued a real workflow turn for the agent",
    );
    const dispatchedRow = await db.pmChannelContinuation.findFirstOrThrow({
      where: { runId: b1.id, status: "dispatched" },
      select: { dispatchedMessageId: true, dispatchedAt: true, attempts: true },
    });
    assert(dispatchedRow.dispatchedMessageId, "the dispatched continuation records its turn");
    assert(dispatchedRow.dispatchedAt != null, "the dispatched continuation is stamped");
    assertEqual(dispatchedRow.attempts, 1, "the drain counts its attempt");
    assertEqual(
      await db.activityLog.count({ where: { kind: "task.workflow.continuation" } }),
      1,
      "the continuation is visible in the task activity log",
    );
    assertEqual(
      (await drainPmChannelContinuations()).dispatched,
      0,
      "a drained outbox does not re-dispatch",
    );

    // ---- B6: an episode-terminal action settles and supersedes ----
    const b6 = await seedRun("effect-b6");
    await recordAction({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      messageId: "effect-b6",
      action: "start",
    });
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: b6.id, status: "armed" } }),
      1,
      "the episode armed a continuation",
    );
    const submitted = await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      messageId: "effect-b6",
      action: "ready_for_review",
    });
    assertEqual(submitted.actionEffect, "finish", "ready_for_review finishes the episode");
    const b6Row = await runRow(b6.id);
    assertEqual(b6Row.status, "completed", "an episode-terminal action settles the run");
    assertEqual(b6Row.disposition, "ready_for_review", "the settle records its disposition");
    assertEqual(b6Row.settledByAction, "ready_for_review", "the settle names its action");
    assertEqual(b6Row.jobs[0]?.status, "complete", "an episode-terminal action settles the job");
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: b6.id, status: "superseded" } }),
      1,
      "finishing the episode supersedes the armed continuation",
    );
    assertEqual(
      (await drainPmChannelContinuations()).dispatched,
      0,
      "a superseded continuation is never dispatched",
    );

    // ---- B7: a wait action records waiting_external ----
    const b7 = await seedRun("effect-b7");
    const blocked = await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: AGENT_SLUG,
      messageId: "effect-b7",
      action: "flag_blocker",
    });
    assertEqual(blocked.actionEffect, "wait", "flag_blocker waits on an external actor");
    const b7Row = await runRow(b7.id);
    assertEqual(b7Row.status, "completed", "a wait action still ends the agent's turn");
    assertEqual(b7Row.disposition, "waiting_external", "a wait action records waiting_external");
    assertEqual(b7Row.settledByAction, "flag_blocker", "the settle names the blocking action");

    // ---- B8: failure injection around the REAL workflow action path ----
    //
    // B2 only proves `armPmChannelContinuations` rolls back inside a synthetic
    // transaction. The review's finding was about the boundary one level up:
    // the route committed `moveTaskStatus` and only THEN opened a separate
    // transaction for the run/outbox bookkeeping, so a crash in between left an
    // In Progress task with no continuation.
    //
    // So this case drives POST /api/agent/tasks/<id>/workflow itself, with the
    // crash injected at exactly that point, and asserts the task mutation could
    // not commit alone. Then it repeats the identical call without the crash
    // and asserts both halves landed — otherwise a route that silently did
    // nothing would also "pass".
    const { runRouteHandler } = await import("./lib/next-route-harness");
    const { NextRequest } = await import("next/server");
    const { POST: taskWorkflowPost } = await import(
      "@/app/api/agent/tasks/[taskId]/workflow/route"
    );
    const { createTaskWorkflowToken } = await import("@/lib/agents/workflow/token/task");
    const { __setWorkflowActionCrashHook } = await import(
      "@/lib/agents/workflow/transactional-action"
    );

    // Its own project: the fixture task above is already In Progress for this
    // agent, and the route's per-project WIP gate would reject the start with
    // a 409 before it ever reached the transaction under test.
    const startProject = await db.project.create({
      data: { slug: "effects-start", name: "Effects Start" },
    });
    const startTask = await db.task.create({
      data: {
        projectId: startProject.id,
        title: "Atomic start task",
        status: "To Do",
        assigneeId: agentUser.id,
        reporterId: owner.id,
        approvedOn: new Date(),
      },
    });
    const callStart = async (messageId: string) => {
      await db.agentChatMessage.create({
        data: {
          id: messageId,
          projectId: startProject.id,
          taskId: startTask.id,
          agentSlug: AGENT_SLUG,
          senderUserId: owner.id,
          body: "PM workflow notification for @effectbot",
          originChannel: "comment",
        },
      });
      const run = await recordPmChannelRunQueued({
        target: {
          kind: "task-comment",
          agentSlug: AGENT_SLUG,
          taskId: startTask.id,
          messageId,
        },
        kind: "task-comment",
        projectId: startProject.id,
      });
      if (!run) fail(`could not seed a run for ${messageId}`);
      const req = new NextRequest(
        `http://127.0.0.1/api/agent/tasks/${startTask.id}/workflow`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId,
            token: createTaskWorkflowToken(messageId, startTask.id, AGENT_SLUG),
            action: "start",
          }),
        },
      );
      const res = await runRouteHandler(() =>
        taskWorkflowPost(req, { params: Promise.resolve({ taskId: startTask.id }) }),
      );
      return { runId: run.id, status: res.status };
    };

    __setWorkflowActionCrashHook(() => {
      throw new Error("simulated crash between the task mutation and the outbox arm");
    });
    let crashedStatus = 0;
    try {
      crashedStatus = (await callStart("effect-b8-crash")).status;
    } catch {
      // A throw that escapes the route is equally acceptable evidence: what
      // matters is that nothing committed.
      crashedStatus = 500;
    } finally {
      __setWorkflowActionCrashHook(null);
    }
    assert(crashedStatus >= 500, "the injected crash failed the action rather than reporting success");
    assertEqual(
      (await db.task.findUniqueOrThrow({ where: { id: startTask.id }, select: { status: true } })).status,
      "To Do",
      "the task mutation could not commit without the continuation (the review's loss window)",
    );
    assertEqual(
      await db.activityLog.count({ where: { taskId: startTask.id, kind: "task.move" } }),
      0,
      "the crashed action left no task.move audit row behind",
    );
    assertEqual(
      await db.pmChannelContinuation.count({ where: { taskId: startTask.id } }),
      0,
      "the crashed action armed no continuation",
    );

    // Same call, no crash: both halves must land together.
    const clean = await callStart("effect-b8-ok");
    assertEqual(clean.status, 200, "the uninjected start succeeds");
    assertEqual(
      (await db.task.findUniqueOrThrow({ where: { id: startTask.id }, select: { status: true } })).status,
      "In Progress",
      "a successful start commits the task mutation",
    );
    assertEqual(
      await db.pmChannelContinuation.count({
        where: { runId: clean.runId, status: "armed" },
      }),
      1,
      "a successful start commits the continuation in the same transaction",
    );
    assertEqual(
      (await runRow(clean.runId)).status,
      "queued",
      "a successful start still leaves the run unsettled",
    );

    // ---- B9: the split path is closed, not just unused ----
    // A future action must not be able to reopen the loss window by copying an
    // episode-terminal call site.
    let guardThrew = false;
    try {
      await recordPmChannelRunWorkflowAction({
        taskId: startTask.id,
        agentSlug: AGENT_SLUG,
        messageId: "effect-b8-ok",
        action: "start",
      });
    } catch {
      guardThrew = true;
    }
    assert(
      guardThrew,
      "the standalone recorder refuses a continuation-required action that may own a domain mutation",
    );
    // The escape hatch stays available for call sites that genuinely write
    // nothing (the already-cleared clear_blocker branch).
    const noop = await recordPmChannelRunWorkflowAction({
      taskId: startTask.id,
      agentSlug: AGENT_SLUG,
      messageId: "effect-b8-ok",
      action: "clear_blocker",
      withoutDomainMutation: true,
    });
    assertEqual(noop.actionEffect, "continue", "the declared no-op still records a continue effect");

    console.log(`[workflow-action-effect] OK — ${checks} assertions passed`);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

sectionA();
sectionB().catch((error: unknown) => {
  console.error("[workflow-action-effect] unexpected failure:", error);
  process.exit(1);
});
