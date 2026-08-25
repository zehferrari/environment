// ENV-150 — Step 1: Human status-override command contract.
//
// Focused, pure-function tests for the typed override_status intent without
// touching a database. Verifies the full contract surface wired in Step 1:
//
//   - Schema: validateCommandPayload accepts every legal workflow status and
//     rejects non-status / malformed reason (invalid_payload).
//   - Normalize: buildPayload maps the override_status public action and
//     accepts/rejects the same status vocabulary.
//   - Authorization: authorizeCommand allows only human actors
//     (decisionActorId = actor, executorActorId = null); rejects every
//     agent/mechanical actor with reason "human_required"; rejects monitor
//     with "monitor_cannot_decide" before the human check.
//   - Guards: runGuards enforces the workflow-version CAS for
//     override_status and deliberately bypasses edge/plan/cycle/blocker/
//     repository guards, so a human may override from any status.
//   - Decide: decideCommand maps override_status to kernelIntent
//     "operator_override", cycleOperation "none", a board_touch effect, and
//     records humanStatusOverride evidence + decision/executor actor.
//
// Mirrors the PHASEE-03 table-driven conventions: node:assert/strict,
// execFile (promisified) for the Prisma schema deploy when a disposable DB
// is needed, and dynamic type imports after DATABASE_URL is set. Pure
// contract functions are imported after the env var is set so no live DB is
// ever bound. Exit 0 on success, non-zero on the first failed assertion.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const WORKFLOW_STATUSES = ["Backlog", "To Do", "In Progress", "Review", "Done"] as const;

type ActorRole = "reporter" | "reviewer" | "assignee" | "monitor" | "admin" | null;

interface TestActor {
  id: string;
  kind: "human" | "agent";
  username: string;
  role: ActorRole;
  codingCapability?: boolean;
}

function makeBaseState(): Record<string, unknown> {
  return {
    id: "task-1",
    status: "Review",
    workflowVersion: 7,
    projectId: "proj-1",
    epicId: "epic-1",
    assigneeId: "assignee",
    actingManagerId: "actingmgr",
    reporterId: "reporter",
    approvedOn: new Date(),
    approvedById: "actingmgr",
    activeWorkflowCycleId: "c1",
    resolvedReviewOwnerId: "actingmgr",
    activeReviewRun: null,
    repositoryRun: null,
    project: {
      onlyReportersCanApproveActionPlans: false,
      onlyReportersCanSetTasksDone: false,
      repositoryPath: "/srv/Code/test",
    },
    epic: { status: "In Progress", actingManagerId: "actingmgr" },
    unresolvedPrerequisites: [],
    otherInProgressTaskForAssignee: null,
    otherInProgressTaskOnBranch: null,
    openChecklist: { count: 0, ids: [] },
    activeBlocker: null,
    actionPlan: null,
  };
}

