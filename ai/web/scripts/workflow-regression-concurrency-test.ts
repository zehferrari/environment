// ENV-124 — Epic regression cases 11 and 12: concurrency.
//
// Both cases are about the same fear: PM is driven by at-least-once delivery.
// The gateway can replay a callback, a crashed worker's turn can be redelivered,
// and the watchdog runs on EVERY worker drain — so two workers can observe the
// same stale task in the same instant. Nothing in that picture is a bug on its
// own; the bug is a second run, a second scheduled turn, a second checklist row
// or a second notification coming out the other side.
//
//   C11 — a duplicate callback (the same messageId, the same payload, delivered
//         twice and concurrently) must converge on ONE run, ONE continuation and
//         ONE episode.
//   C12 — two monitor/watchdog repair passes racing over the same stale task
//         must converge on ONE repair: one recovery continuation, one dispatched
//         turn, one notification, and never two active runs.
//
// What this file deliberately does NOT do is re-implement any of that. Every
// write goes through a production entry point — the real workflow route
// (via the harness poster), recordPmChannelRunQueued, runWorkflowWatchdog,
// settleExpiredRun, drainPmChannelContinuations — because a race that only
// converges through a helper written for the test proves nothing.
//
// On what a `Promise.all` race actually buys. Prisma over sqlite serialises
// writes, so these races are real interleavings of AWAITS but not of statements:
// they exercise "read state, act on it, write" ordering, not torn writes. Where
// production leans on a DURABLE constraint instead of ordering luck — the
// partial unique index on the active run lane, the unique key on the
// continuation outbox, the status-guarded conditional update — this file also
// asserts that constraint DIRECTLY, so removing it fails the suite even on a
// database that happened to serialise the race the friendly way.
//
// `schema: "migrate"` (the harness default) is load-bearing for exactly that
// reason: the partial unique indexes live only in raw-SQL migrations, and a
// pushed schema would silently drop the thing half these assertions are about.
//
// Exit 0 on success, non-zero on the first failed assertion.

import {
  bootScenarioDb,
  createScenarioReporter,
  createScenarioSandbox,
  dispatchWorkflowTurn,
  readRunState,
  readTaskProgress,
  seedTask,
  seedWorld,
  MINUTE_MS,
  type ScenarioCase,
  type ScenarioDb,
} from "./lib/workflow-scenario-harness";

const reporter = createScenarioReporter("workflow-regression-concurrency");

