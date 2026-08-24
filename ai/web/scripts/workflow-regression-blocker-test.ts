// ENV-124 Group C — blockers are diagnosed, and permission grants resume work.
//
//   C8 a browser failure is diagnosed instead of immediately becoming a blocker
//   C9 a permission grant clears the blocker and resumes execution exactly once
//
// C8 straddles two Epic items on purpose, because production does.
//
//   Epic item 6 (WFI-007) — a formal blocker moves the task into a human-blocked
//   state and pages a decision owner, so the claim must be VALIDATED structured
//   data naming an external actor and a concrete requirement. A stale element
//   ref is neither. The gate is deterministic and, importantly, cannot be
//   satisfied by PERSISTENCE: repeating the same diagnosis louder earns nothing,
//   only distinct diagnostic evidence across rounds promotes a technical failure.
//
//   Epic item 8 — the retry that downgrade *tells the agent to do* is not free.
//   PM counts the `tool:call` events it observes, and the episode that spends
//   its budget is closed, its message fenced, and its successor briefed from a
//   durable checkpoint.
//
// Either half alone is a hole. Downgrade without a budget is an agent that
// retries a broken browser forever and never escalates; a budget without the
// downgrade is an agent that pages a human on the first stale ref. So both edges
// are asserted, in the order one real turn hits them.
//
// C9 guards the other end: once the human does act, the grant must actually
// resume the agent — exactly once, with the competing runs retired so the
// resumed turn does not race a stale one, and with the single-use authorization
// unable to be spent twice.
//
// Prior art this file complements rather than repeats:
//   scripts/formal-blocker-validation-test.ts    — the classifier's rules as pure
//                                                  fixtures. Here the claim is
//                                                  that the ROUTE reaches those
//                                                  rules with the real assignee
//                                                  identity and the real
//                                                  incident history.
//   scripts/blocker-permission-grant-test.ts     — the grant transaction against
//                                                  hand-seeded activity rows.
//                                                  Here the round is raised by
//                                                  the agent through the real
//                                                  route first, and the resume it
//                                                  reserves is actually taken.
//   scripts/checkpoint-blocker-lifecycle-test.ts — repeated publish_checkpoint
//                                                  rounds; C9 is the
//                                                  reporter_approval shape, whose
//                                                  round closes on the grant.
//
// Exit 0 on success, non-zero on the first failed assertion.

import "./lib/next-als-polyfill";

// `ScenarioCase.assert` is a TypeScript assertion function, and TS2775 requires
// every binding that calls one to carry an explicit type annotation. Importing
// the type is what lets the `const c: ScenarioCase` annotations below typecheck.
import type { ScenarioCase } from "./lib/workflow-scenario-harness";
import {
  bootScenarioDb,
  createScenarioReporter,
  createScenarioSandbox,
  dispatchWorkflowTurn,
  forkWorldProject,
  readRunState,
  readTaskProgress,
  seedTask,
  seedWorld,
} from "./lib/workflow-scenario-harness";

const SUITE = "workflow-regression-blocker";
const AGENT_SLUG = "blockerbot";

const report = createScenarioReporter(SUITE);

/** The same observed fault every round: signature identity depends on it. */
const BROWSER_EVIDENCE =
  "browser: stale element reference on the login form after navigating to /dashboard";

/**
 * Tool cycles an episode may spend in this suite before PM rolls it over.
 *
 * Production defaults to EPISODE_TOOL_CYCLE_BUDGET_DEFAULT (30). Three makes
 * the boundary observable without streaming thirty events at it; the mechanism
 * under test is the boundary, not the number.
 */
const TOOL_BUDGET = 3;

