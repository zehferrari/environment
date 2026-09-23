// ENV-124 Group A — run lifecycle and liveness regressions.
//
// Six of the Epic's twelve cases are about ONE property: a turn that did not
// finish must never read as a turn that did. Each case here is a shape PM
// historically got wrong, driven through the real route and the real recorders:
//
//   C1  the agent starts and returns an empty response
//   C2  the process dies after accepting a run
//   C3  the process dies after recording start but before queuing continuation
//   C4  a retry follows a context-compaction failure
//   C5  an older accepted run exists alongside a newer completed run
//   C10 execution crosses multiple fresh sessions without losing progress
//
// Three rules the file keeps to, all load-bearing:
//
//   * PRODUCTION WRITERS ONLY. Runs are queued by the real notification
//     dispatcher, accepted by `recordPmChannelRunDispatch`, settled by
//     `recordPmChannelRunEvent`, retried by the shared turn-failure ladder,
//     repaired by `runWorkflowWatchdog` and resumed by
//     `drainPmChannelContinuations`. Workflow actions go through the route
//     handler. A regression that only fails through a helper written for the
//     test is not a regression anybody would have shipped.
//
//   * ASSERT IN THE REGISTRY'S VOCABULARY. Where lib/workflow-invariants.ts
//     already states the property — WFI-002 lease renewal, WFI-003
//     stale-active-run, WFI-004 continuation actions, WFI-005 dispositions,
//     WFI-006 empty responses — the case evaluates THOSE predicates against the
//     real rows instead of inventing a second, weaker vocabulary beside them.
//
//   * TIME IS THE ONLY THING FAKED. A dead process is observable only through
//     elapsed time (the lease TTL, the watchdog's stall grace), so seeded
//     timestamps are moved backwards. No case writes a run status, a
//     disposition or an outbox row by hand.
//
// C1 asserts one CURRENT behaviour that contradicts the invariant baseline's
// own note; it is labelled `FINDING:` in place.
//
// The suite owns its own throwaway database (see scripts/lib/
// workflow-scenario-harness.ts) and never touches the live pm.db.
//
// Exit 0 on success, non-zero on the first failed assertion.

import "./lib/next-als-polyfill";

import type { ScenarioCase } from "./lib/workflow-scenario-harness";
import {
  MINUTE_MS,
  bootScenarioDb,
  createIdSeeder,
  createScenarioReporter,
  createScenarioSandbox,
  dispatchWorkflowTurn,
  forkWorldProject,
  makeWorkflowPoster,
  readRunState,
  readTaskProgress,
  replyTargetFor,
  seedTask,
  seedWorld,
} from "./lib/workflow-scenario-harness";

const SUITE = "workflow-regression-lifecycle";
const AGENT_SLUG = "lifecyclebot";

// The exact final frame OpenClaw emits when a session can no longer compact.
// `isPmTerminalFailureText` (lib/agents/ops/pm-silence.ts) is what classifies
// it, and the reply route turns it into the `error` event replayed below —
// deliberately NOT into a durable reply.
const COMPACTION_FAILURE =
  "⚠️ Context is too large and auto-compaction could not recover this turn.";

const report = createScenarioReporter(SUITE);

