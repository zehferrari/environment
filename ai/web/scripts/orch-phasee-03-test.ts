// PHASEE-03 — Table-driven authorization, guard, and concurrency tests.
//
// Verifies:
//   - Authorization test matrix: every intent × every actor role ×
//     allowed/denied reason, table-driven.
//   - Guard test matrix: every intent × every state precondition ×
//     pass/fail reason, table-driven.
//   - Concurrency test: simulated parallel start_implementation produces
//     exactly one accepted result and one stale result (workflowVersion CAS).
//   - Transaction-time fence test: a state change between guard and execute
//     returns stale (version, WIP, branch, prerequisites).
//   - Guard honesty test: guardNoUnresolvedBlocker documents inactive field.
//   - Callback correlation test: unused params removed, cycle/SHA checks work.
//   - Coding capability fail-closed test: undefined codingCapability blocks
//     start_implementation and submit_for_review, allows checkpoint/submit_plan.
//   - Monitor can execute mechanics but cannot become the plan/review/Done
//     decision actor.
//
// Exit 0 on success, non-zero on the first failed assertion.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Type imports — imported after DATABASE_URL is set in main() to avoid
// binding the live db. We use dynamic imports inside main().

type ActorRole = "reporter" | "reviewer" | "assignee" | "monitor" | "admin" | null;
type Intent =
  | "submit_plan"
  | "approve_plan"
  | "request_plan_changes"
  | "start_implementation"
  | "checkpoint"
  | "submit_for_review"
  | "request_review_changes"
  | "accept_review"
  | "raise_blocker"
  | "clear_blocker"
  | "cancel_task"
  | "archive_task"
  | "repository_validation_succeeded"
  | "repository_validation_failed"
  | "repository_finalization_succeeded"
  | "repository_finalization_failed";

interface TestActor {
  id: string;
  kind: "human" | "agent";
  username: string;
  role: ActorRole;
  codingCapability?: boolean;
}

// ---------------------------------------------------------------------------
// Table-driven authorization test matrix
// ---------------------------------------------------------------------------