async function main(): Promise<void> {
  const sandbox = await createScenarioSandbox({
    name: SUITE,
    env: { PM_EPISODE_MAX_TOOL_CYCLES: String(TOOL_BUDGET) },
  });

  try {
    const boot = await bootScenarioDb();
    const { db, actionEffect } = boot;

    const {
      applyBlockerPermissionGrant,
      BLOCKER_PERMISSION_SUPERSEDE_REASON,
      blockerPermissionContinuationActivityId,
    } = await import("@/lib/tasks/blocker-permission-grant");
    const {
      FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES,
      FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS,
      activeFormalBlockersByTask,
      activeFormalBlockerStatesByTask,
      formalBlockerNeedsExternalInput,
    } = await import("@/lib/tasks/formal-blocker");
    const { applyPmChannelStreamCallback } = await import(
      "@/lib/agents/pm-channel/stream-callback"
    );
    const { recordPmChannelRunDispatch } = await import("@/lib/agents/pm-channel/runs");
    const { EPISODE_CLOSE_REASON } = await import("@/lib/agents/episodes/lifecycle");
    const { EPISODE_ROLLOVER_CONTINUATION_ACTION } = await import(
      "@/lib/agents/episodes/rollover"
    );
    const { checkWorkflowInvariants } = await import("@/lib/workflow-invariants-db");

    const world = await seedWorld(db, {
      agentSlug: AGENT_SLUG,
      agentName: "Blocker Bot",
      projectSlug: "regression-blocker",
    });

    /** The blocker lifecycle rows the formal-blocker readers expect, newest first. */
    const lifecycleRows = (taskId: string) =>
      db.activityLog.findMany({
        where: {
          taskId,
          kind: {
            in: [
              "task.blocker",
              "task.extra_work.blocker",
              "task.blocker.cleared",
              "task.blocker.permission.granted",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, taskId: true, kind: true, payload: true, createdAt: true },
      });

    const countActivity = (taskId: string, kind: string) =>
      db.activityLog.count({ where: { taskId, kind } });

    // ------------------------------------------------------------------
    // C8 — a browser failure is DIAGNOSED, not escalated.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C8", "a browser failure is diagnosed before it can become a blocker");
      const scope = await forkWorldProject(db, world, { projectSlug: "c8" });
      const task = await seedTask(db, scope, { title: "C8 browser failure" });
      const turn = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });

      const flag = (diagnostics: string[], overrides: Record<string, unknown> = {}) =>
        turn.post("flag_blocker", {
          comment: "The browser keeps losing the element after navigation.",
          blockerReport: {
            blockedOn: "external_service",
            requestedActor: "the platform operator",
            requestedAction: "Restore a working browser session on the runner.",
            evidence: BROWSER_EVIDENCE,
            diagnosticsAttempted: diagnostics,
            resumeCondition: "The login form is interactable in a fresh browser session.",
            reporterCanResolve: false,
            ...overrides,
          },
        });

      // ---- edge 1: a THIN claim is refused, and is not even an incident ----
      //
      // Prose with no structured report. The rejection path is deliberately
      // write-free: a malformed claim is the agent's own mistake to fix, so
      // nothing is recorded against the task and no escalation credit accrues.
      const thin = await turn.post("flag_blocker", {
        comment: "The browser keeps failing, I am blocked.",
      });
      c.assertEqual(thin.status, 422, "an unstructured blocker claim is refused outright");
      c.assertEqual(
        thin.body.rejectedRule,
        "missing_report",
        "the refusal names the rule that fired rather than free-texting an excuse",
      );
      c.assert(thin.body.requiredFields, "and it hands back the exact shape the agent must send");
      c.assertEqual(
        await countActivity(task.id, "task.blocker.incident"),
        0,
        "a rejection is not an incident: it earns no credit toward a later escalation",
      );

      // ---- edge 2: a SELF-DIRECTED claim is refused ------------------------
      //
      // The route is what supplies the assignee identity (slug, username, user
      // id) to the classifier. A fixture suite cannot prove that wiring.
      const selfDirected = await flag(["Re-ran the navigation once."], {
        requestedActor: `@${AGENT_SLUG}`,
      });
      c.assertEqual(selfDirected.status, 422, "work the assignee can do itself is not a blocker");
      c.assertEqual(
        selfDirected.body.rejectedRule,
        "requested_actor_is_assignee",
        "the route resolved the agent's own slug as the assignee identity",
      );

      // ---- edge 3: a real browser failure is DOWNGRADED to a diagnosis -----
      const first = await flag(["Re-ran the navigation once in the same session."]);
      c.assertEqual(first.status, 422, "the first round is refused as a formal blocker");
      c.assertEqual(first.body.incident, true, "it is recorded as an internal incident instead");
      c.assertEqual(
        first.body.rejectedRule,
        "retry_with_fresh_session",
        "and the rule names the retry the agent should have done",
      );
      c.assertIncludes(
        first.body.guidance as string,
        "fresh session",
        "the guidance tells the agent what to do next rather than just refusing",
      );

      const afterFirst = await readTaskProgress(db, task.id);
      c.assertEqual(afterFirst.status, "In Progress", "the task stays In Progress");
      c.assertEqual(afterFirst.alertReporter, false, "no decision owner was paged");
      c.assertEqual(
        await countActivity(task.id, "task.blocker"),
        0,
        "no formal blocker was raised",
      );
      c.assertEqual(
        await countActivity(task.id, "task.blocker.incident"),
        1,
        "but the incident IS audited, so the failure is not silently swallowed",
      );

      // A refused escalation is not a turn OUTCOME. The route returns before the
      // run recorder, so the episode neither advances nor settles — the agent is
      // still mid-turn and expected to go and retry.
      const afterFirstRun = await readRunState(db, { taskId: task.id });
      const liveRun = afterFirstRun.runs.find((row) => row.messageId === turn.messageId);
      c.assert(liveRun, "the turn's run is readable");
      c.assertEqual(
        liveRun!.settledByAction,
        null,
        "a downgraded blocker settles nothing: the episode continues",
      );
      c.assert(
        liveRun!.lastAction !== "flag_blocker",
        "and it is not recorded as the turn's last durable action",
      );

      // ---- edge 4: the SAME diagnosis again. Persistence is not evidence. ---
      const second = await flag(["Re-ran the navigation once in the same session."]);
      c.assertEqual(second.status, 422, "repeating the same diagnosis is still refused");
      c.assertEqual(second.body.incident, true, "it is another incident, not an escalation");
      c.assertEqual(
        second.body.priorDistinctDiagnostics,
        0,
        "an identical diagnosis contributes NO distinct prior round — retrying louder earns nothing",
      );
      c.assertEqual(
        await countActivity(task.id, "task.blocker"),
        0,
        "still no formal blocker",
      );

      // ---- edge 5: genuinely distinct evidence earns the escalation --------
      //
      // The bounded exit matters as much as the downgrade: a gate with no way
      // through would just be a mute button on a real outage.
      const third = await flag([
        "Re-ran the navigation once in the same session.",
        "Retried in a fresh browser profile with a cleared cache; the element never attaches.",
      ]);
      c.assertEqual(third.status, 202, `distinct evidence across rounds earns the escalation: ${JSON.stringify(third.body)}`);
      c.assertEqual(third.body.flagged, "blocker", "the formal blocker was raised");
      c.assertEqual(
        third.body.actionEffect,
        "wait",
        "raising a blocker ends the episode waiting on somebody else",
      );
      c.assertEqual(
        third.body.disposition,
        "waiting_external",
        "and the turn's disposition says so explicitly, rather than reading as completed",
      );

      const escalated = await readTaskProgress(db, task.id);
      c.assertEqual(escalated.status, "In Progress", "a blocked task stays In Progress, not Review");
      c.assertEqual(escalated.alertReporter, true, "and NOW the decision owner is paged");
      const blockerRows = await db.activityLog.findMany({
        where: { taskId: task.id, kind: "task.blocker" },
        select: { payload: true },
      });
      c.assertEqual(blockerRows.length, 1, "exactly one formal blocker exists");
      const payload = JSON.parse(blockerRows[0].payload ?? "{}") as {
        blockerReport?: { requestedActor?: string; requestedAction?: string; diagnosticsAttempted?: string[] };
      };
      c.assertEqual(
        payload.blockerReport?.requestedActor,
        "the platform operator",
        "the stored blocker names its external actor",
      );
      c.assert(
        payload.blockerReport?.requestedAction,
        "and the actionable requirement, so the page is answerable",
      );
      c.assertEqual(
        payload.blockerReport?.diagnosticsAttempted?.length,
        FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES,
        "and the diagnoses that earned it, so the decision is re-checkable later",
      );

      // Assert against the invariant's own vocabulary rather than a second
      // spelling of it: WFI-007 is the Epic item 6 rule this gate serves.
      const invariants = await checkWorkflowInvariants({ projectId: scope.projectId });
      c.assertEqual(
        invariants.counts.blockers,
        1,
        "the invariant snapshot sees the raised blocker (so the check below is not vacuous)",
      );
      c.assertEqual(
        (invariants.byInvariant["WFI-007"] ?? []).length,
        0,
        "WFI-007 holds: the active blocker names an external actor and a concrete requirement",
      );

      // The thresholds are the spec; pin them so a silent loosening is caught.
      c.assertEqual(FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES, 2, "two distinct diagnoses are required");
      c.assertEqual(FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS, 1, "after at least one earlier incident round");
    }

    // ------------------------------------------------------------------
    // C8 (Epic item 8) — the retry the downgrade asks for is BOUNDED.
    //
    // Its own project: the case above leaves a task In Progress, and PM's WIP
    // limit is one In Progress task per agent per project.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C8", "the browser retry is bounded by the execution episode");
      const scope = await forkWorldProject(db, world, { projectSlug: "c8-budget" });
      const task = await seedTask(db, scope, { title: "C8 bounded browser retries" });
      const turn = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });

      // One durable step opens the episode the browsing will be counted against.
      const opened = await turn.post("add_subtask", { subtaskText: "C8 retry the portal login" });
      c.assertEqual(opened.status, 202, "the turn banked a step and opened its episode");
      const episodeOne = await db.taskExecutionEpisode.findFirstOrThrow({
        where: { taskId: task.id, agentSlug: AGENT_SLUG },
        orderBy: { episodeNo: "asc" },
      });
      c.assertEqual(
        episodeOne.toolCycleBudget,
        TOOL_BUDGET,
        "the episode carries the scenario's tool budget",
      );

      // The gateway accepted the turn. Stream callbacks are refused for a run
      // still sitting in `queued`, so this production writer is what makes the
      // browser tool calls below legitimate rather than a bypass of the auth.
      await recordPmChannelRunDispatch({
        target: turn.target,
        result: { ok: true, status: 200, driver: "openclaw-pm-channel" },
      });

      // The boundary is at the budget, not before it: every call below the
      // budget is counted and leaves the episode OPEN. Asserting that is what
      // stops this case from passing on an episode that closed for some other
      // reason entirely.
      for (let call = 1; call <= TOOL_BUDGET; call += 1) {
        const streamed = await applyPmChannelStreamCallback({
          payload: {
            target: turn.target,
            event: "tool:call",
            toolName: "browser",
            toolStatus: "call",
          },
          rateLimit: false,
        });
        c.assertEqual(streamed.status, 200, `browser tool call ${call} was observed by PM`);
        const spending = await db.taskExecutionEpisode.findUniqueOrThrow({
          where: { id: episodeOne.id },
          select: { status: true, toolCycleCount: true },
        });
        c.assertEqual(spending.toolCycleCount, call, `PM counted browser tool call ${call}`);
        c.assertEqual(
          spending.status,
          call < TOOL_BUDGET ? "open" : "closed",
          `the episode is ${call < TOOL_BUDGET ? "still open below" : "closed at"} the budget after call ${call}`,
        );
      }

      const episodes = await db.taskExecutionEpisode.findMany({
        where: { taskId: task.id, agentSlug: AGENT_SLUG },
        orderBy: { episodeNo: "asc" },
      });
      c.assertEqual(episodes.length, 2, "the spent episode rolled over into a successor");
      c.assertEqual(episodes[0].status, "closed", "episode 1 is closed");
      c.assertEqual(
        episodes[0].closeReason,
        EPISODE_CLOSE_REASON.toolBudgetExhausted,
        "closed by the TOOL budget: browser work is the unit that actually grows a turn",
      );
      c.assertEqual(
        episodes[0].exhaustedByMessageId,
        turn.messageId,
        "the barrier is raised against the message that spent the budget",
      );
      c.assertEqual(episodes[1].episodeNo, 2, "the successor is episode 2");
      c.assertEqual(episodes[1].status, "open", "and it is open, so the task never lacks an episode");
      c.assertEqual(
        episodes[1].sessionKey,
        null,
        "the successor inherits no session: it is dispatched fresh, not resumed",
      );

      // THE BOUND. The fenced turn tries exactly what the downgrade told it to
      // do — browse more, then escalate — and the server refuses it outright.
      // Without this the "retry with a fresh session" guidance would be an
      // unbounded loop inside one ever-growing conversation.
      const fencedRetry = await turn.post("flag_blocker", {
        comment: "Still failing after more browsing.",
        blockerReport: {
          blockedOn: "external_service",
          requestedActor: "the platform operator",
          requestedAction: "Restore a working browser session on the runner.",
          evidence: BROWSER_EVIDENCE,
          diagnosticsAttempted: ["Retried in a fresh profile.", "Checked the runner's DNS."],
          resumeCondition: "The login form is interactable in a fresh browser session.",
          reporterCanResolve: false,
        },
      });
      c.assertEqual(fencedRetry.status, 409, "the exhausted turn cannot act on the task any more");
      c.assertEqual(
        fencedRetry.body.episodeBudgetExhausted,
        true,
        "the refusal names the episode budget as the reason",
      );
      c.assertEqual(fencedRetry.body.episodeClosed, true, "and says the episode is closed");
      c.assertEqual(
        await countActivity(task.id, "task.blocker.incident"),
        0,
        "a fenced turn never reaches the classifier, so nothing was recorded at all",
      );
      c.assertEqual(
        await countActivity(task.id, "task.blocker"),
        0,
        "and no blocker slipped through the fence",
      );

      // The stream boundary has already sealed a deterministic checkpoint and
      // aborted the oversized turn. A late agent-authored checkpoint must not
      // overwrite that durable handoff.
      const checkpointed = await turn.post("checkpoint", {
        completedWork: ["Reproduced the stale element reference three times."],
        evidence: [BROWSER_EVIDENCE],
        openChecklist: ["Escalate only with a second distinct diagnosis."],
        nextAction: "Re-run the portal login in a fresh profile and capture the network trace.",
        risks: ["The runner's browser image may be stale."],
      });
      c.assertEqual(checkpointed.status, 409, "the already-sealed turn cannot overwrite its checkpoint");
      c.assertEqual(
        checkpointed.body.episodeBudgetExhausted,
        true,
        "the refusal still names the episode boundary",
      );

      const sealed = await db.taskExecutionEpisode.findUniqueOrThrow({
        where: { id: episodes[0].id },
        select: { nextAction: true, barrierReleasedAt: true, successorScheduledAt: true },
      });
      c.assertIncludes(
        sealed.nextAction,
        "closed by tool_cycle_budget_exhausted",
        "the successor is briefed from PM's explicit bounded-handoff checkpoint",
      );
      c.assert(sealed.barrierReleasedAt, "the single-use barrier is consumed");
      c.assert(sealed.successorScheduledAt, "and the successor's dispatch is recorded");

      const rollover = await db.pmChannelContinuation.findMany({
        where: { taskId: task.id, action: EPISODE_ROLLOVER_CONTINUATION_ACTION },
      });
      c.assertEqual(rollover.length, 1, "exactly one successor turn was armed (WFI-001)");

      // Single-use means single-use: another checkpoint cannot overwrite the
      // bounded handoff episode 2 is about to receive.
      const duplicate = await turn.post("checkpoint", {
        nextAction: "A duplicate dispatch overwriting the real checkpoint.",
      });
      c.assertEqual(duplicate.status, 409, "the barrier is consumed: a second checkpoint is refused");
      const stillSealed = await db.taskExecutionEpisode.findUniqueOrThrow({
        where: { id: episodes[0].id },
        select: { nextAction: true },
      });
      c.assertIncludes(
        stillSealed.nextAction,
        "closed by tool_cycle_budget_exhausted",
        "the sealed checkpoint stands",
      );
    }

    // ------------------------------------------------------------------
    // C9 — a permission grant clears the blocker and resumes execution.
    //
    // The failure mode: a human clicks "grant", PM records it, and the agent is
    // woken twice — once by the grant's reserved continuation and once by a run
    // that was still live when the blocker was raised. Two turns in one lane is
    // WFI-001, and for a grant it is worse than a duplicate turn: the
    // authorization is single-use, so the second turn acts on a spent capability.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("C9", "a permission grant clears the blocker and resumes exactly once");
      const scope = await forkWorldProject(db, world, { projectSlug: "c9" });
      const task = await seedTask(db, scope, { title: "C9 permission blocker" });
      const turn = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });

      const scopeText = "Publish the staging config change so the live check can run.";
      const flagged = await turn.post("flag_blocker", {
        comment: "Only the reporter can authorize this publication; nothing on my side unblocks it.",
        permissionKind: "reporter_approval",
        permissionScope: scopeText,
      });
      c.assertEqual(flagged.status, 202, "a permission-only blocker is accepted without a retry ladder");
      c.assertEqual(flagged.body.flagged, "blocker", "the blocker was raised");
      c.assertEqual(
        flagged.body.actionEffect,
        "wait",
        "flagging a blocker ends the episode waiting on somebody else",
      );
      const blockerCommentId = flagged.body.commentId as string;
      c.assert(blockerCommentId, "the blocker is anchored to the exact comment the board links to");

      const pending = activeFormalBlockerStatesByTask(await lifecycleRows(task.id)).get(task.id);
      c.assert(pending, "the permission round is the active blocker");
      c.assertEqual(
        pending!.permissionRequest?.kind,
        "reporter_approval",
        "PM persisted the permission kind the grant will answer",
      );
      c.assertEqual(pending!.permissionRequest?.scope, scopeText, "and the exact scope");
      c.assertEqual(
        formalBlockerNeedsExternalInput(pending!),
        true,
        "before the grant, the round is genuinely waiting on a human",
      );
      c.assertEqual(
        (await readTaskProgress(db, task.id)).alertReporter,
        true,
        "the reporter is asked for the grant",
      );

      // PM nudged the agent again while it sat blocked — the ordinary monitor
      // wake. THIS is the run that historically produced the second resume.
      const nudge = await dispatchWorkflowTurn({ boot, world: scope, taskId: task.id });
      const nudged = await nudge.post("add_subtask", {
        subtaskText: "C9 work banked while blocked",
      });
      c.assertEqual(nudged.status, 202, "the nudge produced a live run");
      const beforeGrant = await readRunState(db, { taskId: task.id });
      const staleRun = beforeGrant.runs.find((row) => row.messageId === nudge.messageId);
      c.assert(staleRun, "the nudge's run is readable");
      c.assertEqual(
        beforeGrant.open.filter((row) => row.runId === staleRun!.id).length,
        1,
        "and it holds exactly one open continuation, which is the duplicate-resume risk",
      );

      // ---- the grant ------------------------------------------------------
      const granted = await applyBlockerPermissionGrant({
        taskId: task.id,
        projectId: scope.projectId,
        actorUserId: world.ownerId,
        assigneeSlug: AGENT_SLUG,
        blockerCommentId,
        permissionKind: "reporter_approval",
        permissionScope: scopeText,
        authorizationBody: `Authorized: ${scopeText}`,
      });
      c.assert(granted.granted, "the grant was applied");
      c.assert(
        granted.granted && granted.blockerCleared,
        "a reporter_approval round IS the dependency, so it closes at its grant",
      );

      const cleared = await readTaskProgress(db, task.id);
      c.assertEqual(cleared.alertReporter, false, "the reporter alert is discharged by the grant");
      c.assertEqual(cleared.status, "In Progress", "the task never left execution");
      c.assertEqual(
        await countActivity(task.id, "task.blocker.cleared"),
        1,
        "the clear is recorded exactly once",
      );
      c.assertEqual(
        activeFormalBlockersByTask(await lifecycleRows(task.id)).get(task.id) ?? null,
        null,
        "no active blocker remains on the task",
      );

      // ---- exactly one lane, exactly one reserved wake --------------------
      c.assert(
        granted.granted && granted.supersededRunIds.includes(staleRun!.id),
        "the competing run the nudge created was retired by the grant",
      );
      const afterGrant = await readRunState(db, { taskId: task.id });
      const retired = afterGrant.runs.find((row) => row.id === staleRun!.id);
      c.assertEqual(retired!.status, "superseded", "it is no longer active");
      c.assertEqual(
        retired!.finishedReason,
        BLOCKER_PERMISSION_SUPERSEDE_REASON,
        "and the supersede names the grant, so the cause is auditable",
      );
      c.assertEqual(
        afterGrant.active.length,
        0,
        "no run is left claiming the lane the resumed turn is about to take",
      );
      c.assertEqual(
        afterGrant.open.length,
        0,
        "and no orphaned continuation is left armed on a retired run",
      );
      for (const run of afterGrant.runs) {
        c.assert(
          run.disposition !== null,
          `every terminal run records a disposition (run ${run.id} did not) — WFI-005`,
        );
      }
      c.assertEqual(
        await countActivity(task.id, "task.blocker.permission.continuation"),
        1,
        "the grant reserved exactly ONE resume — the reservation is the exactly-once guarantee",
      );
      const reservation = await db.activityLog.findUniqueOrThrow({
        where: { id: blockerPermissionContinuationActivityId(blockerCommentId) },
        select: { payload: true, targetAgent: true },
      });
      c.assertEqual(reservation.targetAgent, AGENT_SLUG, "the reserved resume names the assignee");
      c.assertEqual(
        (JSON.parse(reservation.payload ?? "{}") as { authorizationCommentId?: string })
          .authorizationCommentId,
        granted.granted ? granted.authorizationCommentId : null,
        "and it is linked to this exact authorization, not to the blocker in general",
      );

      // ---- idempotence: a replayed grant wakes nobody a second time -------
      const ownerComments = await db.comment.count({
        where: { taskId: task.id, userId: world.ownerId },
      });
      const replay = await applyBlockerPermissionGrant({
        taskId: task.id,
        projectId: scope.projectId,
        actorUserId: world.ownerId,
        assigneeSlug: AGENT_SLUG,
        blockerCommentId,
        permissionKind: "reporter_approval",
        permissionScope: scopeText,
        authorizationBody: `Authorized again: ${scopeText}`,
      });
      c.assert(!replay.granted, "a replayed grant is refused");
      c.assertEqual(
        !replay.granted && replay.reason,
        "already_granted",
        "and says the round was already closed",
      );
      c.assertEqual(
        await countActivity(task.id, "task.blocker.permission.granted"),
        1,
        "still exactly one grant",
      );
      c.assertEqual(
        await countActivity(task.id, "task.blocker.permission.continuation"),
        1,
        "still exactly one wake — a duplicate grant cannot double-dispatch the agent",
      );
      c.assertEqual(
        await countActivity(task.id, "task.blocker.cleared"),
        1,
        "and still exactly one close event",
      );
      c.assertEqual(
        await db.comment.count({ where: { taskId: task.id, userId: world.ownerId } }),
        ownerComments,
        "the rolled-back replay left no orphan authorization comment behind",
      );

      // ---- the resume is actually taken, and only once --------------------
      const resumed = await dispatchWorkflowTurn({
        boot,
        world: scope,
        taskId: task.id,
        reason: "blocker_response",
        body: "Permission granted. Resume implementation.",
      });
      const resumedAction = await resumed.post("add_subtask", {
        subtaskText: "C9 work resumed after the grant",
      });
      c.assertEqual(resumedAction.status, 202, "the resumed turn advances the same task");
      c.assertEqual(
        resumedAction.body.actionEffect,
        "continue",
        "execution resumed INSIDE an episode rather than ending again",
      );

      const afterResume = await readRunState(db, { taskId: task.id });
      c.assertEqual(
        afterResume.active.length,
        1,
        "exactly one run is genuinely active: the resume is not duplicated",
      );
      c.assertEqual(
        afterResume.active[0].messageId,
        resumed.messageId,
        "and it is the resumed turn, not a survivor of the superseded one",
      );
      c.assertEqual(
        afterResume.open.length,
        1,
        "exactly one continuation lane is open, so the drain cannot dispatch twice",
      );
      const lanes = await checkWorkflowInvariants({ projectId: scope.projectId });
      c.assert(
        lanes.counts.runs >= 2,
        "the snapshot sees both the retired run and the resumed one (so the lane check is not vacuous)",
      );
      c.assertEqual(
        (lanes.byInvariant["WFI-001"] ?? []).filter((violation) =>
          violation.subjectId.includes(task.id),
        ).length,
        0,
        "WFI-001 holds for the task: at most one genuinely active run in the lane",
      );
      const progress = await readTaskProgress(db, task.id);
      c.assertEqual(progress.checklist, 2, "work banked before and after the grant both survive");

      // ---- a spent authorization is never inherited -----------------------
      //
      // Without this, one approval would silently authorize every later request
      // on the same task: the grant would be consumed twice over.
      const nextRound = await resumed.post("flag_blocker", {
        comment: "A second, unrelated owner-authorized action is required.",
        permissionKind: "reporter_approval",
        permissionScope: "Rotate the staging deploy key.",
      });
      c.assertEqual(nextRound.status, 202, "a fresh permission round can be raised");
      const fresh = activeFormalBlockerStatesByTask(await lifecycleRows(task.id)).get(task.id);
      c.assert(fresh, "the new round is the active blocker");
      c.assert(
        fresh!.commentId !== blockerCommentId,
        "it is a different round from the one already granted",
      );
      c.assertEqual(
        fresh!.permissionGrant,
        null,
        "the spent authorization is not inherited: no double consumption",
      );
      c.assertEqual(
        formalBlockerNeedsExternalInput(fresh!),
        true,
        "so the new round waits on the reporter, exactly like the first",
      );
    }

    // The effect table both cases lean on. A regression here would make every
    // assertion above pass for the wrong reason.
    {
      const c: ScenarioCase = report.case("C8-C9", "the blocker actions still classify as episode-terminal waits");
      c.assertEqual(
        actionEffect.workflowActionEffect("flag_blocker"),
        "wait",
        "raising a blocker waits on somebody else",
      );
      c.assertEqual(
        actionEffect.workflowActionDisposition("flag_blocker"),
        "waiting_external",
        "and its disposition says the turn ended waiting, not completed",
      );
      c.assertEqual(
        actionEffect.workflowActionEffect("clear_blocker"),
        "continue",
        "clearing a blocker is a step INSIDE the resumed episode",
      );
      c.assertEqual(
        actionEffect.workflowActionEffect("checkpoint"),
        "continue",
        "and a checkpoint is durability bought mid-episode, not the end of a turn",
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