async function main(): Promise<void> {
  const sandbox = await createScenarioSandbox({
    name: SUITE,
    // `migrate`, not `push`: C5's supersede assertions rest on the partial
    // unique index over active runs, which exists only in the raw-SQL migration.
    schema: "migrate",
    env: {
      // Two attempts, retried immediately. C4 is about the BOUND, not about the
      // ladder's wall-clock spacing.
      PM_CHANNEL_JOB_MAX_ATTEMPTS: "2",
      PM_CHANNEL_JOB_RETRY_BASE_MS: "1",
      // A two-cycle episode budget. C10 has to cross two episode boundaries,
      // and the budget's SIZE is not what any of these cases are about.
      PM_EPISODE_MAX_CYCLES: "2",
      PM_WATCHDOG_MAX_RECOVERIES: "3",
    },
  });

  try {
    const boot = await bootScenarioDb();
    const { db, runs, continuations, transactionalAction, actionEffect, episodes } = boot;

    const { runWorkflowWatchdog } = await import("@/lib/agents/watchdog/run");
    const { WATCHDOG_CONTINUATION_ACTION } = await import(
      "@/lib/agents/watchdog/repairs"
    );
    const { CONTEXT_PRESSURE_RECOVERY_ACTION } = await import(
      "@/lib/agents/pm-channel/continuations"
    );
    const { WATCHDOG_STALL_GRACE_MS } = await import("@/lib/agents/watchdog/detectors");
    const { WORKFLOW_RUN_LEASE_TTL_MS, evaluateWorkflowInvariants } = await import(
      "@/lib/workflow-invariants"
    );
    const { loadWorkflowInvariantSnapshot } = await import("@/lib/workflow-invariants-db");
    const { claimNextPmChannelJob } = await import("@/lib/agents/pm-channel/jobs");
    const { drainPmChannelContinuations } = await import(
      "@/lib/agents/pm-channel/continuation-drain"
    );
    const { persistTaskReply } = await import("@/lib/agents/pm-channel/persist-task-reply");

    const world = await seedWorld(db, {
      agentSlug: AGENT_SLUG,
      agentName: "Lifecycle Bot",
      projectSlug: "regression-lifecycle",
      withEpic: true,
    });

    // ------------------------------------------------------------------
    // Shared readers
    // ------------------------------------------------------------------

    /** The run a given grant turn produced. One per (task, agent, message). */
    const runFor = (taskId: string, messageId: string) =>
      db.pmChannelRun.findFirstOrThrow({ where: { taskId, messageId } });

    const jobFor = (runId: string) => db.pmChannelJob.findUniqueOrThrow({ where: { runId } });

    /**
     * The registry's own verdict on one project's rows, keyed by invariant id.
     *
     * Project-scoped, because each case forks its own project: one case's
     * deliberately broken run must never colour another's verdict.
     */
    async function violations(projectId: string) {
      const snapshot = await loadWorkflowInvariantSnapshot({ projectId });
      return evaluateWorkflowInvariants(snapshot).byInvariant;
    }

    /**
     * Move a run's clock backwards by `ms`.
     *
     * The one thing these scenarios fake. A dead process is observable ONLY
     * through elapsed time — the lease TTL and the stall grace are both
     * measured against these columns — and waiting half an hour per case is not
     * a test. No status, disposition or outbox row is touched: every transition
     * that follows is made by the code under test reading these timestamps.
     */
    async function ageRun(runId: string, ms: number) {
      const run = await db.pmChannelRun.findUniqueOrThrow({
        where: { id: runId },
        select: {
          createdAt: true,
          acceptedAt: true, admittedAt: true,
          streamingAt: true,
          lastEventAt: true,
          leaseExpiresAt: true,
          heartbeatAt: true,
          lastActionAt: true,
        },
      });
      const back = (value: Date | null) => (value ? new Date(value.getTime() - ms) : null);
      await db.pmChannelRun.update({
        where: { id: runId },
        data: {
          createdAt: new Date(run.createdAt.getTime() - ms),
          acceptedAt: back(run.acceptedAt), admittedAt: back(run.admittedAt ?? run.acceptedAt),
          streamingAt: back(run.streamingAt),
          lastEventAt: back(run.lastEventAt),
          leaseExpiresAt: back(run.leaseExpiresAt),
          heartbeatAt: back(run.heartbeatAt),
          lastActionAt: back(run.lastActionAt),
        },
      });
    }

    /** Older than both the run lease TTL and the watchdog's stall grace. */
    const LONG_DEAD_MS =
      Math.max(WORKFLOW_RUN_LEASE_TTL_MS, WATCHDOG_STALL_GRACE_MS) + 15 * MINUTE_MS;

    /**
     * The gateway accepted the turn.
     *
     * `recordPmChannelRunDispatch` is what the worker calls with a successful
     * dispatch result, so this is the real "the agent is running now" write —
     * including the lease the run is then expected to renew.
     */
    const acceptDispatch = (target: ReturnType<typeof replyTargetFor>) =>
      runs.recordPmChannelRunDispatch({
        target,
        result: { ok: true, status: 202, driver: "openclaw-pm-channel", transportMode: "inproc" },
      });

    // ------------------------------------------------------------------
    // C1 — the agent starts and returns an empty response.
    //
    // The historical bug: `start` settled the run and its job `complete`, so a
    // turn that began work and then said nothing reported a SUCCESSFUL turn.
    // The contract now is that `start` is a step inside the episode, and an
    // empty final response ends the turn as interrupted, not complete.
    //
    // An empty response cannot even reach the reply callback — POST
    // /api/openclaw/pm-channel/reply rejects an empty body with 400 — so the
    // only thing PM ever observes is the stream's `done`.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C1", "empty response after start is interrupted, not complete");
      const scope = await forkWorldProject(db, world, { projectSlug: "c1", withEpic: true });
      const task = await seedTask(db, scope, {
        title: "C1 empty response",
        status: "To Do",
        underEpic: true,
      });
      const turn = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });

      const started = await turn.post("start");
      c.assertEqual(started.status, 202, "start is accepted");
      c.assertEqual(started.body.actionEffect, "continue", "start continues the episode");
      c.assertEqual(started.body.turnComplete, false, "start does not complete the turn");
      c.assertEqual(started.body.taskState, "In Progress", "the task actually moved");

      const afterStart = await readRunState(db, { taskId: task.id });
      c.assertEqual(afterStart.active.length, 1, "the run is still active after start");
      c.assertEqual(afterStart.active[0].disposition, "continue", "start records the continue disposition");
      c.assertEqual(
        afterStart.active[0].settledByAction,
        null,
        "start settles nothing, so no settling action is recorded",
      );
      c.assertEqual(afterStart.open.length, 1, "start armed exactly one continuation");
      c.assertEqual(afterStart.open[0].action, "start", "the armed continuation names the action");

      // The turn now ends with NO durable reply — the empty final response.
      await runs.recordPmChannelRunEvent({ target: turn.target, event: "done" });

      const run = await runFor(task.id, turn.messageId);
      c.assert(
        run.status !== "completed",
        `an empty final response must not settle the run complete (got ${run.status})`,
      );
      c.assertEqual(run.status, "queued", "it remains non-terminal while the interrupted turn is retried");
      c.assertEqual(
        run.error,
        "Agent finished without posting a reply.",
        "and says exactly why, rather than inventing an outcome",
      );
      c.assertEqual(run.lastAction, "start", "the durable action the turn did take is preserved");
      c.assertEqual(
        run.settledByAction,
        null,
        "no workflow action stood in for the missing response (WFI-006's only escape hatch)",
      );

      // WFI-006 is the registry's statement of exactly this case. It fires on a
      // COMPLETE run with an empty response — so the invariant staying silent
      // here IS the regression not having happened.
      const byInvariant = await violations(scope.projectId);
      c.assertEqual(
        byInvariant["WFI-006"].length,
        0,
        "WFI-006: production refused to call the empty turn a completion",
      );
      c.assertEqual(
        byInvariant["WFI-004"].length,
        0,
        "WFI-004: `start` did not settle the episode as a successful outcome",
      );

      c.assertEqual(
        run.disposition,
        "continue",
        "a retry-pending run remains an explicit continuation",
      );
      c.assertEqual(
        byInvariant["WFI-005"].length,
        0,
        "WFI-005: queued retry state plus continue disposition is internally consistent",
      );

      // Interrupted means re-run, and exactly once: the turn's own job goes
      // back on the retry ladder, and the outbox row stays armed rather than
      // scheduling a competing second turn.
      const job = await jobFor(run.id);
      c.assertEqual(job.status, "retryable", "the turn is scheduled to run again");
      c.assertIncludes(
        job.lastError,
        "without posting a reply",
        "the retry reason names the empty response",
      );
      const settled = await readRunState(db, { taskId: task.id });
      c.assertEqual(settled.runs.length, 1, "the retry reuses the run; no second execution was minted");
      c.assertEqual(
        settled.open.length,
        1,
        "the episode's continuation survives the interruption instead of being discarded",
      );
      c.assertEqual(settled.open[0].status, "armed", "and stays armed — the turn never settled cleanly");
      c.assertEqual(
        settled.continuations.filter((row) => row.status === "dispatched").length,
        0,
        "so nothing was dispatched twice",
      );

      const progress = await readTaskProgress(db, task.id);
      c.assertEqual(progress.status, "In Progress", "the task stays In Progress, not Done");
    }

    // ------------------------------------------------------------------
    // C2 — the process dies after accepting a run.
    //
    // The turn was dispatched, the gateway said 202, and then the agent process
    // died without emitting one event. Nothing in the turn's own path can
    // repair that: the process that would have written the next row is gone.
    // The only evidence is a lease that stops being renewed, and the watchdog
    // is the only actor left.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C2", "death after accepting a run is detected and recovered");
      const scope = await forkWorldProject(db, world, { projectSlug: "c2", withEpic: true });
      const task = await seedTask(db, scope, {
        title: "C2 died after accept",
        status: "In Progress",
        underEpic: true,
      });

      const turn = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });
      await acceptDispatch(turn.target);

      const accepted = await runFor(task.id, turn.messageId);
      c.assertEqual(accepted.status, "delivered", "the run was delivered to the gateway");
      c.assertEqual((await jobFor(accepted.id)).status, "queued", "its queue job is still open");

      // ENV-159: simulate admission — the gateway picks up the delivered run
      // and sets a lease. The process dies after admission but before any
      // streaming event, so the lease is the only evidence it was ever alive.
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + WORKFLOW_RUN_LEASE_TTL_MS);
      await db.pmChannelRun.update({
        where: { id: accepted.id },
        data: { admittedAt: now, leaseExpiresAt, lastEventAt: now },
      });

      // ... and then nothing at all, for longer than the lease allows.
      await ageRun(accepted.id, LONG_DEAD_MS);

      const before = await violations(scope.projectId);
      c.assertEqual(
        before["WFI-002"].map((v) => v.code).join(","),
        "WFI-002/lease-not-renewed",
        "WFI-002 catches the run that never renewed its lease",
      );
      c.assertEqual(
        before["WFI-003"].map((v) => v.code).join(","),
        "WFI-003/stale-active-run-without-successor",
        "WFI-003 catches the task still resting its evidence of work on that run",
      );

      // One pass repairs BOTH findings: the dead lease is settled, and the task
      // — which the same snapshot already sees as having no live run — gets one
      // recovery turn. The visible state is the higher-priority diagnosis.
      const pass1 = await runWorkflowWatchdog({ projectId: scope.projectId });
      c.assertEqual(pass1.errors.length, 0, `pass 1 reported no errors: ${pass1.errors.join("; ")}`);

      const dead = await runFor(task.id, turn.messageId);
      c.assertEqual(dead.status, "timed_out", "the dead lease was settled terminally");
      c.assertEqual(
        dead.finishedReason,
        "watchdog_lease_expired",
        "the settle names the watchdog, so the cause is auditable",
      );
      c.assertEqual(dead.disposition, "failed", "WFI-005: the terminal write recorded a disposition");
      c.assert(dead.status !== "completed", "a dead process never yields a completed run");
      c.assertEqual((await jobFor(dead.id)).status, "failed", "its queue job was settled with it");
      c.assertEqual(
        (await readRunState(db, { taskId: task.id })).active.length,
        0,
        "no run is left claiming the task is actively being worked",
      );

      const recovered = await readRunState(db, { taskId: task.id });
      c.assertEqual(recovered.open.length, 1, "exactly one recovery turn is scheduled");
      c.assertEqual(
        recovered.open[0].action,
        WATCHDOG_CONTINUATION_ACTION,
        "labelled as a watchdog recovery, not as an action the agent took",
      );
      c.assertEqual(recovered.open[0].status, "queued", "and drainable immediately");

      const state = await readTaskProgress(db, task.id);
      c.assertEqual(state.status, "In Progress", "the task was not abandoned to a dead run");
      c.assertEqual(state.executionState?.state, "stalled", "the operator strip says stalled");
      c.assertEqual(
        state.executionState?.reasonCode,
        "expired_run_lease",
        "and names the highest-priority diagnosis — the lease nobody renewed",
      );
      c.assertEqual(
        state.executionState?.recoveryAction,
        "stale run settled",
        "with what PM did about it rendered beside it",
      );

      const after = await violations(scope.projectId);
      c.assertEqual(after["WFI-002"].length, 0, "WFI-002 holds once the dead lease is settled");
      c.assertEqual(after["WFI-003"].length, 0, "WFI-003 holds once a successor is scheduled");

      // Pass 2 observes a task that is genuinely being worked again, and — the
      // idempotency property — queues nothing further.
      const pass2 = await runWorkflowWatchdog({ projectId: scope.projectId });
      c.assertEqual(pass2.errors.length, 0, `pass 2 reported no errors: ${pass2.errors.join("; ")}`);
      c.assertEqual(
        (await readRunState(db, { taskId: task.id })).open.length,
        1,
        "repeated passes never stack recovery turns",
      );
      const settledState = await readTaskProgress(db, task.id);
      c.assertEqual(settledState.executionState?.state, "running", "the task reads as running again");
      c.assertEqual(
        settledState.executionState?.reasonCode,
        "continuation_scheduled",
        "because a turn is scheduled for it",
      );
    }

    // ------------------------------------------------------------------
    // C3 — the process dies after recording start but before queuing the
    //      continuation.
    //
    // Two deaths are possible in that sentence and production owes a different
    // answer to each, so the case asserts both.
    //
    //   (a) death INSIDE the action, after the domain mutation and before the
    //       outbox arm. This is the loss window ENV-118 closed, and the only
    //       safe outcome is that neither half committed: a task that moved to
    //       In Progress with no armed continuation looks claimed, has nobody
    //       working it, and nothing will ever schedule its next turn.
    //
    //   (b) death AFTER the action committed, before the turn settled. The arm
    //       is durable but still `armed` — only a settle promotes it to
    //       `queued` — so the episode depends on the watchdog noticing the dead
    //       lease and the drain turning the survivor into a real turn.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C3", "death around start loses neither the task nor the episode");

      // --- (a) death inside the transaction -------------------------------
      const scopeA = await forkWorldProject(db, world, { projectSlug: "c3a", withEpic: true });
      const taskA = await seedTask(db, scopeA, {
        title: "C3 died mid-transaction",
        status: "To Do",
        underEpic: true,
      });
      const turnA = await dispatchWorkflowTurn({ boot, world: scopeA, taskId: taskA.id });

      // Crash exactly where the review said the window was: after the domain
      // mutation, before the run/outbox bookkeeping.
      const { __setWorkflowCommandCrashHook } = await import("@/lib/agents/workflow/transactional-action");
      __setWorkflowCommandCrashHook((boundary, action) => {
        if (boundary === "after_domain_writes_before_execution_bookkeeping" && action === "start") {
          throw new Error("simulated process death");
        }
      });
      let crashed = false;
      try {
        const res = await turnA.post("start");
        // The route may surface the crash as a 5xx rather than throwing out of
        // the handler; either way the transaction must not have committed.
        crashed = res.status >= 500 || res.body.ok !== true;
      } catch {
        crashed = true;
      } finally {
        __setWorkflowCommandCrashHook(null);
      }
      c.assert(crashed, "the crashing action did not report success");

      c.assertEqual(
        (await readTaskProgress(db, taskA.id)).status,
        "To Do",
        "the task did NOT move: the domain mutation rolled back with the outbox",
      );
      c.assertEqual(
        (await readRunState(db, { taskId: taskA.id })).open.filter((row) => row.action === "start").length,
        0,
        "no start continuation was armed for a mutation that never committed",
      );

      // And the agent can safely retry with the same reusable token.
      const retried = await turnA.post("start");
      c.assertEqual(retried.status, 202, "the same grant retries cleanly after the crash");
      c.assertEqual(retried.body.taskState, "In Progress", "the retry moved the task");
      c.assertEqual(
        (await readRunState(db, { taskId: taskA.id })).open.filter((row) => row.action === "start").length,
        1,
        "the retry armed exactly one continuation, not two",
      );

      // --- (b) death after the commit, before the settle -------------------
      const scopeB = await forkWorldProject(db, world, { projectSlug: "c3b", withEpic: true });
      const taskB = await seedTask(db, scopeB, {
        title: "C3 died before the settle",
        status: "To Do",
        underEpic: true,
      });
      const turnB = await dispatchWorkflowTurn({ boot, world: scopeB, taskId: taskB.id });
      const startedB = await turnB.post("start");
      c.assertEqual(startedB.status, 202, "start committed this time");

      const runB = await runFor(taskB.id, turnB.messageId);
      c.assert(runB.status !== "completed", "WFI-004: start did not settle the run complete");
      const armed = await readRunState(db, { taskId: taskB.id });
      c.assertEqual(armed.open.length, 1, "the continuation survived the crash");
      c.assertEqual(
        armed.open[0].status,
        "armed",
        "armed, not queued: only a settle promotes it, and the settle never came",
      );

      await ageRun(runB.id, LONG_DEAD_MS);
      const pass = await runWorkflowWatchdog({ projectId: scopeB.projectId });
      c.assertEqual(pass.errors.length, 0, `the watchdog pass reported no errors: ${pass.errors.join("; ")}`);

      const settledB = await runFor(taskB.id, turnB.messageId);
      c.assertEqual(settledB.status, "timed_out", "the dead run was settled");
      c.assertEqual(
        settledB.disposition,
        "continue",
        "a run that died owing a continuation ends `continue`, not `failed`: the episode is unfinished",
      );
      const promoted = await readRunState(db, { taskId: taskB.id });
      c.assertEqual(promoted.open.length, 1, "still exactly one continuation");
      c.assertEqual(
        promoted.open[0].status,
        "queued",
        "a dead lease loses the run, not the episode",
      );

      // The drain is what turns the surviving row into an actual turn.
      const drained = await drainPmChannelContinuations();
      c.assert(drained.dispatched >= 1, "the drain scheduled the owed turn");
      const resumed = await readRunState(db, { taskId: taskB.id });
      c.assertEqual(
        resumed.continuations.filter((row) => row.status === "dispatched").length,
        1,
        "exactly one fresh execution turn came out of the crash",
      );
      c.assertEqual(resumed.runs.length, 2, "it is a new run, not a resurrection of the dead one");
      c.assertEqual(resumed.active.length, 1, "WFI-001: only one of them is active");
      c.assertEqual(
        (await readTaskProgress(db, taskB.id)).status,
        "In Progress",
        "and the task the crash claimed is being worked again",
      );
      c.assertEqual(
        (await violations(scopeB.projectId))["WFI-004"].length,
        0,
        "WFI-004 holds: `start` never stood in for a finished episode",
      );
    }

    // ------------------------------------------------------------------
    // C4 — a fresh execution episode follows a context-compaction failure.
    //
    // A turn whose context overflowed produced no outcome, but it is NOT a
    // failed task: the work is still valid and the agent must re-enter. The
    // contract has four parts and this case asserts all of them —
    //   * the poisoned transport run and job end failed, never complete;
    //   * the bounded execution episode rolls over exactly once;
    //   * durable progress (status, checklist, episode cycles) survives;
    //   * one continuation resumes the task in a genuinely fresh session.
    //
    // Driven the way the reply route drives it: the compaction notice is
    // classified as a terminal failure and replayed as an `error` event, never
    // persisted as the agent's reply.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C4", "retry after a context-compaction failure is bounded and continuous");
      const scope = await forkWorldProject(db, world, { projectSlug: "c4", withEpic: true });
      const task = await seedTask(db, scope, {
        title: "C4 compaction failure",
        status: "In Progress",
        underEpic: true,
      });
      const turn = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });
      const run = await runFor(task.id, turn.messageId);
      const sessionBefore = run.sessionKey;
      c.assert(Boolean(sessionBefore), "the dispatched turn recorded the session carrying it");

      /**
       * Claim this task's job the way the worker does.
       *
       * The claim is what increments `attemptCount`, and `attemptCount` is the
       * ladder's bound — so the retry budget cannot be exercised honestly
       * without it. `claimNextPmChannelJob` takes the globally oldest available
       * job, so the loop keeps claiming until it reaches ours; the rows it
       * walks past belong to cases that have already finished asserting.
       */
      async function claimOwnJob(workerId: string) {
        for (let i = 0; i < 25; i += 1) {
          const claimed = await claimNextPmChannelJob(workerId);
          if (!claimed) break;
          if (claimed.runId === run.id) return claimed;
        }
        return report.fail("C4: the worker never reached this task's job");
      }

      await claimOwnJob(`${SUITE}-c4:1`);
      await acceptDispatch(turn.target);

      // Real progress banked before the overflow: it must survive recovery.
      const seeded = await turn.post("add_subtask", { subtaskText: "C4 step banked before overflow" });
      c.assertEqual(seeded.status, 202, "the pre-overflow action was accepted");

      // --- failure 1: the session cannot compact --------------------------
      await runs.recordPmChannelRunEvent({
        target: turn.target,
        event: "error",
        error: COMPACTION_FAILURE,
      });

      const recoveredRun = await runFor(task.id, turn.messageId);
      const recoveredJob = await jobFor(run.id);
      c.assertEqual(recoveredJob.status, "failed", "the poisoned transport turn is never replayed");
      c.assertIncludes(
        recoveredJob.lastError,
        "auto-compaction could not recover",
        "and the terminal transport row records the real reason",
      );
      c.assert(
        recoveredRun.status !== "completed",
        "the overflowed run is never reported as a completion",
      );
      c.assertEqual(recoveredRun.status, "failed", "the poisoned run ends terminally");
      c.assertEqual(
        recoveredRun.finishedReason,
        "context_pressure_episode_recovered",
        "the terminal reason records that execution continued in a fresh episode",
      );
      c.assertEqual(recoveredRun.disposition, "continue", "the task execution itself continues");

      const midRecovery = await readRunState(db, { taskId: task.id });
      c.assertEqual(
        midRecovery.runs.length,
        1,
        "recovery does not mint a second run before the durable continuation drains",
      );
      c.assertEqual(
        midRecovery.open.length,
        1,
        "exactly one fresh-episode continuation is open",
      );
      c.assertEqual(
        midRecovery.open[0]!.action,
        CONTEXT_PRESSURE_RECOVERY_ACTION,
        "the continuation names the context-pressure handoff",
      );

      const preserved = await readTaskProgress(db, task.id);
      c.assertEqual(preserved.status, "In Progress", "the task keeps its status across recovery");
      c.assertEqual(preserved.checklist, 1, "the checklist banked before the overflow survives");
      const recoveredEpisodes = await db.taskExecutionEpisode.findMany({
        where: { taskId: task.id, agentSlug: AGENT_SLUG },
        orderBy: { episodeNo: "asc" },
      });
      c.assertEqual(recoveredEpisodes.length, 2, "the poisoned episode has exactly one successor");
      c.assertEqual(
        recoveredEpisodes[0]!.closeReason,
        "context_pressure_recovery",
        "the old episode records why it was retired",
      );
      c.assertEqual(recoveredEpisodes[0]!.cycleCount, 1, "its observed progress remains durable");
      c.assertEqual(recoveredEpisodes[1]!.sessionKey, null, "the successor inherits no poisoned session");

      const drained = await drainPmChannelContinuations();
      c.assert(drained.dispatched >= 1, "the fresh-episode continuation is dispatchable");
      const resumed = await readRunState(db, { taskId: task.id });
      c.assertEqual(
        resumed.active.length,
        1,
        "exactly one fresh execution turn owns the task after recovery",
      );
      const resumedRun = await db.pmChannelRun.findFirstOrThrow({
        where: { taskId: task.id, status: { in: ["queued", "accepted", "streaming"] } },
        orderBy: { createdAt: "desc" },
        select: { sessionKey: true },
      });
      c.assert(
        resumedRun.sessionKey !== sessionBefore,
        "the successor is dispatched in a fresh session",
      );
    }

    // ------------------------------------------------------------------
    // C5 — an older accepted run exists alongside a newer completed run.
    //
    // Two rows both claiming a lane is the shape that makes "is this task being
    // worked?" unanswerable. Production owes two answers: the newer run must
    // retire the older one as it is queued (with lineage, and closing its
    // continuation lane so the drain cannot put two turns in one lane), and a
    // survivor from before that write must be EXPIRED rather than left
    // accepted forever.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C5", "an older run is superseded or expired, never left accepted");
      const scope = await forkWorldProject(db, world, { projectSlug: "c5", withEpic: true });

      // --- half 1: the queue-time supersede --------------------------------
      const task = await seedTask(db, scope, {
        title: "C5 two turns, one lane",
        status: "In Progress",
        underEpic: true,
      });

      const older = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });
      await acceptDispatch(older.target);
      const olderStarted = await older.post("add_subtask", { subtaskText: "C5 work in the older turn" });
      c.assertEqual(olderStarted.status, 202, "the older turn armed a continuation of its own");
      const olderRun = await runFor(task.id, older.messageId);
      c.assertEqual(olderRun.status, "delivered", "the older run is holding the lane");

      const newer = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });
      const newerRun = await runFor(task.id, newer.messageId);

      const state = await readRunState(db, { taskId: task.id });
      c.assertEqual(state.active.length, 1, "exactly one run is active in the lane");
      c.assertEqual(state.active[0].id, newerRun.id, "and it is the newer one");

      const retired = await db.pmChannelRun.findUniqueOrThrow({ where: { id: olderRun.id } });
      c.assertEqual(retired.status, "superseded", "the older accepted run was superseded");
      c.assertEqual(
        retired.finishedReason,
        "superseded_by_newer_run",
        "the supersede names its cause",
      );
      c.assertEqual(
        retired.disposition,
        "continue",
        "a supersede is never `completed`: the episode did not finish, it was taken over",
      );
      c.assertEqual(
        retired.supersededByRunId,
        newerRun.id,
        "lineage points at the run that actually took over",
      );
      const orphaned = state.continuations.filter((row) => row.runId === olderRun.id);
      c.assertEqual(orphaned.length, 1, "the older run's continuation row is still readable");
      c.assertEqual(
        orphaned[0].status,
        "superseded",
        "retiring a run closes its continuation lane, so the drain cannot dispatch two turns",
      );

      // Finish the newer run the way a real turn does: a durable reply, then
      // the stream's final frame.
      const persisted = await persistTaskReply(newer.target, "C5 newer turn finished the work.");
      c.assertEqual(persisted.status, 200, "the agent's reply persisted");
      await runs.recordPmChannelRunEvent({ target: newer.target, event: "final" });

      const completed = await runFor(task.id, newer.messageId);
      c.assertEqual(completed.status, "completed", "the newer run completed");
      c.assertEqual(completed.disposition, "completed", "with an explicit successful disposition");
      c.assertEqual(
        (await readRunState(db, { taskId: task.id })).active.length,
        0,
        "and nothing is left claiming to be active beside it",
      );

      const half1 = await violations(scope.projectId);
      c.assertEqual(half1["WFI-001"].length, 0, "WFI-001: one lane never held two live runs");
      c.assertEqual(half1["WFI-002"].length, 0, "WFI-002: nothing sits on an unrenewed lease");
      c.assertEqual(half1["WFI-006"].length, 0, "WFI-006: the completed run carries a durable response");

      // --- half 2: a survivor from before the supersede write --------------
      // Seeded directly, because the point is precisely a row no current writer
      // produces: an accepted run older than a completed one, never retired.
      const legacyTask = await seedTask(db, scope, {
        title: "C5 run that predates the supersede",
        status: "In Progress",
        underEpic: true,
      });
      const legacyNewer = await dispatchWorkflowTurn({ boot, world: scope, taskId: legacyTask.id });
      await persistTaskReply(legacyNewer.target, "C5 legacy lane: newer turn finished.");
      await runs.recordPmChannelRunEvent({ target: legacyNewer.target, event: "final" });
      c.assertEqual(
        (await runFor(legacyTask.id, legacyNewer.messageId)).status,
        "completed",
        "the newer run in the legacy lane is complete",
      );

      const stale = new Date(Date.now() - LONG_DEAD_MS);
      const orphan = await db.pmChannelRun.create({
        data: {
          targetKey: `task-comment:${AGENT_SLUG}:${legacyTask.id}:msg-c5-legacy`,
          kind: "task-comment",
          agentSlug: AGENT_SLUG,
          messageId: "msg-c5-legacy",
          projectId: scope.projectId,
          taskId: legacyTask.id,
          status: "accepted",
          createdAt: stale,
          acceptedAt: stale, admittedAt: stale,
          lastEventAt: stale,
        },
      });

      c.assert(
        (await violations(scope.projectId))["WFI-002"].some((v) => v.subjectId === orphan.id),
        "the surviving accepted run is a WFI-002 violation, not an accepted state of the world",
      );

      const pass = await runWorkflowWatchdog({ projectId: scope.projectId });
      c.assertEqual(pass.errors.length, 0, `the watchdog pass reported no errors: ${pass.errors.join("; ")}`);
      const expired = await db.pmChannelRun.findUniqueOrThrow({ where: { id: orphan.id } });
      c.assertEqual(expired.status, "timed_out", "the watchdog expired the run the supersede never saw");
      c.assertEqual(expired.finishedReason, "watchdog_lease_expired", "and named itself in the settle");
      c.assertEqual(expired.disposition, "failed", "WFI-005: with a disposition");
      c.assertEqual(
        (await violations(scope.projectId))["WFI-002"].filter((v) => v.subjectId === orphan.id).length,
        0,
        "and the violation is gone once the run is expired",
      );
    }

    // ------------------------------------------------------------------
    // C10 — execution crosses multiple fresh sessions without losing progress.
    //
    // The episode model (ENV-121) exists so a long task can span several model
    // sessions instead of one ever-growing transcript. Crossing that boundary
    // is the moment progress can silently vanish, so this case walks TWO
    // boundaries end to end, through the production path each time:
    //
    //   spend the cycle budget → PM fences the turn → the agent writes its one
    //   final checkpoint → the seal schedules the successor → the turn settles
    //   → the drain dispatches the next episode in a NEW session.
    //
    // What must hold at the end: three distinct sessions, every checklist item
    // and every comment still on the board, and the agent's own next-action
    // carried across rather than re-derived.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C10", "execution spans fresh sessions without losing progress");
      const scope = await forkWorldProject(db, world, { projectSlug: "c10", withEpic: true });
      const task = await seedTask(db, scope, {
        title: "C10 multi-session execution",
        status: "In Progress",
        underEpic: true,
      });
      const step = createIdSeeder("c10-step");
      const sessionKeys: string[] = [];

      let messageId = (await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id })).messageId;

      /**
       * Spend one episode's budget, seal it with the agent's own checkpoint,
       * end the turn, and let the drain schedule the successor. Returns the
       * message id of the turn PM dispatched for the next episode.
       */
      async function spendEpisode(episodeNo: number): Promise<string> {
        const post = await makeWorkflowPoster({ taskId: task.id, messageId, agentSlug: AGENT_SLUG });
        const target = replyTargetFor({ agentSlug: AGENT_SLUG, taskId: task.id, messageId });

        const run = await runFor(task.id, messageId);
        c.assertIncludes(
          run.sessionKey,
          `:ep${episodeNo}`,
          `episode ${episodeNo} runs in its own episode-scoped session`,
        );
        sessionKeys.push(run.sessionKey ?? "");

        // Two cycles is the configured budget, so the second one rolls over.
        const first = await post("add_subtask", { subtaskText: `${step()} in episode ${episodeNo}` });
        c.assertEqual(first.status, 202, `episode ${episodeNo}: the first cycle landed`);
        const last = await post("add_subtask", { subtaskText: `${step()} in episode ${episodeNo}` });
        c.assertEqual(last.status, 202, `episode ${episodeNo}: the budget-spending cycle landed`);
        c.assertEqual(
          last.body.episodeBudgetExhausted,
          true,
          `episode ${episodeNo}: PM told the agent its budget is spent`,
        );

        // The fence: this message may write one checkpoint and nothing else.
        const fenced = await post("add_subtask", { subtaskText: "work past the fence" });
        c.assertEqual(
          fenced.status,
          409,
          `episode ${episodeNo}: the spent turn is fenced out of the task`,
        );
        c.assertEqual(fenced.body.episodeClosed, true, "and is told the episode is closed");

        const checkpoint = await post("checkpoint", {
          completedWork: [`episode ${episodeNo} landed two checklist items`],
          openChecklist: ["verify the port end to end"],
          nextAction: `continue from episode ${episodeNo + 1}`,
        });
        c.assertEqual(checkpoint.status, 202, `episode ${episodeNo}: the final checkpoint was accepted`);
        c.assertEqual(
          checkpoint.body.successorScheduled,
          true,
          `episode ${episodeNo}: sealing the checkpoint is what schedules the successor`,
        );
        const twice = await post("checkpoint", { nextAction: "sneak in a second checkpoint" });
        c.assertEqual(twice.status, 409, `episode ${episodeNo}: the barrier is single-use`);

        // The turn ends properly — a durable reply, then the stream's final
        // frame. That settle is what makes the armed successor drainable.
        const reply = await persistTaskReply(target, `Episode ${episodeNo} done; handing over.`);
        c.assertEqual(reply.status, 200, `episode ${episodeNo}: the handover reply persisted`);
        await runs.recordPmChannelRunEvent({ target, event: "final" });
        const settled = await runFor(task.id, messageId);
        c.assertEqual(
          settled.disposition,
          "continue",
          `episode ${episodeNo}: the turn ended owing a continuation, so it is not a completion`,
        );

        const drained = await drainPmChannelContinuations();
        c.assert(drained.dispatched >= 1, `episode ${episodeNo}: the successor turn was dispatched`);
        const dispatched = await db.pmChannelContinuation.findMany({
          where: { taskId: task.id, messageId, status: "dispatched" },
          select: { dispatchedMessageId: true },
        });
        c.assertEqual(
          dispatched.length,
          1,
          `episode ${episodeNo}: exactly one successor turn, though the settle queued two rows`,
        );
        const next = dispatched[0].dispatchedMessageId;
        c.assert(Boolean(next), `episode ${episodeNo}: the dispatched turn recorded its message id`);
        return next as string;
      }

      messageId = await spendEpisode(1);
      messageId = await spendEpisode(2);

      // The third episode's turn is live now; record the session carrying it.
      const third = await runFor(task.id, messageId);
      c.assertIncludes(third.sessionKey, ":ep3", "the third episode runs in a third session");
      sessionKeys.push(third.sessionKey ?? "");
      c.assertEqual(
        new Set(sessionKeys).size,
        3,
        "three episodes ran in three DISTINCT model sessions, not one growing transcript",
      );

      const history = await episodes.taskExecutionEpisodeHistory({
        taskId: task.id,
        agentSlug: AGENT_SLUG,
        take: 5,
      });
      c.assertEqual(history.length, 3, "three episodes are on the record");
      c.assertEqual(history[0].episodeNo, 3, "the newest is the one now running");
      c.assertEqual(history[0].status, "open", "and it is open");
      c.assertEqual(history[0].cycleCount, 0, "with a fresh budget");
      c.assertEqual(
        history[1].closeReason,
        "cycle_budget_exhausted",
        "its predecessor closed because the budget ran out, not because the work stopped",
      );
      c.assert(
        history[1].barrierReleasedAt !== null,
        "and only handed over once its checkpoint was durable",
      );

      // Nothing was lost across either boundary.
      const checkpoint = await episodes.latestTaskExecutionCheckpoint({
        taskId: task.id,
        agentSlug: AGENT_SLUG,
      });
      c.assertEqual(
        checkpoint?.checkpoint.nextAction,
        "continue from episode 3",
        "the newest checkpoint carries the agent's own next exact action into the fresh session",
      );
      const progress = await readTaskProgress(db, task.id);
      c.assertEqual(progress.status, "In Progress", "the task never fell out of execution");
      c.assertEqual(progress.checklist, 4, "every checklist item from every episode survived");
      c.assertEqual(progress.comments, 0, "autonomous progress stays out of discussion comments");
      const finalThinking = await db.taskThinkingSnapshot.count({ where: { run: { taskId: task.id }, finalReceivedAt: { not: null }, progress: { not: "" } } });
      c.assertEqual(finalThinking, 2, "the durable final narrative from each episode survives in Thinking");
      c.assertEqual(progress.alertReporter, false, "and no human had to be pulled in");

      const lane = await readRunState(db, { taskId: task.id });
      c.assertEqual(lane.active.length, 1, "WFI-001: exactly one run is live at the end");
      c.assertEqual(
        lane.runs.filter((row) => row.status === "completed" && row.disposition === "completed").length,
        0,
        "no episode boundary was ever mistaken for the end of the work",
      );
      const byInvariant = await violations(scope.projectId);
      c.assertEqual(byInvariant["WFI-001"].length, 0, "WFI-001 holds across the whole crossing");
      c.assertEqual(
        byInvariant["WFI-004"].length,
        0,
        "WFI-004 holds: no continuation-required action settled an episode",
      );
      c.assertEqual(
        byInvariant["WFI-006"].length,
        0,
        "WFI-006 holds: every completion carried a real response",
      );
    }

    // The effect table and the status vocabularies are the spec every case
    // above leans on; a regression there would silently weaken all six.
    {
      const c: ScenarioCase = report.case("C1-C10", "the shared vocabulary the cases assert against is unchanged");
      c.assertEqual(actionEffect.workflowActionEffect("start"), "continue", "start continues");
      c.assertEqual(actionEffect.workflowActionEffect("ready_for_review"), "finish", "review submission finishes");
      c.assertEqual(actionEffect.workflowActionEffect("flag_blocker"), "wait", "a blocker waits on somebody else");
      c.assertEqual(
        continuations.CONTINUATION_OPEN_STATUSES.join(","),
        "armed,queued,dispatching",
        "the open-continuation statuses the readers filter on are unchanged",
      );
      c.assertEqual(
        WATCHDOG_CONTINUATION_ACTION,
        "watchdog_recovery",
        "the watchdog's recovery action name is unchanged",
      );
    }

    report.ok();
  } finally {
    await sandbox.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(`[${SUITE}] unexpected failure:`, error);
  process.exit(1);
});