/** Prisma reports a violated unique index as P2002 and names the fields. */
function uniqueViolation(error: unknown): { code: string; message: string } {
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

/** WFI-001 is the Epic's own name for "two active runs in one lane". */
async function activeLaneViolations(projectId: string): Promise<string[]> {
  const { checkWorkflowInvariants } = await import("@/lib/workflow-invariants-db");
  const report = await checkWorkflowInvariants({ projectId });
  return report.byInvariant["WFI-001"].map((violation) => violation.detail);
}

async function main(): Promise<void> {
  const sandbox = await createScenarioSandbox({ name: "wf-concurrency" });
  try {
    const boot = await bootScenarioDb();
    const db: ScenarioDb = boot.db;

    await duplicateCallbacks(boot, db);
    await racingMonitorRecovery(boot, db);

    reporter.ok();
  } finally {
    await sandbox.dispose();
  }
}

// ---------------------------------------------------------------------------
// C11 — duplicate callbacks
// ---------------------------------------------------------------------------

async function duplicateCallbacks(
  boot: Awaited<ReturnType<typeof bootScenarioDb>>,
  db: ScenarioDb,
): Promise<void> {
  const c: ScenarioCase = reporter.case("C11", "duplicate callbacks stay one run, one continuation");

  const world = await seedWorld(db, {
    agentSlug: "racebot",
    projectSlug: "duplicate-callbacks",
    withEpic: true,
  });

  // ---- the action lane: the SAME workflow callback, replayed -------------
  //
  // One grant turn, one messageId, one payload. The first POST is the genuine
  // delivery; the two that follow are the replay, fired concurrently so the
  // route's read-then-write path is interleaved with itself.
  const actionTask = await seedTask(db, world, {
    title: "replayed add_subtask",
    status: "In Progress",
    underEpic: true,
  });
  const turn = await dispatchWorkflowTurn({ boot, world, taskId: actionTask.id });

  const genuine = await turn.post("add_subtask", { subtaskText: "step one" });
  c.assertEqual(genuine.status, 200, "the genuine callback is accepted");
  c.assertEqual(genuine.body.actionEffect, "continue", "add_subtask continues the episode");

  const replays = await Promise.all([
    turn.post("add_subtask", { subtaskText: "step one" }),
    turn.post("add_subtask", { subtaskText: "step one" }),
  ]);
  for (const replay of replays) {
    // A replay is not an error — the grant is still valid and the route has no
    // way to distinguish "the gateway sent it twice" from "the agent meant it
    // twice". Idempotency has to live in the durable state, which is what the
    // rest of this case checks.
    c.assertEqual(replay.status, 200, "a replayed callback is accepted, not 409'd");
  }

  const state = await readRunState(db, { taskId: actionTask.id, agentSlug: world.agentSlug });
  c.assertEqual(state.runs.length, 1, "three deliveries of one turn produced ONE run row");
  c.assertEqual(state.active.length, 1, "and exactly one of them is active");
  c.assertEqual(state.runs[0].messageId, turn.messageId, "the run stayed bound to the grant message");
  c.assertEqual(state.runs[0].status, "queued", "a continue action never settles the run");
  c.assertEqual(state.runs[0].disposition, "continue", "WFI-005: the turn carries an explicit disposition");
  c.assertEqual(state.runs[0].settledByAction, null, "nothing settled the run, so no settling action is recorded");

  c.assertEqual(
    state.continuations.length,
    1,
    "the outbox is keyed on (runId, messageId, action): the replays renewed one row",
  );
  c.assertEqual(state.continuations[0].action, "add_subtask", "and it is the action the agent actually took");
  c.assertEqual(state.open.length, 1, "exactly one continuation owns the next turn (WFI-001's precondition)");

  const progress = await readTaskProgress(db, actionTask.id);
  c.assertEqual(progress.episodes, 1, "the replays folded into one execution episode, not three");

  const checklist = await db.subTask.findMany({
    where: { taskId: actionTask.id },
    select: { text: true },
    orderBy: { rank: "asc" },
  });
  c.assertEqual(
    checklist.length,
    1,
    "three identical callbacks converge on one database-enforced checklist row",
  );
  c.assertEqual(
    checklist.every((item) => item.text === "step one"),
    true,
    "the surviving checklist row carries the requested text",
  );

  // ---- the constraint behind "one continuation" -------------------------
  //
  // The convergence above is not ordering luck: it is the unique key the
  // migration created. Assert it directly, so a regression that dropped the
  // index (or replaced the upsert with a create) still fails here even if the
  // race happened to serialise the friendly way.
  const outbox = state.continuations[0];
  const duplicateRow = await c.rejects(
    () =>
      db.pmChannelContinuation.create({
        data: {
          runId: outbox.runId,
          agentSlug: world.agentSlug,
          projectId: world.projectId,
          taskId: actionTask.id,
          messageId: outbox.messageId,
          action: outbox.action,
          status: "queued",
        },
      }),
    "a second outbox row for the same (runId, messageId, action) is rejected",
  );
  const duplicateOutbox = uniqueViolation(duplicateRow);
  c.assertEqual(duplicateOutbox.code, "P2002", "the rejection is a unique-constraint violation");
  c.assertIncludes(
    duplicateOutbox.message,
    "runId",
    "PmChannelContinuation_runId_messageId_action_key is the constraint that fired",
  );

  // ---- the dispatch lane: the SAME queue callback, delivered twice -------
  //
  // Upstream of the workflow route, the turn-queued callback can itself be
  // redelivered. recordPmChannelRunQueued is the production writer for it, and
  // the property under test is the one ENV-117 built the partial unique index
  // for: a redelivery reuses the lane's row instead of opening a second one.
  const dispatchTask = await seedTask(db, world, {
    title: "replayed turn dispatch",
    status: "In Progress",
    underEpic: true,
  });
  const dispatchTarget = {
    kind: "task-comment" as const,
    agentSlug: world.agentSlug,
    taskId: dispatchTask.id,
    messageId: "msg-redelivered",
  };
  await Promise.all([
    boot.runs.recordPmChannelRunQueued({
      target: dispatchTarget,
      kind: "task-comment",
      projectId: world.projectId,
    }),
    boot.runs.recordPmChannelRunQueued({
      target: dispatchTarget,
      kind: "task-comment",
      projectId: world.projectId,
    }),
  ]);
  const dispatchState = await readRunState(db, {
    taskId: dispatchTask.id,
    agentSlug: world.agentSlug,
  });
  c.assertEqual(dispatchState.runs.length, 1, "a redelivered turn-queued callback produced ONE run row");
  c.assertEqual(dispatchState.active.length, 1, "and one active run, not a forked lane");
  c.assertEqual(dispatchState.runs[0].supersededByRunId, null, "the surviving row is the lane's live run");

  // The whole case restated in the Epic's own vocabulary rather than a second
  // one invented here.
  const lanes = await activeLaneViolations(world.projectId);
  c.assertEqual(lanes.length, 0, `WFI-001 holds after every replay: ${lanes.join("; ")}`);
}

// ---------------------------------------------------------------------------
// C12 — two monitor workers racing over one stale task
// ---------------------------------------------------------------------------

async function racingMonitorRecovery(
  boot: Awaited<ReturnType<typeof bootScenarioDb>>,
  db: ScenarioDb,
): Promise<void> {
  const c: ScenarioCase = reporter.case("C12", "racing monitor recovery converges on one repair");

  const { runWorkflowWatchdog } = await import("@/lib/agents/watchdog/run");
  const { WATCHDOG_CONTINUATION_ACTION, settleExpiredRun, watchdogRecoveryBudget } = await import(
    "@/lib/agents/watchdog/repairs"
  );
  const { drainPmChannelContinuations } = await import(
    "@/lib/agents/pm-channel/continuation-drain"
  );
  const { WATCHDOG_STALL_GRACE_MS } = await import("@/lib/agents/watchdog/detectors");
  const { WORKFLOW_RUN_LEASE_TTL_MS } = await import("@/lib/workflow-invariants");

  // Its own project so `runWorkflowWatchdog({ projectId })` scans exactly the
  // rows this case seeded — the pass-level counters below would otherwise be
  // reading C11's tasks too.
  const world = await seedWorld(db, {
    agentSlug: "monitorbot",
    projectSlug: "monitor-recovery",
    withEpic: true,
  });

  const now = Date.now();
  const stalled = new Date(now - WATCHDOG_STALL_GRACE_MS - 5 * MINUTE_MS);

  // The canonical stall: the agent called `start`, its turn ended, and nothing
  // is running or scheduled any more. Seeded as rows rather than driven, because
  // the point is what TWO watchdogs do when they meet it simultaneously.
  const task = await seedTask(db, world, {
    title: "started and went quiet",
    status: "In Progress",
    underEpic: true,
  });
  const staleRun = await db.pmChannelRun.create({
    data: {
      targetKey: `task-comment:${world.agentSlug}:${task.id}:msg-stalled`,
      kind: "task-comment",
      agentSlug: world.agentSlug,
      messageId: "msg-stalled",
      projectId: world.projectId,
      taskId: task.id,
      sessionKey: "session-race",
      status: "completed",
      createdAt: stalled,
      acceptedAt: stalled, admittedAt: stalled,
      lastEventAt: stalled,
      lastAction: "start",
      lastActionAt: stalled,
    },
  });

  // ---- two passes, same instant ----------------------------------------
  const passes = await Promise.all([
    runWorkflowWatchdog({ projectId: world.projectId }),
    runWorkflowWatchdog({ projectId: world.projectId }),
  ]);
  for (const pass of passes) {
    c.assertEqual(pass.errors.length, 0, `a racing pass reports no errors: ${pass.errors.join("; ")}`);
    c.assertEqual(pass.counts.tasks, 1, "each pass saw the one stalled task");
    c.assert(pass.counts.findings > 0, "each pass independently diagnosed the stall");
  }

  // The repair itself. Two passes, one outbox row: `queueRecoveryContinuation`
  // upserts on (runId, messageId, action), so the loser of the race renews the
  // winner's row instead of queueing a second turn.
  const recoveries = await db.pmChannelContinuation.findMany({ where: { taskId: task.id } });
  c.assertEqual(recoveries.length, 1, "two racing passes queued exactly ONE recovery continuation");
  c.assertEqual(recoveries[0].action, WATCHDOG_CONTINUATION_ACTION, "it is a watchdog recovery row");
  c.assertEqual(recoveries[0].status, "queued", "and it is drainable immediately");
  c.assertEqual(recoveries[0].runId, staleRun.id, "it hangs off the lane's newest run");

  // No double-escalation: the stall was repairable, so neither pass may have
  // called the reporter in.
  const executionState = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: task.id } });
  c.assertEqual(executionState.state, "stalled", "the operator strip names the observed state");
  c.assertEqual(executionState.reasonCode, "no_active_run", "and the highest-priority diagnosis");
  c.assertEqual(executionState.recoveryAction, "new run queued", "and what was done about it");
  c.assertEqual(executionState.escalatedAt, null, "a repaired stall does not escalate");
  c.assertEqual(
    await db.activityLog.count({ where: { taskId: task.id, kind: "task.watchdog.escalated" } }),
    0,
    "and raises no escalation record",
  );
  c.assertEqual(executionState.breakerOpenUntil, null, "one repair does not trip the breaker");

  // The recovery budget is now race-proof: `consumeRecoveryBudget` advances
  // `recoveryCount` via a conditional update guarded by the expected prior
  // count, so two racing passes that read the same pre-value cannot both claim
  // the same unit. The loser's update matches zero rows and it retries against
  // the winner's state. So the count is exactly the number of passes that
  // claimed a unit — not a range that only collapses to one on a serialising
  // engine. The important half — that over-charging cannot manufacture an
  // EXTRA turn — is covered by the outbox assertion above.
  const budget = watchdogRecoveryBudget();
  c.assertEqual(
    executionState.recoveryCount,
    passes.length,
    `two racing passes charged exactly ${passes.length} recovery unit(s) — one per pass that reached the repair (got ${executionState.recoveryCount})`,
  );
  c.assert(
    executionState.recoveryCount <= budget,
    "and the charge stays inside the breaker budget, so a race cannot self-trip the breaker",
  );

  // ---- two drains, same instant ----------------------------------------
  //
  // The outbox row converged; now the thing that turns it into a real turn has
  // to converge too. The drain claims with a status-guarded conditional update
  // (`updateMany where status = 'queued'`), which is the atomic primitive that
  // makes exactly one worker the owner.
  const drains = await Promise.all([
    drainPmChannelContinuations({ limit: 5 }),
    drainPmChannelContinuations({ limit: 5 }),
  ]);
  const dispatched = drains.reduce((total, drain) => total + drain.dispatched, 0);
  c.assertEqual(dispatched, 1, "exactly one of the two racing drains dispatched the recovery turn");
  c.assertEqual(
    drains.reduce((total, drain) => total + drain.failed, 0),
    0,
    "and the loser failed nothing — it simply did not win the claim",
  );

  const drained = await db.pmChannelContinuation.findMany({ where: { taskId: task.id } });
  c.assertEqual(drained.length, 1, "the drain race created no second outbox row");
  c.assertEqual(drained[0].status, "dispatched", "the surviving row records that its turn was enqueued");
  c.assertEqual(drained[0].attempts, 1, "claimed exactly once");
  c.assert(drained[0].dispatchedMessageId !== null, "and names the turn it produced");

  // No duplicate notification: one grant message to the agent, one audit row.
  c.assertEqual(
    await db.agentChatMessage.count({ where: { taskId: task.id } }),
    1,
    "the agent was woken exactly once — no duplicate notification",
  );
  c.assertEqual(
    await db.activityLog.count({ where: { taskId: task.id, kind: "task.workflow.continuation" } }),
    1,
    "and the continuation was audited exactly once",
  );

  // No two active runs: the recovery turn opened one, and the stale run stayed
  // terminal rather than being resurrected alongside it.
  const laneState = await readRunState(db, { taskId: task.id, agentSlug: world.agentSlug });
  c.assertEqual(laneState.runs.length, 2, "the lane holds the old settled run plus the recovery run");
  c.assertEqual(laneState.active.length, 1, "but only ONE of them is active");
  c.assertEqual(
    laneState.runs.find((run) => run.id === staleRun.id)?.status,
    "completed",
    "the stale run was not resurrected",
  );
  c.assertEqual(
    laneState.active[0].messageId,
    drained[0].dispatchedMessageId,
    "and the active run is the one the winning drain enqueued",
  );

  // ---- the constraint behind "no two active runs" -----------------------
  //
  // Same reasoning as C11's outbox key: prove the database itself refuses a
  // second active run in this lane, so a regression that removed the partial
  // unique index cannot hide behind a race that happened to serialise well.
  const forged = await c.rejects(
    () =>
      db.pmChannelRun.create({
        data: {
          targetKey: `task-comment:${world.agentSlug}:${task.id}:msg-forged`,
          kind: "task-comment",
          agentSlug: world.agentSlug,
          messageId: "msg-forged",
          projectId: world.projectId,
          taskId: task.id,
          status: "queued",
        },
      }),
    "a second ACTIVE run in the same (task, agent) lane is rejected",
  );
  const forgedViolation = uniqueViolation(forged);
  c.assertEqual(forgedViolation.code, "P2002", "the rejection is a unique-constraint violation");
  c.assertIncludes(
    forgedViolation.message,
    "agentSlug",
    "PmChannelRun_active_task_agent_unique is the constraint that fired",
  );
  // The index is PARTIAL — terminal rows are exempt, which is what lets a lane
  // keep its history. Asserting that too keeps the previous assertion honest:
  // it must be failing on "active", not on "(taskId, agentSlug)" outright.
  const historical = await db.pmChannelRun.create({
    data: {
      targetKey: `task-comment:${world.agentSlug}:${task.id}:msg-history`,
      kind: "task-comment",
      agentSlug: world.agentSlug,
      messageId: "msg-history",
      projectId: world.projectId,
      taskId: task.id,
      status: "superseded",
    },
  });
  c.assert(historical.id.length > 0, "a terminal run in the same lane is accepted — the index is partial");

  // ---- second repair pass: convergence, not repetition -------------------
  //
  // The fleet is quiescent now (a continuation owns the next turn), so a pass
  // that runs again must observe that and do nothing — the property that stops
  // "repair" from becoming the runaway loop it exists to detect.
  const settled = await runWorkflowWatchdog({ projectId: world.projectId });
  c.assertEqual(settled.errors.length, 0, `the follow-up pass reports no errors: ${settled.errors.join("; ")}`);
  c.assertEqual(
    await db.pmChannelContinuation.count({ where: { taskId: task.id } }),
    1,
    "a pass over an already-recovered task queues no second continuation",
  );
  c.assertEqual(
    await db.agentChatMessage.count({ where: { taskId: task.id } }),
    1,
    "and wakes the agent no second time",
  );

  // ---- the settle race, on the primitive that guards it ------------------
  //
  // The other half of monitor recovery is settling a run whose lease died. Its
  // idempotency is not a unique index but a status-guarded conditional update,
  // so the honest way to test it is to run the production repair twice
  // concurrently against the same run and assert exactly one of them saw rows.
  const leaseDead = new Date(now - WORKFLOW_RUN_LEASE_TTL_MS - 15 * MINUTE_MS);
  const deadTask = await seedTask(db, world, {
    title: "lease died mid-turn",
    status: "In Progress",
    underEpic: true,
  });
  const deadRun = await db.pmChannelRun.create({
    data: {
      targetKey: `task-comment:${world.agentSlug}:${deadTask.id}:msg-dead`,
      kind: "task-comment",
      agentSlug: world.agentSlug,
      messageId: "msg-dead",
      projectId: world.projectId,
      taskId: deadTask.id,
      status: "accepted",
      createdAt: leaseDead,
      acceptedAt: leaseDead, admittedAt: leaseDead,
      lastEventAt: leaseDead,
    },
  });

  const settles = await Promise.all([
    settleExpiredRun({ runId: deadRun.id, now: new Date() }),
    settleExpiredRun({ runId: deadRun.id, now: new Date() }),
  ]);
  c.assertEqual(
    settles.filter((result) => result.outcome === "repaired").length,
    1,
    "exactly one racing repair settled the dead run",
  );
  c.assertEqual(
    settles.filter((result) => result.outcome === "noop").length,
    1,
    "and the other observed zero matching rows — no double-recovery",
  );

  const settledRun = await db.pmChannelRun.findUniqueOrThrow({ where: { id: deadRun.id } });
  c.assertEqual(settledRun.status, "timed_out", "the run ended terminally");
  c.assertEqual(settledRun.finishedReason, "watchdog_lease_expired", "the settle names the watchdog");
  c.assertEqual(settledRun.disposition, "failed", "WFI-005: the terminal write recorded a disposition");

  // A third pass, after the settle, must not re-settle: the finish timestamp is
  // the observable that would move if the conditional guard were removed.
  const before = settledRun.finishedAt?.getTime() ?? null;
  await settleExpiredRun({ runId: deadRun.id, now: new Date(Date.now() + MINUTE_MS) });
  const after = await db.pmChannelRun.findUniqueOrThrow({ where: { id: deadRun.id } });
  c.assertEqual(after.finishedAt?.getTime() ?? null, before, "a later repair leaves the settle untouched");

  // Restated in the Epic's vocabulary, over everything this case wrote.
  const lanes = await activeLaneViolations(world.projectId);
  c.assertEqual(lanes.length, 0, `WFI-001 holds after every race: ${lanes.join("; ")}`);
}

main().catch((error: unknown) => {
  console.error("[workflow-regression-concurrency] unexpected failure:", error);
  process.exit(1);
});