function makeState(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...makeBaseState(), ...overrides };
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  const assertOk = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  // --- Payload schema (validateCommandPayload) --------------------------------
  console.log("\n=== Override Status: Payload Schema Tests ===");
  try {
    const { validateCommandPayload } = await import("@/lib/tasks/orchestrator/command-schema");

    // Every legal status is accepted.
    for (const target of WORKFLOW_STATUSES) {
      const res = validateCommandPayload("override_status", { targetStatus: target, reason: "manual fix" });
      assert.equal(res.ok, true, `override_status should accept targetStatus ${target}`);
      assert.equal((res as any).payload.targetStatus, target, `payload.targetStatus should be ${target}`);
      assert.equal((res as any).payload.reason, "manual fix", "reason should be preserved");
    }

    // A null reason is accepted (optional).
    const noReason = validateCommandPayload("override_status", { targetStatus: "Done" });
    assert.equal(noReason.ok, true, "override_status should accept missing reason");
    assert.equal("reason" in (noReason as any).payload, false, "reason should be omitted when absent");

    // An explicitly null reason is treated as omitted.
    const nullReason = validateCommandPayload("override_status", { targetStatus: "Backlog", reason: null });
    assert.equal(nullReason.ok, true, "override_status should accept null reason");

    // Invalid statuses are rejected.
    for (const bad of ["todo", "done", "In-Progress", "", 42, null, undefined]) {
      const res = validateCommandPayload("override_status", { targetStatus: bad });
      assert.equal(res.ok, false, `targetStatus ${JSON.stringify(bad)} should be rejected`);
      assert.equal((res as any).code, "invalid_payload", "bad status should fail with invalid_payload");
    }

    // Non-object payload rejected.
    const notObject = validateCommandPayload("override_status", "Done" as any);
    assert.equal(notObject.ok, false, "non-object payload should be rejected");

    // Untrusted client-resolved field is rejected (workflowVersion is server-resolved).
    const untrusted = validateCommandPayload("override_status", {
      targetStatus: "Done",
      workflowVersion: 999,
    });
    assert.equal(untrusted.ok, false, "client-supplied workflowVersion should be rejected");

    console.log(`  Schema: all ${WORKFLOW_STATUSES.length} statuses accepted, invalid + untrusted rejected ✓`);
    passed += WORKFLOW_STATUSES.length + 5;
  } catch (e) {
    failed++;
    console.error(`FAIL [schema]: ${(e as Error).message}`);
  }

  // --- Normalize (public action -> intent + payload) --------------------------
  console.log("\n=== Override Status Normalize Tests ===");
  try {
    const { PUBLIC_ACTION_TO_INTENT, normalizePublicAction } = await import("@/lib/tasks/orchestrator/normalize");

    // The public action maps to the canonical intent.
    assert.equal(PUBLIC_ACTION_TO_INTENT.get("override_status"), "override_status", "public action maps to intent");

    // normalizePublicAction produces a typed command for a human actor.
    const normalized = normalizePublicAction(
      "override_status" as any,
      { targetStatus: "Done", reason: "manual fix" },
      {
        taskId: "task-1",
        actorId: "human-1",
        actorKind: "human",
        actorUsername: "zeh",
        actorRole: "reporter",
        expectedWorkflowVersion: 7,
        workflowCycleId: null,
        idempotencyKey: "idem-1",
        messageId: null,
        source: "operator",
      },
    );
    assert.ok(normalized.ok, "normalizePublicAction should succeed for a human override");
    const ncmd = (normalized as any).command;
    assert.equal(ncmd.intent, "override_status", "intent is override_status");
    assert.equal(ncmd.payload.targetStatus, "Done", "payload targetStatus preserved");
    assert.equal(ncmd.payload.reason, "manual fix", "payload reason preserved");

    // An invalid status is rejected at normalize time too.
    const badNormalize = normalizePublicAction(
      "override_status" as any,
      { targetStatus: "InProgress" },
      {
        taskId: "task-1",
        actorId: "human-1",
        actorKind: "human",
        actorUsername: "zeh",
        actorRole: "reporter",
        expectedWorkflowVersion: 7,
        workflowCycleId: null,
        idempotencyKey: "idem-2",
        messageId: null,
        source: "operator",
      } as any,
    );
    assert.equal(badNormalize.ok, false, "normalize should reject an invalid status");
    assert.equal((badNormalize as any).code, "invalid_payload", "invalid status -> invalid_payload");

    console.log("  Normalize: action->intent map, typed payload, invalid status rejected ✓");
    passed += 4;
  } catch (e) {
    failed++;
    console.error(`FAIL [normalize]: ${(e as Error).message}`);
  }

  // --- Authorization (human-only, monitor cannot decide) ----------------------
  console.log("\n=== Override Status Authorization Tests ===");
  try {
    const { authorizeCommand } = await import("@/lib/tasks/orchestrator/authorize");

    const humanActor: TestActor = { id: "human-1", kind: "human", username: "zeh", role: "reporter" };
    const agentActor: TestActor = { id: "agent-1", kind: "agent", username: "barekbaal", role: "assignee", codingCapability: true };
    const monitorActor: TestActor = { id: "mon-1", kind: "agent", username: "monitor", role: "monitor" };
    const adminHumanActor: TestActor = { id: "admin-1", kind: "human", username: "admin", role: "admin" };
    const assigneeActor: TestActor = { id: "assignee", kind: "agent", username: "agent", role: "assignee", codingCapability: true };
    const reporterHumanActor: TestActor = { id: "reporter", kind: "human", username: "reporter", role: "reporter" };

    // Human (reporter) is allowed; decision actor is the human, executor null.
    const humanRes = authorizeCommand(makeState({}) as any, {
      intent: "override_status",
      actor: humanActor as any,
    });
    assert.equal(humanRes.allowed, true, "human reporter should be allowed");
    assert.equal(humanRes.reason, "ok", "reason ok");
    assert.equal(humanRes.decisionActorId, "human-1", "decision actor is the human");
    assert.equal(humanRes.executorActorId, null, "no mechanical executor for human override");

    // Human admin is also allowed (kind is the deciding factor, not role).
    const adminAllowed = authorizeCommand(makeState({}) as any, {
      intent: "override_status",
      actor: adminHumanActor as any,
    });
    assert.equal(adminAllowed.allowed, true, "human admin should be allowed");

    // Every agent actor is rejected with human_required regardless of role.
    const agentRes = authorizeCommand(makeState({}) as any, {
      intent: "override_status",
      actor: agentActor as any,
    });
    assert.equal(agentRes.allowed, false, "agent should be rejected");
    assert.equal(agentRes.reason, "human_required", "agent rejection reason is human_required");
    assert.equal(agentRes.decisionActorId, null, "no decision actor for rejected agent");
    assert.equal(agentRes.executorActorId, null, "no executor for rejected agent");

    // Monitor is rejected with monitor_cannot_decide (monitor check precedes human check).
    const monitorRes = authorizeCommand(makeState({}) as any, {
      intent: "override_status",
      actor: monitorActor as any,
    });
    assert.equal(monitorRes.allowed, false, "monitor should be rejected");
    assert.equal(monitorRes.reason, "monitor_cannot_decide", "monitor rejection reason is monitor_cannot_decide");

    // Admin agent (kind agent) is STILL rejected — human kind, not role, is the gate.
    const adminAgent: TestActor = { id: "admin-a", kind: "agent", username: "admin", role: "admin" };
    const adminAgentRes = authorizeCommand(makeState({}) as any, {
      intent: "override_status",
      actor: adminAgent as any,
    });
    assert.equal(adminAgentRes.allowed, false, "admin-role agent should still be rejected");
    assert.equal(adminAgentRes.reason, "human_required", "agent admin rejection reason is human_required");

    const ordinaryBlockerState = makeState({
      activeBlocker: {
        commentId: "ordinary-blocker",
        permissionRequest: null,
        permissionGrant: null,
        override: null,
      },
    });
    const assigneeClear = authorizeCommand(ordinaryBlockerState as any, {
      intent: "clear_blocker",
      actor: assigneeActor as any,
    });
    assert.equal(assigneeClear.allowed, true, "assignee may clear an ordinary agent-raised blocker");
    const reporterOrdinaryClear = authorizeCommand(ordinaryBlockerState as any, {
      intent: "clear_blocker",
      actor: reporterHumanActor as any,
    });
    assert.equal(reporterOrdinaryClear.allowed, false, "non-assignee reporter may not clear an ordinary blocker");
    assert.equal(reporterOrdinaryClear.reason, "not_assignee", "ordinary blocker retains assignee authorization");

    const waitForHumanBlockerState = makeState({
      activeBlocker: {
        commentId: "wait-for-human-blocker",
        permissionRequest: null,
        permissionGrant: null,
        override: { kind: "wait_for_human", targetStatus: "In Progress", reason: null },
      },
    });
    const agentWaitClear = authorizeCommand(waitForHumanBlockerState as any, {
      intent: "clear_blocker",
      actor: assigneeActor as any,
    });
    assert.equal(agentWaitClear.allowed, false, "assignee may not clear a wait-for-human override blocker");
    assert.equal(agentWaitClear.reason, "human_required", "override blocker requires a human");
    const reporterWaitClear = authorizeCommand(waitForHumanBlockerState as any, {
      intent: "clear_blocker",
      actor: reporterHumanActor as any,
    });
    assert.equal(reporterWaitClear.allowed, true, "authorized human may clear a wait-for-human override blocker");

    console.log("  Auth: override is human-only; ordinary blockers remain assignee-clearable ✓");
    passed += 13;
  } catch (e) {
    failed++;
    console.error(`FAIL [auth]: ${(e as Error).message}`);
  }

  // --- Guards: version CAS + deliberate bypass ---------------------------------
  console.log("\n=== Override Status Guard Tests ===");
  try {
    const { runGuards, guardWorkflowVersion } = await import("@/lib/tasks/orchestrator/guards");

    // Version CAS: stale version is rejected, matching version passes.
    const stale = runGuards(makeState({ workflowVersion: 7 }) as any, {
      intent: "override_status",
      expectedWorkflowVersion: 6,
    });
    assert.equal(stale.ok, false, "stale expected version should be rejected");
    assert.equal((stale as any).status, "stale", "stale status is 'stale'");
    assert.ok((stale as any).reason.includes("stale_version"), "reason mentions stale_version");

    const fresh = runGuards(makeState({ workflowVersion: 7 }) as any, {
      intent: "override_status",
      expectedWorkflowVersion: 7,
    });
    assert.equal(fresh.ok, true, "matching expected version should pass");

    // Deliberate bypass: override_status passes ordinary edge/plan/blocker/WIP
    // preconditions. It may remain inside the active lifecycle while
    // repository work runs, but it may not abandon that lifecycle to Done.
    const blockedState = makeState({
      status: "In Progress",
      approvedOn: null, // no approved plan
      unresolvedPrerequisites: [{ id: "p1", title: "Dep", status: "To Do" }],
      otherInProgressTaskForAssignee: { id: "t2", title: "Other", status: "In Progress" },
      otherInProgressTaskOnBranch: { id: "t3", title: "Branch", status: "In Progress" },
      openChecklist: { count: 3, ids: ["s1", "s2", "s3"] },
      activeBlocker: {
        commentId: "c-block",
        raisedAt: new Date(),
        report: { blockedOn: "decision", requestedActor: "zeh", requestedAction: "decide", evidence: "e", diagnosticsAttempted: [], resumeCondition: "human decision", reporterCanResolve: true },
        permissionRequest: { kind: "publish_checkpoint", scope: "x" },
        permissionGrant: null,
        override: null,
      },
      repositoryRun: { phase: "validating" },
      activeWorkflowCycleId: "c1",
    });
    const blockedGuard = runGuards(blockedState as any, {
      intent: "override_status",
      expectedWorkflowVersion: 7,
      payload: { targetStatus: "Review" },
    });
    assert.equal(blockedGuard.ok, true, "override_status may remain inside the active lifecycle");

    const unsafeDone = runGuards(blockedState as any, {
      intent: "override_status",
      expectedWorkflowVersion: 7,
      payload: { targetStatus: "Done" },
    });
    assert.equal(unsafeDone.ok, false, "override_status cannot abandon active repository work");
    assert.ok((unsafeDone as any).reason.includes("repository lifecycle"), "rejection names the active lifecycle");

    // The version guard is still authoritative even under the bypass.
    const blockedStale = runGuards(blockedState as any, {
      intent: "override_status",
      expectedWorkflowVersion: 1,
    });
    assert.equal(blockedStale.ok, false, "override_status must still enforce the version CAS even when bypassing other guards");

    // Wait-for-human blocker (permissionRequest null, raised by a human status
    // override) must refuse ordinary agent workflow intents so the assigned
    // agent stops until a human clears it. This is the fence that makes the
    // override blocker actionable.
    const waitForHumanState = makeState({
      status: "In Progress",
      approvedOn: new Date(),
      activeWorkflowCycleId: "c1",
      activeBlocker: {
        commentId: "c-wfh",
        raisedAt: new Date(),
        report: {
          blockedOn: "decision",
          requestedActor: "human owner",
          requestedAction: "Provide explicit instructions and clear the wait-for-human blocker with clear_blocker.",
          evidence: "human status override",
          diagnosticsAttempted: ["Confirmed the blocker came from a human status override."],
          resumeCondition: "human decision",
          reporterCanResolve: true,
        },
        permissionRequest: null,
        permissionGrant: null,
        override: { kind: "wait_for_human", targetStatus: "In Progress", reason: null },
      },
    });
    const agentRefused = runGuards(waitForHumanState as any, {
      intent: "submit_for_review",
      expectedWorkflowVersion: 7,
    });
    assert.equal(agentRefused.ok, false, "agent submit_for_review must be refused while a wait-for-human blocker is active");
    assert.ok((agentRefused as any).reason.includes("blocker_unresolved"), "refusal reason names blocker_unresolved");

    // clear_blocker and override_status are human-authoritative and must not be
    // blocked by the wait-for-human blocker guard.
    const clearOk = runGuards(waitForHumanState as any, {
      intent: "clear_blocker",
      expectedWorkflowVersion: 7,
    });
    assert.equal(clearOk.ok, true, "clear_blocker must be allowed while a wait-for-human blocker is active");
    const overrideOk = runGuards(waitForHumanState as any, {
      intent: "override_status",
      expectedWorkflowVersion: 7,
    });
    assert.equal(overrideOk.ok, true, "override_status must be allowed while a wait-for-human blocker is active");

    const ordinaryBlockerState = makeState({
      status: "In Progress",
      approvedOn: new Date(),
      activeWorkflowCycleId: "c1",
      activeBlocker: {
        commentId: "c-ordinary",
        permissionRequest: null,
        permissionGrant: null,
        override: null,
      },
    });
    const ordinarySubmit = runGuards(ordinaryBlockerState as any, {
      intent: "submit_for_review",
      expectedWorkflowVersion: 7,
      workflowCycleId: "c1",
    });
    assert.equal(ordinarySubmit.ok, true, "ordinary agent blocker does not widen submit_for_review guards");
    const ordinaryClear = runGuards(ordinaryBlockerState as any, {
      intent: "clear_blocker",
      expectedWorkflowVersion: 7,
      workflowCycleId: "c1",
    });
    assert.equal(ordinaryClear.ok, true, "ordinary blocker remains clearable inside its active cycle");
    const ordinaryClearWithoutCycle = runGuards(
      makeState({ ...ordinaryBlockerState, activeWorkflowCycleId: null }) as any,
      { intent: "clear_blocker", expectedWorkflowVersion: 7, workflowCycleId: null },
    );
    assert.equal(ordinaryClearWithoutCycle.ok, false, "ordinary blocker clear retains the active-cycle guard");

    const grantedPermissionState = makeState({
      status: "In Progress",
      approvedOn: new Date(),
      activeWorkflowCycleId: "c1",
      activeBlocker: {
        commentId: "c-permission",
        permissionRequest: { kind: "publish_checkpoint", scope: "publish phase-e" },
        permissionGrant: { authorizationCommentId: "grant-1", grantedAt: new Date() },
        override: null,
      },
    });
    const grantedSubmit = runGuards(grantedPermissionState as any, {
      intent: "submit_for_review",
      expectedWorkflowVersion: 7,
      workflowCycleId: "c1",
    });
    assert.equal(grantedSubmit.ok, true, "granted permission round is agent-actionable, not unresolved");

    const backlogWaitState = makeState({
      status: "Backlog",
      activeWorkflowCycleId: null,
      activeBlocker: {
        commentId: "c-backlog-wfh",
        permissionRequest: null,
        permissionGrant: null,
        override: { kind: "wait_for_human", targetStatus: "Backlog", reason: null },
      },
    });
    const backlogClear = runGuards(backlogWaitState as any, {
      intent: "clear_blocker",
      expectedWorkflowVersion: 7,
      workflowCycleId: null,
    });
    assert.equal(backlogClear.ok, true, "Backlog override blocker is human-clearable without an agent cycle");

    console.log("  Guards: version CAS enforced, edge/plan/blocker/WIP/repository deliberately bypassed ✓");
    console.log("  Guards: override blockers fully fence; ordinary/granted blocker paths retain parity ✓");
    passed += 13;
  } catch (e) {
    failed++;
    console.error(`FAIL [guards]: ${(e as Error).message}`);
  }

  // --- Persisted blocker marker and report validity --------------------------
  console.log("\n=== Override Blocker Metadata Tests ===");
  try {
    const {
      blockerMetadataFromPayload,
      validateFormalBlockerReport,
    } = await import("@/lib/tasks/formal-blocker");
    const blockerReport = {
      blockedOn: "decision",
      requestedActor: "human owner",
      requestedAction: "Provide explicit instructions and clear the wait-for-human blocker.",
      evidence: "Human status override to Review recorded as an authoritative decision.",
      diagnosticsAttempted: [
        "Confirmed this blocker was created by an authoritative human status override.",
      ],
      resumeCondition: "An authorized human clears the wait-for-human blocker.",
      reporterCanResolve: true,
    };
    const metadata = blockerMetadataFromPayload(JSON.stringify({
      commentId: "comment-1",
      blockerReport,
      permissionRequest: null,
      override: { kind: "wait_for_human", targetStatus: "Review", reason: "manual priority" },
    }));
    assert.equal(metadata.override?.kind, "wait_for_human", "override marker survives payload parsing");
    assert.equal(metadata.override?.targetStatus, "Review", "override target status survives payload parsing");
    assert.equal(metadata.override?.reason, "manual priority", "override reason survives payload parsing");
    assert.equal(validateFormalBlockerReport(metadata.report).ok, true, "synthesized override report revalidates");
    console.log("  Marker: wait_for_human metadata survives aggregate parsing and report revalidation ✓");
    passed += 4;
  } catch (e) {
    failed++;
    console.error(`FAIL [blocker metadata]: ${(e as Error).message}`);
  }

  // --- Decide: transition + cycle + effect -------------------------------------------------
  console.log("\n=== Override Status Decide Tests ===");
  try {
    const { decideCommand } = await import("@/lib/tasks/orchestrator/decide");

    const state = makeState({ status: "Review", workflowVersion: 7 }) as any;
    const decision = decideCommand(
      state,
      {
        intent: "override_status",
        actor: { id: "human-1", username: "zeh" },
        payload: { targetStatus: "Done", reason: "human confirmed completion" },
      },
      { allowed: true, reason: "ok", decisionActorId: "human-1", executorActorId: null },
    ) as any;

    assert.equal(decision.status, undefined, "decision is not an error");
    assert.equal(decision.fromStatus, "Review", "fromStatus is current status");
    assert.equal(decision.toStatus, "Done", "toStatus is target");
    assert.equal(decision.kernelIntent, "operator_override", "kernelIntent is operator_override");
    assert.equal(decision.cycleOperation, "close", "Done closes the stale active cycle");
    assert.equal(decision.cycleOutcome, "abandoned", "human override never fabricates review completion");
    assert.equal(decision.decisionActorId, "human-1", "decision actor is the human");
    assert.equal(decision.executorActorId, null, "no mechanical executor");
    assert.equal(decision.evidence.humanStatusOverride, true, "evidence flags humanStatusOverride");
    assert.equal(decision.evidence.reason, "human confirmed completion", "evidence carries the reason");
    assert.ok(
      decision.effects.some((e: any) => e.type === "board_touch" && e.key === "board-status-override"),
      "a board_touch effect with key board-status-override is declared",
    );

    // Invalid target status -> DecisionError.
    const bad = decideCommand(
      state,
      { intent: "override_status", actor: { id: "human-1", username: "zeh" }, payload: { targetStatus: "Todo" } },
      { allowed: true, reason: "ok", decisionActorId: "human-1", executorActorId: null },
    ) as any;
    assert.equal(bad.status, "invalid", "invalid target status yields a DecisionError");

    console.log("  Decide: operator_override kernel, lifecycle-safe close, board_touch effect, actor evidence ✓");
    passed += 9;
  } catch (e) {
    failed++;
    console.error(`FAIL [decide]: ${(e as Error).message}`);
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("All ENV-150 override contract tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