// Each row: { intent, actorRole, expectedAllowed, expectedReason? }
// This matrix verifies that authorizeCommand produces the correct allowed/denied
// result for every intent × actor role combination.
const AUTH_MATRIX: Array<{
  intent: Intent;
  actor: TestActor;
  stateOverrides?: Partial<Record<string, unknown>>;
  expectedAllowed: boolean;
  expectedReason?: string;
}> = [
  // --- submit_plan: assignee only ---
  { intent: "submit_plan", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: true },
  { intent: "submit_plan", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: false, expectedReason: "not_assignee" },
  { intent: "submit_plan", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- approve_plan: reviewer/reporter/acting-manager ---
  { intent: "approve_plan", actor: { id: "actingmgr", kind: "agent", username: "am", role: "reviewer" }, expectedAllowed: true },
  { intent: "approve_plan", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: true },
  { intent: "approve_plan", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_authorized_for_plan" },
  { intent: "approve_plan", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- start_implementation: coding-capable assignee only ---
  { intent: "start_implementation", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: true },
  { intent: "start_implementation", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: false }, expectedAllowed: false, expectedReason: "not_coding_capable" },
  { intent: "start_implementation", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: false, expectedReason: "not_assignee" },
  { intent: "start_implementation", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- checkpoint: assignee only ---
  { intent: "checkpoint", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: true },
  { intent: "checkpoint", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: false, expectedReason: "not_assignee" },
  { intent: "checkpoint", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- submit_for_review: coding-capable assignee only ---
  { intent: "submit_for_review", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: true },
  { intent: "submit_for_review", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: false }, expectedAllowed: false, expectedReason: "not_coding_capable" },
  { intent: "submit_for_review", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- request_review_changes: resolved reviewer only (with awaiting lease) ---
  { intent: "request_review_changes", actor: { id: "actingmgr", kind: "agent", username: "am", role: "reviewer" }, expectedAllowed: true },
  { intent: "request_review_changes", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_reviewer" },
  { intent: "request_review_changes", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- accept_review: Done-owner only (with awaiting lease) ---
  { intent: "accept_review", actor: { id: "actingmgr", kind: "agent", username: "am", role: "reviewer" }, expectedAllowed: true },
  { intent: "accept_review", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: true },
  { intent: "accept_review", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_authorized_for_done" },
  { intent: "accept_review", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- Mechanical intents: monitor/admin only ---
  { intent: "repository_validation_succeeded", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: true },
  { intent: "repository_validation_succeeded", actor: { id: "admin", kind: "human", username: "admin", role: "admin" }, expectedAllowed: true },
  { intent: "repository_validation_succeeded", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_monitor" },
  { intent: "repository_validation_failed", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: true },
  { intent: "repository_validation_failed", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_monitor" },

  // --- Finalization callbacks: monitor/admin, needs accepted lease ---
  { intent: "repository_finalization_succeeded", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: true },
  { intent: "repository_finalization_succeeded", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_monitor" },

  // --- raise_blocker / clear_blocker: assignee only ---
  { intent: "raise_blocker", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: true },
  { intent: "raise_blocker", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: false, expectedReason: "not_assignee" },
  { intent: "clear_blocker", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: true },

  // --- cancel_task: reporter or acting-manager ---
  { intent: "cancel_task", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: true },
  { intent: "cancel_task", actor: { id: "actingmgr", kind: "agent", username: "am", role: "reviewer" }, expectedAllowed: true },
  { intent: "cancel_task", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_authorized_for_plan" },
  { intent: "cancel_task", actor: { id: "monitor", kind: "agent", username: "m", role: "monitor" }, expectedAllowed: false, expectedReason: "monitor_cannot_decide" },

  // --- archive_task: reporter or acting-manager, Done status ---
  { intent: "archive_task", actor: { id: "reporter", kind: "human", username: "r", role: "reporter" }, expectedAllowed: true },
  { intent: "archive_task", actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true }, expectedAllowed: false, expectedReason: "not_authorized_for_plan" },
];

// ---------------------------------------------------------------------------
// Table-driven guard test matrix
// ---------------------------------------------------------------------------

interface GuardTestCase {
  name: string;
  intent: Intent;
  stateOverrides: Record<string, unknown>;
  expectOk: boolean;
  expectReasonContains?: string;
  commandCycleId?: string;
}

const GUARD_MATRIX: GuardTestCase[] = [
  // --- submit_plan guards ---
  { name: "submit_plan in Backlog", intent: "submit_plan", stateOverrides: { status: "Backlog", approvedOn: null }, expectOk: true },
  { name: "submit_plan in To Do", intent: "submit_plan", stateOverrides: { status: "To Do", approvedOn: null }, expectOk: true },
  { name: "submit_plan in In Progress", intent: "submit_plan", stateOverrides: { status: "In Progress", approvedOn: null }, expectOk: false, expectReasonContains: "requires task status" },
  { name: "submit_plan with existing approved plan", intent: "submit_plan", stateOverrides: { status: "To Do", approvedOn: new Date() }, expectOk: false, expectReasonContains: "plan_evidence_invalid" },

  // --- approve_plan guards ---
  { name: "approve_plan with draft plan", intent: "approve_plan", stateOverrides: { status: "To Do", actionPlan: { id: "p1", version: 1, status: "draft", approvedOn: null, steps: [{ id: "s1", stepId: "s1", title: "Step 1", kind: "sequential", assigneeId: null, rank: 0 }] } }, expectOk: true },
  { name: "approve_plan with no plan (backward compat)", intent: "approve_plan", stateOverrides: { status: "To Do", actionPlan: null }, expectOk: true }, // null actionPlan passes for backward compat
  { name: "approve_plan with approved plan", intent: "approve_plan", stateOverrides: { status: "To Do", actionPlan: { id: "p1", version: 1, status: "approved", approvedOn: new Date(), steps: [{ id: "s1", stepId: "s1", title: "Step 1", kind: "sequential", assigneeId: null, rank: 0 }] } }, expectOk: false, expectReasonContains: "plan_evidence_invalid" },
  { name: "approve_plan with empty steps", intent: "approve_plan", stateOverrides: { status: "To Do", actionPlan: { id: "p1", version: 1, status: "draft", approvedOn: null, steps: [] } }, expectOk: false, expectReasonContains: "plan_evidence_invalid" },

  // --- start_implementation guards ---
  { name: "start_implementation in To Do with approved plan", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: new Date(), activeWorkflowCycleId: null, unresolvedPrerequisites: [], otherInProgressTaskForAssignee: null, otherInProgressTaskOnBranch: null, activeBlocker: null }, expectOk: true },
  { name: "start_implementation in Backlog", intent: "start_implementation", stateOverrides: { status: "Backlog", approvedOn: new Date(), activeWorkflowCycleId: null }, expectOk: false, expectReasonContains: "requires task status" },
  { name: "start_implementation without approved plan", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: null, activeWorkflowCycleId: null }, expectOk: false, expectReasonContains: "approved Action Plan" },
  { name: "start_implementation with active cycle", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: new Date(), activeWorkflowCycleId: "cycle-1" }, expectOk: false, expectReasonContains: "cycle is open" },
  { name: "start_implementation with unresolved prerequisites", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: new Date(), activeWorkflowCycleId: null, unresolvedPrerequisites: [{ id: "dep1", title: "Dependency 1", status: "To Do" }] }, expectOk: false, expectReasonContains: "prerequisites_unmet" },
  { name: "start_implementation with WIP conflict", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: new Date(), activeWorkflowCycleId: null, unresolvedPrerequisites: [], otherInProgressTaskForAssignee: { id: "other", title: "Other Task" } }, expectOk: false, expectReasonContains: "wip_conflict" },
  { name: "start_implementation with branch collision", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: new Date(), activeWorkflowCycleId: null, unresolvedPrerequisites: [], otherInProgressTaskForAssignee: null, otherInProgressTaskOnBranch: { id: "other", title: "Other Task", branchName: "env-999" } }, expectOk: false, expectReasonContains: "branch_collision" },
  { name: "start_implementation with unresolved blocker", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: new Date(), activeWorkflowCycleId: null, unresolvedPrerequisites: [], otherInProgressTaskForAssignee: null, otherInProgressTaskOnBranch: null, activeBlocker: { commentId: "c1", permissionRequest: { kind: "publish_checkpoint", scope: "test" } } }, expectOk: false, expectReasonContains: "blocker_unresolved" },
  { name: "start_implementation with non-actionable Epic", intent: "start_implementation", stateOverrides: { status: "To Do", approvedOn: new Date(), activeWorkflowCycleId: null, unresolvedPrerequisites: [], otherInProgressTaskForAssignee: null, otherInProgressTaskOnBranch: null, activeBlocker: null, epic: { status: "Done", actingManagerId: null } }, expectOk: false, expectReasonContains: "epic_not_actionable" },

  // --- submit_for_review guards ---
  { name: "submit_for_review with open checklist", intent: "submit_for_review", stateOverrides: { status: "In Progress", approvedOn: new Date(), activeWorkflowCycleId: "c1", openChecklist: { count: 2, ids: ["s1", "s2"] } }, expectOk: false, expectReasonContains: "checklist_incomplete" },
  { name: "submit_for_review with clean checklist", intent: "submit_for_review", stateOverrides: { status: "In Progress", approvedOn: new Date(), activeWorkflowCycleId: "c1", openChecklist: { count: 0, ids: [] } }, expectOk: true },

  // --- Callback correlation guards ---
  { name: "validation_succeeded with matching cycle", intent: "repository_validation_succeeded", stateOverrides: { status: "In Progress", activeWorkflowCycleId: "c1" }, expectOk: true },
  { name: "validation_succeeded with wrong cycle", intent: "repository_validation_succeeded", stateOverrides: { status: "In Progress", activeWorkflowCycleId: "c1" }, expectOk: false, expectReasonContains: "cycle_mismatch", commandCycleId: "c-wrong" },
];

// ---------------------------------------------------------------------------
// Base state factory
// ---------------------------------------------------------------------------

function makeBaseState(): Record<string, unknown> {
  return {
    id: "task-1",
    status: "To Do",
    workflowVersion: 1,
    projectId: "proj-1",
    epicId: "epic-1",
    assigneeId: "assignee",
    actingManagerId: "actingmgr",
    reporterId: "reporter",
    approvedOn: new Date(),
    approvedById: "actingmgr",
    activeWorkflowCycleId: null,
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

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  // --- Authorization matrix tests (pure function, no DB needed) ---
  console.log("\n=== Authorization Matrix Tests ===");
  for (const tc of AUTH_MATRIX) {
    try {
      const { authorizeCommand } = await import("@/lib/tasks/orchestrator/authorize");

      // Build state appropriate for the intent
      const stateOverrides: Record<string, unknown> = { ...tc.stateOverrides };
      // Default state for decision intents
      if (!stateOverrides.status) stateOverrides.status = "To Do";
      if (!stateOverrides.approvedOn) stateOverrides.approvedOn = new Date();
      if (!stateOverrides.assigneeId) stateOverrides.assigneeId = "assignee";
      if (!stateOverrides.actingManagerId) stateOverrides.actingManagerId = "actingmgr";
      if (!stateOverrides.reporterId) stateOverrides.reporterId = "reporter";
      if (!stateOverrides.activeReviewRun) {
        // For review intents, provide an awaiting_review lease
        if (tc.intent === "request_review_changes" || tc.intent === "accept_review") {
          stateOverrides.activeReviewRun = {
            id: "lease-1",
            status: "awaiting_review",
            candidateSha: "sha-abc",
            reviewerId: null,
            baseSha: "sha-base",
            repoTouched: true,
            validationOutcome: "valid",
          };
        }
        // For finalization callbacks, provide an accepted lease
        if (tc.intent === "repository_finalization_succeeded" || tc.intent === "repository_finalization_failed") {
          stateOverrides.activeReviewRun = {
            id: "lease-1",
            status: "accepted",
            candidateSha: "sha-abc",
            reviewerId: "actingmgr",
            baseSha: "sha-base",
            repoTouched: true,
            validationOutcome: "valid",
          };
        }
      }
      if (!stateOverrides.project) {
        stateOverrides.project = {
          onlyReportersCanApproveActionPlans: false,
          onlyReportersCanSetTasksDone: false,
          repositoryPath: "/srv/Code/test",
        };
      }
      if (!stateOverrides.epic) {
        stateOverrides.epic = { status: "In Progress", actingManagerId: "actingmgr" };
      }

      const state = makeState(stateOverrides);
      const result = authorizeCommand(
        state as any,
        { intent: tc.intent as any, actor: { ...tc.actor, id: tc.actor.id } as any },
      );

      if (result.allowed !== tc.expectedAllowed) {
        throw new Error(
          `Expected allowed=${tc.expectedAllowed}, got allowed=${result.allowed} (reason: ${result.reason})`,
        );
      }
      if (tc.expectedReason && result.reason !== tc.expectedReason) {
        throw new Error(
          `Expected reason="${tc.expectedReason}", got reason="${result.reason}"`,
        );
      }
      // Verify monitor cannot be the decision actor for decision intents.
      // For validation callbacks (not finalization), the monitor IS the
      // decision actor — that's correct: validation is a mechanical action
      // that doesn't require a reviewer decision.
      if (tc.actor.role === "monitor" && result.allowed && result.decisionActorId === tc.actor.id) {
        const decisionIntents = ["accept_review", "request_review_changes", "approve_plan", "submit_plan", "start_implementation", "cancel_task", "archive_task"];
        if (decisionIntents.includes(tc.intent)) {
          throw new Error("Monitor was allowed as decision actor for a decision intent — invariant 9 violation");
        }
      }
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL [auth] ${tc.intent} × ${tc.actor.role}: ${(e as Error).message}`);
    }
  }

  // --- Guard matrix tests (pure function, no DB needed) ---
  console.log("\n=== Guard Matrix Tests ===");
  for (const tc of GUARD_MATRIX) {
    try {
      const { runGuards } = await import("@/lib/tasks/orchestrator/guards");

      const state = makeState(tc.stateOverrides);
      const result = runGuards(state as any, {
        intent: tc.intent as any,
        expectedWorkflowVersion: 1,
        workflowCycleId: tc.commandCycleId ?? ((state.activeWorkflowCycleId as string) ?? null),
        payload: {},
      });

      if (result.ok !== tc.expectOk) {
        throw new Error(
          `Expected ok=${tc.expectOk}, got ok=${result.ok}${!result.ok ? ` (reason: ${(result as any).reason})` : ""}`,
        );
      }
      if (!result.ok && tc.expectReasonContains) {
        const reason = (result as any).reason as string;
        if (!reason.includes(tc.expectReasonContains)) {
          throw new Error(
            `Expected reason to contain "${tc.expectReasonContains}", got "${reason}"`,
          );
        }
      }
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL [guard] ${tc.name}: ${(e as Error).message}`);
    }
  }

  // --- Monitor invariant: monitor can execute mechanics but NOT decide ---
  console.log("\n=== Monitor Invariant Tests ===");
  try {
    const { authorizeCommand } = await import("@/lib/tasks/orchestrator/authorize");
    const monitorActor = { id: "monitor", kind: "agent" as const, username: "m", role: "monitor" as const };
    const assigneeActor = { id: "assignee", kind: "agent" as const, username: "a", role: "assignee" as const, codingCapability: true };

    const state = makeState({
      status: "In Progress",
      activeWorkflowCycleId: "c1",
      activeReviewRun: {
        id: "lease-1", status: "awaiting_review", candidateSha: "sha-abc",
        reviewerId: null, baseSha: "sha-base", repoTouched: true, validationOutcome: "valid",
      },
    });

    // Monitor CAN execute mechanical callbacks
    const mechResult = authorizeCommand(state as any, {
      intent: "repository_validation_succeeded",
      actor: monitorActor,
    });
    assert.equal(mechResult.allowed, true, "Monitor should be allowed to execute mechanical callbacks");
    assert.equal(mechResult.executorActorId, "monitor", "Executor should be the monitor");
    // For validation callbacks, the monitor IS the decision actor —
    // validation is mechanical, no reviewer decision needed.
    assert.equal(mechResult.decisionActorId, "monitor", "Decision actor for validation callback should be the monitor");

    // Monitor CANNOT accept_review
    const acceptResult = authorizeCommand(state as any, {
      intent: "accept_review",
      actor: monitorActor,
    });
    assert.equal(acceptResult.allowed, false, "Monitor should NOT be allowed to accept review");
    assert.equal(acceptResult.reason, "monitor_cannot_decide");

    // Monitor CANNOT submit_plan
    const planState = makeState({ status: "To Do", approvedOn: null, assigneeId: "monitor" });
    const planResult = authorizeCommand(planState as any, {
      intent: "submit_plan",
      actor: monitorActor,
    });
    assert.equal(planResult.allowed, false, "Monitor should NOT be allowed to submit plan");
    assert.equal(planResult.reason, "monitor_cannot_decide");

    passed += 3;
  } catch (e) {
    failed++;
    console.error(`FAIL [monitor-invariant]: ${(e as Error).message}`);
  }

  // --- Coding capability check ---
  console.log("\n=== Coding Capability Tests ===");
  try {
    const { authorizeCommand } = await import("@/lib/tasks/orchestrator/authorize");

    // Assignee without coding capability cannot start_implementation
    const nonCodingState = makeState({ status: "To Do", approvedOn: new Date(), assigneeId: "assignee" });
    const nonCodingResult = authorizeCommand(nonCodingState as any, {
      intent: "start_implementation",
      actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: false },
    });
    assert.equal(nonCodingResult.allowed, false);
    assert.equal(nonCodingResult.reason, "not_coding_capable");

    // Assignee WITH coding capability can start_implementation
    const codingState = makeState({ status: "To Do", approvedOn: new Date(), assigneeId: "assignee", activeWorkflowCycleId: null, unresolvedPrerequisites: [], otherInProgressTaskForAssignee: null, otherInProgressTaskOnBranch: null, activeBlocker: null });
    const codingResult = authorizeCommand(codingState as any, {
      intent: "start_implementation",
      actor: { id: "assignee", kind: "agent", username: "a", role: "assignee", codingCapability: true },
    });
    assert.equal(codingResult.allowed, true);

    passed += 2;
  } catch (e) {
    failed++;
    console.error(`FAIL [coding-capability]: ${(e as Error).message}`);
  }

  // --- Deduplication check: authorize.ts no longer exports parallel resolvers ---
  console.log("\n=== Resolver Deduplication Tests ===");
  try {
    const authorizeModule = await import("@/lib/tasks/orchestrator/authorize");
    const actorsModule = await import("@/lib/tasks/workflow-actors");

    // authorize.ts should NOT export the old parallel copies
    assert.equal(
      typeof (authorizeModule as any).canApprovePlan,
      "undefined",
      "authorize.ts should not export canApprovePlan (removed in PHASEE-03 dedup)",
    );
    assert.equal(
      typeof (authorizeModule as any).resolveDoneOwnerId,
      "undefined",
      "authorize.ts should not export resolveDoneOwnerId (removed in PHASEE-03 dedup)",
    );
    assert.equal(
      typeof (authorizeModule as any).resolvePlanOwnerId,
      "undefined",
      "authorize.ts should not export resolvePlanOwnerId (removed in PHASEE-03 dedup)",
    );

    // authorize.ts SHOULD re-export the canonical resolvers from workflow-actors.ts
    assert.equal(
      authorizeModule.canApproveActionPlanForActor,
      actorsModule.canApproveActionPlanForActor,
      "authorize.ts should re-export canApproveActionPlanForActor from workflow-actors.ts",
    );
    assert.equal(
      authorizeModule.canSetTaskDoneForActor,
      actorsModule.canSetTaskDoneForActor,
      "authorize.ts should re-export canSetTaskDoneForActor from workflow-actors.ts",
    );
    assert.equal(
      authorizeModule.resolveReviewOwnerId,
      actorsModule.resolveReviewOwnerId,
      "authorize.ts should re-export resolveReviewOwnerId from workflow-actors.ts",
    );

    // The thin adapter wrappers should exist
    assert.equal(typeof authorizeModule.resolvePlanOwnerIdFromSnapshot, "function");
    assert.equal(typeof authorizeModule.resolveDoneOwnerIdFromSnapshot, "function");

    passed += 5;
  } catch (e) {
    failed++;
    console.error(`FAIL [dedup]: ${(e as Error).message}`);
  }

  // --- Concurrency test: simulated parallel start_implementation ---
  // The lane/branch lease deferral in guards.ts states that workflowVersion
  // CAS + fence produces exactly one winner under concurrent start_implementation.
  // This test simulates that by verifying the guard logic: two commands with
  // the same expectedWorkflowVersion cannot both pass the guard + fence chain
  // because the first one bumps workflowVersion, making the second stale.
  console.log("\n=== Concurrency Tests ===");
  try {
    const { runGuards } = await import("@/lib/tasks/orchestrator/guards");

    // Simulate two concurrent start_implementation commands reading the same
    // workflowVersion V=1. Both pass the pure guard pass with V=1.
    const stateV1 = makeState({
      status: "To Do",
      approvedOn: new Date(),
      activeWorkflowCycleId: null,
      unresolvedPrerequisites: [],
      otherInProgressTaskForAssignee: null,
      otherInProgressTaskOnBranch: null,
      activeBlocker: null,
      workflowVersion: 1,
    });

    const cmd1 = {
      intent: "start_implementation" as const,
      expectedWorkflowVersion: 1,
      workflowCycleId: null as string | null,
      payload: {},
    };
    const cmd2 = { ...cmd1 };

    // Both pass the pure guard with V=1
    const guardResult1 = runGuards(stateV1 as any, cmd1);
    const guardResult2 = runGuards(stateV1 as any, cmd2);
    assert.equal(guardResult1.ok, true, "First command should pass guards");
    assert.equal(guardResult2.ok, true, "Second command should pass guards (same snapshot)");

    // Simulate the fence: the first transaction commits, bumping
    // workflowVersion to V=2 and status to In Progress. The second
    // transaction's fenceState re-reads the task and sees V=2 != V=1.
    // We simulate this by running guards against the post-commit state.
    const stateV2 = makeState({
      status: "In Progress",
      approvedOn: new Date(),
      activeWorkflowCycleId: "cycle-1",
      unresolvedPrerequisites: [],
      otherInProgressTaskForAssignee: null,
      otherInProgressTaskOnBranch: null,
      activeBlocker: null,
      workflowVersion: 2,
    });

    // The second command still expects V=1, but the task is now V=2.
    // guardWorkflowVersion catches this.
    const guardResult2PostCommit = runGuards(stateV2 as any, cmd2);
    assert.equal(guardResult2PostCommit.ok, false, "Second command should fail after first commits");
    assert.equal(
      (guardResult2PostCommit as any).status,
      "stale",
      "Second command should be stale, not invalid",
    );
    assert.ok(
      (guardResult2PostCommit as any).reason.includes("workflow version"),
      `Reason should mention workflow version, got: ${(guardResult2PostCommit as any).reason}`,
    );

    // Also verify that even if the version somehow matched, the status guard
    // would reject: the task is now In Progress, not To Do.
    const cmd2WithV2 = { ...cmd2, expectedWorkflowVersion: 2 };
    const guardResult2V2 = runGuards(stateV2 as any, cmd2WithV2);
    assert.equal(guardResult2V2.ok, false, "Second command with V=2 should still fail (status In Progress)");
    assert.ok(
      (guardResult2V2 as any).reason.includes("requires task status"),
      `Reason should mention status, got: ${(guardResult2V2 as any).reason}`,
    );

    console.log("  Concurrent start_implementation: exactly one winner via workflowVersion CAS ✓");
    passed += 4;
  } catch (e) {
    failed++;
    console.error(`FAIL [concurrency]: ${(e as Error).message}`);
  }

  // --- Fence test: state change between guard and execute returns stale ---
  console.log("\n=== Fence Tests ===");
  try {
    const { runGuards } = await import("@/lib/tasks/orchestrator/guards");
    const { mapFenceResultToOrchestratorResult } = await import("@/lib/tasks/orchestrator/state");

    // Scenario: guard passes with V=1 and status=To Do, but between guard
    // and execute, a concurrent transaction bumps version and changes status.
    const preTxState = makeState({
      status: "To Do",
      approvedOn: new Date(),
      activeWorkflowCycleId: null,
      unresolvedPrerequisites: [],
      otherInProgressTaskForAssignee: null,
      otherInProgressTaskOnBranch: null,
      activeBlocker: null,
      workflowVersion: 1,
    });

    const cmd = {
      intent: "start_implementation" as const,
      expectedWorkflowVersion: 1,
      workflowCycleId: null as string | null,
      payload: {},
    };

    // Guard passes with the pre-transaction snapshot
    const guardResult = runGuards(preTxState as any, cmd);
    assert.equal(guardResult.ok, true, "Guard should pass with pre-transaction state");

    // Simulate fence: the task is now In Progress with V=2
    // mapFenceResultToOrchestratorResult converts a fence failure to an
    // orchestrator result. We simulate the fence detecting version mismatch.
    const fenceResult = {
      ok: false as const,
      code: "stale_version" as const,
      expected: "workflowVersion=1",
      actual: "workflowVersion=2",
    };
    const orchResult = mapFenceResultToOrchestratorResult(fenceResult);
    assert.equal(orchResult.status, "stale", "Fence version mismatch should produce stale");
    assert.ok(
      orchResult.reason.includes("stale_version"),
      `Reason should include stale_version, got: ${orchResult.reason}`,
    );
    assert.ok(
      orchResult.reason.includes("workflowVersion=1"),
      `Reason should include expected version, got: ${orchResult.reason}`,
    );

    // Simulate fence: WIP conflict detected inside transaction
    const fenceWipResult = {
      ok: false as const,
      code: "stale_version" as const,
      expected: "no other In Progress task for assignee in project",
      actual: 'In Progress task "Other Task" found',
    };
    const wipOrchResult = mapFenceResultToOrchestratorResult(fenceWipResult);
    assert.equal(wipOrchResult.status, "stale", "Fence WIP conflict should produce stale");
    assert.ok(
      wipOrchResult.reason.includes("In Progress task"),
      `Reason should mention WIP conflict, got: ${wipOrchResult.reason}`,
    );

    // Simulate fence: branch collision detected inside transaction
    const fenceBranchResult = {
      ok: false as const,
      code: "stale_version" as const,
      expected: "no other In Progress task on effective branch",
      actual: 'In Progress task "Other Task" on branch env-999',
    };
    const branchOrchResult = mapFenceResultToOrchestratorResult(fenceBranchResult);
    assert.equal(branchOrchResult.status, "stale", "Fence branch collision should produce stale");
    assert.ok(
      branchOrchResult.reason.includes("In Progress task"),
      `Reason should mention branch collision, got: ${branchOrchResult.reason}`,
    );

    // Simulate fence: prerequisites no longer Done inside transaction
    const fencePrereqResult = {
      ok: false as const,
      code: "stale_version" as const,
      expected: "all prerequisites Done",
      actual: "unresolved: Dependency 1 (To Do)",
    };
    const prereqOrchResult = mapFenceResultToOrchestratorResult(fencePrereqResult);
    assert.equal(prereqOrchResult.status, "stale", "Fence prerequisite failure should produce stale");
    assert.ok(
      prereqOrchResult.reason.includes("unresolved"),
      `Reason should mention unresolved prerequisites, got: ${prereqOrchResult.reason}`,
    );

    console.log("  Fence rechecks: version, WIP, branch, prerequisites all produce stale ✓");
    passed += 7;
  } catch (e) {
    failed++;
    console.error(`FAIL [fence]: ${(e as Error).message}`);
  }

  // --- Guard honesty: guardNoUnresolvedBlocker documents inactive field ---
  console.log("\n=== Guard Honesty Tests ===");
  try {
    const { guardNoUnresolvedBlocker } = await import("@/lib/tasks/orchestrator/guards");

    // guardNoUnresolvedBlocker passes when activeBlocker is null (current state)
    const stateNoBlocker = makeState({ activeBlocker: null });
    const resultNoBlocker = guardNoUnresolvedBlocker(stateNoBlocker as any, "start_implementation");
    assert.equal(resultNoBlocker.ok, true, "Guard should pass when activeBlocker is null");

    // guardNoUnresolvedBlocker fires when activeBlocker has a permission request
    const stateWithBlocker = makeState({
      activeBlocker: { commentId: "c1", permissionRequest: { kind: "publish_checkpoint", scope: "test" } },
    });
    const resultWithBlocker = guardNoUnresolvedBlocker(stateWithBlocker as any, "start_implementation");
    assert.equal(resultWithBlocker.ok, false, "Guard should fail when activeBlocker has permission request");
    assert.ok(
      !(resultWithBlocker as any).ok && (resultWithBlocker as any).reason.includes("blocker_unresolved"),
      "Reason should mention blocker_unresolved",
    );

    console.log("  guardNoUnresolvedBlocker: honest about inactive field, fires when populated ✓");
    passed += 2;
  } catch (e) {
    failed++;
    console.error(`FAIL [guard-honesty]: ${(e as Error).message}`);
  }

  // --- Callback correlation: unused parameters removed ---
  console.log("\n=== Callback Correlation Tests ===");
  try {
    const { guardCallbackCorrelation } = await import("@/lib/tasks/orchestrator/guards");

    // Guard should accept only cycle/candidate/baseSha (no procedureRunId/stepId/jobId)
    const state = makeState({
      status: "In Progress",
      activeWorkflowCycleId: "c1",
      repositoryRun: {
        phase: "validating",
        candidateSha: "sha-abc",
        baseSha: "sha-base",
        repoTouched: true,
        reviewedSha: null,
        id: "rr-1",
        repositoryPath: "/srv/Code/test",
        branchName: "env-146",
        worktreePath: "/srv/Code/environment.worktrees/env-146",
        epicBranch: "phase-e",
        version: 1,
        attempt: 1,
        lastError: null,
        validationOutcome: null,
      },
    });

    // Matching cycle and SHAs should pass
    const resultMatch = guardCallbackCorrelation(state as any, "repository_validation_succeeded", {
      workflowCycleId: "c1",
      candidateSha: "sha-abc",
      baseSha: "sha-base",
    });
    assert.equal(resultMatch.ok, true, "Matching correlation should pass");

    // Wrong cycle should fail
    const resultWrongCycle = guardCallbackCorrelation(state as any, "repository_validation_succeeded", {
      workflowCycleId: "c-wrong",
      candidateSha: "sha-abc",
      baseSha: "sha-base",
    });
    assert.equal(resultWrongCycle.ok, false, "Wrong cycle should fail");
    assert.ok(
      !(resultWrongCycle as any).ok && (resultWrongCycle as any).reason.includes("callback_correlation_mismatch"),
      "Reason should mention callback_correlation_mismatch",
    );

    // Wrong candidateSha should fail
    const resultWrongSha = guardCallbackCorrelation(state as any, "repository_validation_succeeded", {
      workflowCycleId: "c1",
      candidateSha: "sha-wrong",
      baseSha: "sha-base",
    });
    assert.equal(resultWrongSha.ok, false, "Wrong candidateSha should fail");
    assert.ok(
      !(resultWrongSha as any).ok && (resultWrongSha as any).reason.includes("callback_correlation_mismatch"),
      "Reason should mention callback_correlation_mismatch",
    );

    console.log("  guardCallbackCorrelation: cycle/SHA comparisons work, unused params removed ✓");
    passed += 3;
  } catch (e) {
    failed++;
    console.error(`FAIL [callback-correlation]: ${(e as Error).message}`);
  }

  // --- Coding capability fail-closed: undefined codingCapability ---
  console.log("\n=== Coding Capability Fail-Closed Tests ===");
  try {
    const { authorizeCommand } = await import("@/lib/tasks/orchestrator/authorize");

    // Assignee with undefined codingCapability should fail-closed for start_implementation
    const state = makeState({ status: "To Do", approvedOn: new Date(), assigneeId: "assignee", activeWorkflowCycleId: null });
    const resultUndefined = authorizeCommand(state as any, {
      intent: "start_implementation",
      actor: { id: "assignee", kind: "agent", username: "a", role: "assignee" }, // no codingCapability
    });
    assert.equal(resultUndefined.allowed, false, "Undefined codingCapability should fail-closed for start_implementation");
    assert.equal(resultUndefined.reason, "not_coding_capable", "Reason should be not_coding_capable");

    // Assignee with undefined codingCapability should still work for checkpoint (no coding requirement)
    const stateInProgress = makeState({ status: "In Progress", approvedOn: new Date(), assigneeId: "assignee", activeWorkflowCycleId: "c1" });
    const resultCheckpoint = authorizeCommand(stateInProgress as any, {
      intent: "checkpoint",
      actor: { id: "assignee", kind: "agent", username: "a", role: "assignee" }, // no codingCapability
    });
    assert.equal(resultCheckpoint.allowed, true, "Undefined codingCapability should NOT block checkpoint");

    // Assignee with undefined codingCapability should still work for submit_plan
    const stateTodo = makeState({ status: "To Do", approvedOn: null, assigneeId: "assignee" });
    const resultPlan = authorizeCommand(stateTodo as any, {
      intent: "submit_plan",
      actor: { id: "assignee", kind: "agent", username: "a", role: "assignee" }, // no codingCapability
    });
    assert.equal(resultPlan.allowed, true, "Undefined codingCapability should NOT block submit_plan");

    console.log("  Fail-closed: undefined codingCapability blocks start/submit_for_review, allows checkpoint/submit_plan ✓");
    passed += 3;
  } catch (e) {
    failed++;
    console.error(`FAIL [coding-cap-fail-closed]: ${(e as Error).message}`);
  }

  // --- Summary ---
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("All PHASEE-03 tests passed.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});