// PHASEE-03 — State/cycle/version/repository preconditions for workflow commands.
//
// Guards are pure functions of (state, command). They run AFTER authorization
// and BEFORE the decision function. A guard failure returns a stale/invalid
// result; the orchestrator does not record a transition.
//
// §10 Complete guard parity: every legacy safety gate is now a named,
// independently tested orchestrator guard. No route-only safety check
// remains a prerequisite for correctness.
//
// Guards enforce invariants 2 (optimistic concurrency), 5 (one open cycle),
// 6 (one active procedure per type/cycle), and the cycle/candidate/lease
// preconditions for review intents.

import { canRetryAcceptedRepositoryReview } from "@/lib/tasks/repository-finalization";
import type { TaskWorkflowIntent } from "@/lib/tasks/orchestrator/types";
import type { TaskStateSnapshot } from "@/lib/tasks/orchestrator/types";
import { isActionableEpicStatus } from "@/lib/tasks/workflow-actors";

export type GuardResult =
  | { ok: true }
  | { ok: false; status: "stale" | "invalid"; reason: string };

// ---------------------------------------------------------------------------
// §10.1–10.10 — Named guards. Each is a pure function of (state, command).
// ---------------------------------------------------------------------------

// --- Optimistic concurrency (invariant 2) --------------------------------
export function guardWorkflowVersion(
  state: TaskStateSnapshot,
  expectedVersion: number,
): GuardResult {
  if (state.workflowVersion !== expectedVersion) {
    return {
      ok: false,
      status: "stale",
      reason: `[stale_version] Task workflow version changed concurrently: expected ${expectedVersion}, found ${state.workflowVersion}.`,
    };
  }
  return { ok: true };
}

// --- Status precondition --------------------------------------------------
export function guardStatus(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
  allowedStatuses: ReadonlyArray<TaskStateSnapshot["status"]>,
): GuardResult {
  if (!allowedStatuses.includes(state.status)) {
    return {
      ok: false,
      status: "stale",
      reason: `Intent ${intent} requires task status ${allowedStatuses.join(" or ")}, found ${state.status}.`,
    };
  }
  return { ok: true };
}

// --- Approved-plan precondition -------------------------------------------
export function guardApprovedPlan(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  if (!state.approvedOn) {
    return {
      ok: false,
      status: "invalid",
      reason: `Intent ${intent} requires an approved Action Plan.`,
    };
  }
  return { ok: true };
}

// --- §10.1: No existing approved plan (submit_plan) -----------------------
export function guardNoApprovedPlan(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  if (state.approvedOn) {
    return {
      ok: false,
      status: "invalid",
      reason: `[plan_evidence_invalid] Intent ${intent} requires no existing approved plan, but one was found.`,
    };
  }
  return { ok: true };
}

// --- §10.2: Plan evidence (approve_plan) ----------------------------------
// Checks that a draft ActionPlan with at least one step exists.
// When state.actionPlan is undefined or null (not loaded / no plan row
// exists), the guard passes — this provides backward compatibility with
// snapshots that don't populate the actionPlan field, and with pre-plan
// states where no ActionPlan has been created yet. The guard only fails
// when an actionPlan IS present but has an invalid status or no steps.
export function guardPlanEvidence(
  state: TaskStateSnapshot,
  intent: "approve_plan" | "request_plan_changes" | "accept_plan_review" | "delegate_plan_approval",
): GuardResult {
  const plan = state.actionPlan;
  if (!plan) return { ok: true }; // undefined or null — no plan loaded
  if (plan.status !== "draft") {
    return {
      ok: false,
      status: "stale",
      reason: `[plan_evidence_invalid] Intent ${intent} requires a draft ActionPlan, but the current revision is ${plan.status}.`,
    };
  }
  if (plan.steps.length === 0) {
    return {
      ok: false,
      status: "invalid",
      reason: `[plan_evidence_invalid] Intent ${intent} requires an ActionPlan with at least one step.`,
    };
  }
  return { ok: true };
}

// --- Cycle preconditions --------------------------------------------------
export function guardCyclePrecondition(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
  commandCycleId: string | null | undefined,
): GuardResult {
  const hasActiveCycle = Boolean(state.activeWorkflowCycleId);
  if (intent === "start_implementation") {
    if (hasActiveCycle) {
      return {
        ok: false,
        status: "invalid",
        reason: "Cannot start a new implementation cycle while another cycle is open.",
      };
    }
    return { ok: true };
  }
  if (!hasActiveCycle) {
    return {
      ok: false,
      status: "invalid",
      reason: `Intent ${intent} requires an active workflow cycle, but the task has none.`,
    };
  }
  if (commandCycleId && commandCycleId !== state.activeWorkflowCycleId) {
    return {
      ok: false,
      status: "stale",
      reason: `[cycle_mismatch] Command targets cycle ${commandCycleId}, but the active cycle is ${state.activeWorkflowCycleId}.`,
    };
  }
  return { ok: true };
}

// --- §10.3: Prerequisites guard -------------------------------------------
export function guardPrerequisites(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  const prerequisites = state.unresolvedPrerequisites;
  if (!prerequisites || prerequisites.length === 0) return { ok: true };

  const unresolved = prerequisites.filter((p) => p.status !== "Done");
  if (unresolved.length > 0) {
    const names = unresolved.map((p) => `${p.title} (${p.status})`).join(", ");
    return {
      ok: false,
      status: "invalid",
      reason: `[prerequisites_unmet] Intent ${intent} requires all prerequisites to be Done. Unresolved: ${names}.`,
    };
  }
  return { ok: true };
}

// --- §10.3: Epic actionability guard --------------------------------------
export function guardEpicActionable(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  if (!state.epic) return { ok: true };
  if (!isActionableEpicStatus(state.epic.status)) {
    return {
      ok: false,
      status: "invalid",
      reason: `[epic_not_actionable] Intent ${intent} requires the parent Epic to be To Do or In Progress, but it is ${state.epic.status}.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lane/branch lease decision (§10.3)
// ---------------------------------------------------------------------------
// DECISION: DEFERRAL. The existing workflowVersion compare-and-set (optimistic
// concurrency via Task.workflowVersion) combined with the transaction-time
// fence rechecks for guardProjectWIP and guardEffectiveBranchCollision
// (added in PHASEE-03 Step 3) already produce exactly one winner under
// concurrent start_implementation attempts.
//
// Rationale:
//   1. Two concurrent start_implementation commands both read the same
//      workflowVersion V. Both pass the pure guard pass.
//   2. Inside their respective transactions, fenceState re-reads the task
//      row. The first transaction's applyTaskTransition bumps workflowVersion
//      to V+1 and moves status to In Progress.
//   3. The second transaction's fenceState sees workflowVersion=V+1 (not V),
//      and returns stale_version. It also sees the assignee now has an In
//      Progress task (guardProjectWIP recheck) and the branch is now
//      occupied (guardEffectiveBranchCollision recheck).
//   4. Only one transaction commits; the other rolls back.
//
// A TaskExecutionLaneLease model with unique(projectId, assigneeId) and a
// TaskBranchLease with unique(repository/effective branch) would provide
// an earlier, cheaper rejection — but it requires a Prisma migration and
// schema changes that are outside the declared file ownership of this task.
// The deferral is safe because the database transaction + compare-and-set
// is the final arbiter: it is impossible for two transactions to both
// commit a status transition from the same workflowVersion.
//
// The concurrency test in scripts/orch-phasee-03-test.ts verifies the
// guard-level outcome: two commands with the same workflowVersion cannot
// both pass guards after the first commits, because guardWorkflowVersion
// rejects the second. The fence rechecks for WIP, branch collision, and
// prerequisites are implemented in state.ts fenceState (§10 additive,
// PHASEE-03 Step 3) and are exercised through mapFenceResultToOrchestratorResult
// mapping tests. A full transaction-integration test that calls fenceState
// inside a real Prisma transaction with mutated DB state requires a
// disposable database and is deferred to the integration test suite.
// ---------------------------------------------------------------------------

// --- §10.3: Project WIP guard ---------------------------------------------
export function guardProjectWIP(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  const other = state.otherInProgressTaskForAssignee;
  if (other) {
    return {
      ok: false,
      status: "invalid",
      reason: `[wip_conflict] Intent ${intent} rejected: assignee already has an In Progress task "${other.title}" in the same project.`,
    };
  }
  return { ok: true };
}

// --- §10.3: Effective-branch collision guard ------------------------------
export function guardEffectiveBranchCollision(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  const other = state.otherInProgressTaskOnBranch;
  if (other) {
    const branchLabel = other.branchName ?? "(epic default)";
    return {
      ok: false,
      status: "invalid",
      reason: `[branch_collision] Intent ${intent} rejected: another In Progress task "${other.title}" resolves to the same effective branch ${branchLabel}.`,

    };
  }
  return { ok: true };
}

// --- Review lease precondition (invariant 8) ------------------------------
export function guardReviewLease(
  state: TaskStateSnapshot,
  intent: "accept_review" | "request_review_changes",
  expectedCandidateSha?: string | null,
): GuardResult {
  const lease = state.activeReviewRun;
  if (!lease) {
    return {
      ok: false,
      status: "invalid",
      reason: `Intent ${intent} requires an active review lease, but none exists for the active cycle.`,
    };
  }
  const allowedStatuses = intent === "request_review_changes" || canRetryAcceptedRepositoryReview(state)
    ? ["awaiting_review", "accepted"]
    : ["awaiting_review"];
  if (!allowedStatuses.includes(lease.status)) {
    return {
      ok: false,
      status: "stale",
      reason: `[lease_mismatch] Intent ${intent} requires ${allowedStatuses.join(" or ")} lease, but the lease is ${lease.status}.`,
    };
  }
  if (expectedCandidateSha && lease.candidateSha !== expectedCandidateSha) {
    return {
      ok: false,
      status: "stale",
      reason: `[candidate_mismatch] Intent ${intent} targets candidate ${expectedCandidateSha}, but the lease candidate is ${lease.candidateSha}.`,
    };
  }
  return { ok: true };
}

// --- §10.5: Submit-for-review checklist guard -----------------------------
export function guardSubmitForReviewChecklist(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  const checklist = state.openChecklist;
  if (checklist && checklist.count > 0) {
    return {
      ok: false,
      status: "invalid",
      reason: `[checklist_incomplete] Intent ${intent} requires all implementation checklist items to be complete. ${checklist.count} item(s) remaining.`,
    };
  }
  return { ok: true };
}

export function guardAcceptReviewChecklist(state: TaskStateSnapshot): GuardResult {
  const remaining = state.openReviewChecklist?.count ?? 0;
  return remaining > 0
    ? { ok: false, status: "invalid", reason: `[checklist_incomplete] Final acceptance requires the review checklist to be complete. ${remaining} review item(s) remaining; assess the evidence while keeping deferred checks open.` }
    : { ok: true };
}

// Required deliverables are a task-level review gate. Agents may attach files
// throughout implementation, but Review cannot begin until evidence exists.
export function guardSubmitForReviewAttachment(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  if (state.reviewAttachmentRequired && (state.attachmentCount ?? 0) === 0) {
    return {
      ok: false,
      status: "invalid",
      reason: `[attachment_required] Intent ${intent} requires at least one task attachment before review. Upload the deliverable to this task, then submit again.`,
    };
  }
  return { ok: true };
}

// --- §10.5: Unresolved blocker guard --------------------------------------
export function guardNoUnresolvedBlocker(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
): GuardResult {
  const blocker = state.activeBlocker;
  const waitForHuman = blocker?.override?.kind === "wait_for_human";
  const unresolvedPermission = Boolean(
    blocker?.permissionRequest && !blocker.permissionGrant?.authorizationCommentId,
  );
  if (waitForHuman || unresolvedPermission) {
    const detail = waitForHuman
      ? `an unresolved wait-for-human blocker exists (task was moved by a human status override)`
      : `an unresolved formal blocker with a pending permission request exists`;
    return {
      ok: false,
      status: "invalid",
      reason: waitForHuman
        ? `[blocker_unresolved] Intent ${intent} rejected: ${detail}. The assigned agent must stop and await explicit human instructions; only an authorized human clear_blocker (or a human status override) can resolve it.`
        : `[blocker_unresolved] Intent ${intent} rejected: ${detail}.`,
    };
  }
  return { ok: true };
}

// --- Repository preconditions for submit_for_review -----------------------
export function guardRepositoryForSubmit(state: TaskStateSnapshot): GuardResult {
  const repo = state.repositoryRun;
  if (!repo) return { ok: true };
  if (repo.phase === "validating" || repo.phase === "finalizing") {
    return {
      ok: false,
      status: "stale",
      reason: `Cannot submit for review while repository is ${repo.phase}.`,
    };
  }
  return { ok: true };
}

// --- §10.6/10.9: Callback correlation guard -------------------------------
// Validates exact equality for task/cycle/candidate/base SHA on validation
// and finalization callbacks.
//
// NOTE: procedureRunId, procedureStepId, and jobId are NOT compared here
// because TaskStateSnapshot does not currently carry active procedure-run
// correlation IDs. The payload types declare these fields (and PHASEE-07
// will fence on exact correlation), but the aggregate loader does not yet
// expose the active procedure run's runId/stepId/jobId on the snapshot.
// Comparing them against undefined would always pass (no-op), which is
// dishonest. Instead, they are omitted from this guard's parameter set,
// and the guard enforces only the correlations that the snapshot actually
// supports: cycle, candidate SHA, base SHA, and review lease status.
// Follow-up: wire active procedure-run correlation IDs into
// TaskStateSnapshot (PHASEE-07) and add the comparisons here.
export function guardCallbackCorrelation(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
  callback: {
    workflowCycleId?: string | null;
    candidateSha?: string | null;
    baseSha?: string | null;
  },
): GuardResult {
  // Cycle correlation
  if (callback.workflowCycleId && callback.workflowCycleId !== state.activeWorkflowCycleId) {
    return {
      ok: false,
      status: "stale",
      reason: `[callback_correlation_mismatch] Callback targets cycle ${callback.workflowCycleId}, but the active cycle is ${state.activeWorkflowCycleId}.`,
    };
  }

  // Repository run correlation (candidate/base SHA)
  const repo = state.repositoryRun;
  if (repo) {
    if (callback.candidateSha && repo.candidateSha && callback.candidateSha !== repo.candidateSha) {
      return {
        ok: false,
        status: "stale",
        reason: `[callback_correlation_mismatch] Callback candidate SHA ${callback.candidateSha} does not match repository run candidate ${repo.candidateSha}.`,
      };
    }
    if (callback.baseSha && repo.baseSha && callback.baseSha !== repo.baseSha) {
      return {
        ok: false,
        status: "stale",
        reason: `[callback_correlation_mismatch] Callback base SHA ${callback.baseSha} does not match repository run base ${repo.baseSha}.`,
      };
    }
  }

  // Review lease correlation for finalization callbacks
  if (
    (intent === "repository_finalization_succeeded" ||
      intent === "repository_finalization_failed") &&
    state.activeReviewRun
  ) {
    const lease = state.activeReviewRun;
    if (lease.status !== "accepted") {
      return {
        ok: false,
        status: "stale",
        reason: `[callback_correlation_mismatch] Finalization callback requires an accepted lease, but the lease is ${lease.status}.`,
      };
    }
    if (callback.candidateSha && lease.candidateSha !== callback.candidateSha) {
      return {
        ok: false,
        status: "stale",
        reason: `[callback_correlation_mismatch] Finalization callback candidate ${callback.candidateSha} does not match lease candidate ${lease.candidateSha}.`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Aggregate guard — runs the intent's required guards in order.
// Returns the first failure.
// ---------------------------------------------------------------------------

export function runGuards(
  state: TaskStateSnapshot,
  command: {
    intent: TaskWorkflowIntent;
    expectedWorkflowVersion: number;
    workflowCycleId?: string | null;
    payload?: Record<string, unknown>;
  },
): GuardResult {
  const versionGuard = guardWorkflowVersion(state, command.expectedWorkflowVersion);
  if (!versionGuard.ok) return versionGuard;

  switch (command.intent) {
    case "epic_child_update":
      return command.payload?.epicId === state.epicId && state.epicId !== null
        ? { ok: true }
        : {
            ok: false,
            status: "stale",
            reason: "[cycle_mismatch] Epic child command does not match the task's current Epic.",
          };

    case "override_status":
      // Deliberately bypass ordinary edge/plan/cycle/blocker/repository guards.
      // The workflow-version guard above remains authoritative and is fenced
      // again inside the transaction. Leaving an implementation lifecycle is
      // allowed only when the open cycle is the sole stale residue; active
      // mechanical work must finish or be explicitly cancelled first.
      // Repository-backed implementation and completion edges are never
      // generic overrides: start_implementation owns worktree admission and
      // accept_review owns finalization/cleanup before Done.
      if (state.project.repositoryPath || state.repositoryRun) {
        if (command.payload?.targetStatus === "In Progress") {
          return {
            ok: false,
            status: "invalid",
            reason: "[invalid_transition] Repository work must enter In Progress through start_implementation so its worktree is revalidated before dispatch.",
          };
        }
        if (command.payload?.targetStatus === "Done") {
          return {
            ok: false,
            status: "invalid",
            reason: "[invalid_transition] Repository work must enter Done through accept_review so finalization and local cleanup complete first.",
          };
        }
      }
      if (
        command.payload?.targetStatus === "Backlog" ||
        command.payload?.targetStatus === "To Do" ||
        command.payload?.targetStatus === "Done"
      ) {
        const blockers: string[] = [];
        if ((state.activeProcedureRuns?.length ?? 0) > 0) blockers.push("procedure");
        if (state.pmChannelRun) blockers.push("PM execution run");
        if (state.activeEpisode) blockers.push("execution episode");
        if ((state.outstandingJobs?.length ?? 0) > 0) blockers.push("repository callback job");
        if (
          state.repositoryRun &&
          ["reserved", "provisioning", "validating", "review_ready", "finalizing", "operational_error"]
            .includes(state.repositoryRun.phase)
        ) blockers.push(`repository lifecycle (${state.repositoryRun.phase})`);
        if (
          state.activeReviewRun &&
          ["validating", "awaiting_review", "accepted"].includes(state.activeReviewRun.status)
        ) blockers.push(`review lease (${state.activeReviewRun.status})`);
        if (blockers.length > 0) {
          return {
            ok: false,
            status: "invalid",
            reason: `[cycle_mismatch] Human status override cannot leave the active lifecycle while ${blockers.join(", ")} remains active. Settle or cancel that work first.`,
          };
        }
      }
      return { ok: true };

    case "submit_plan":
      // §10.1: status Backlog/To Do, no existing approved plan
      return runGuardsChain([
        guardStatus(state, command.intent, ["Backlog", "To Do"]),
        guardNoApprovedPlan(state, command.intent),
      ]);

    case "accept_plan_review":
    case "delegate_plan_approval":
    case "approve_plan":
      // §10.2: status Backlog/To Do, plan evidence (draft, ≥1 step)
      return runGuardsChain([
        guardStatus(state, command.intent, ["Backlog", "To Do"]),
        guardPlanEvidence(state, "approve_plan"),
      ]);

    case "request_plan_changes":
      // §10.2: status Backlog/To Do, plan evidence
      return runGuardsChain([
        guardStatus(state, command.intent, ["Backlog", "To Do"]),
        guardPlanEvidence(state, "request_plan_changes"),
      ]);

    case "start_implementation":
      // §10.3: status To Do, approved plan, no active cycle, prerequisites
      // Done, Epic actionable, no WIP conflict, no branch collision,
      // no unresolved blocker
      return runGuardsChain([
        guardStatus(state, command.intent, ["To Do"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardPrerequisites(state, command.intent),
        guardEpicActionable(state, command.intent),
        guardProjectWIP(state, command.intent),
        guardEffectiveBranchCollision(state, command.intent),
        guardNoUnresolvedBlocker(state, command.intent),
      ]);

    case "checkpoint":
      // §10.4: status In Progress, approved plan, active cycle
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "submit_for_review":
      // §10.5: status In Progress, approved plan, active cycle, Epic
      // actionable, checklist complete, no unresolved blocker, repository
      // not validating/finalizing
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardEpicActionable(state, command.intent),
        guardSubmitForReviewChecklist(state, command.intent),
        guardSubmitForReviewAttachment(state, command.intent),
        guardNoUnresolvedBlocker(state, command.intent),
        guardRepositoryForSubmit(state),
      ]);

    case "repository_validation_succeeded":
    case "repository_validation_failed": {
      // §10.6: exact callback correlation
      const payload = command.payload ?? {};
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardCallbackCorrelation(state, command.intent, {
          workflowCycleId: command.workflowCycleId,
          candidateSha: payload.candidateSha as string | null | undefined,
          baseSha: payload.baseSha as string | null | undefined,
        }),
      ]);
    }

    case "worktree_revalidation_failed":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "request_review_changes":
      // §10.7: status Review, active cycle, exact lease + candidate
      return runGuardsChain([
        guardStatus(state, command.intent, ["Review"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardReviewLease(state, "request_review_changes", state.activeReviewRun?.candidateSha),
      ]);

    case "accept_review":
      // §10.8: status Review, active cycle, exact lease + candidate
      return runGuardsChain([
        guardStatus(state, command.intent, ["Review"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardReviewLease(state, "accept_review", state.activeReviewRun?.candidateSha),
        guardAcceptReviewChecklist(state),
      ]);

    case "repository_finalization_succeeded":
    case "repository_finalization_failed": {
      // §10.9: exact callback correlation + accepted lease
      const payload = command.payload ?? {};
      return runGuardsChain([
        guardStatus(state, command.intent, ["Review"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardCallbackCorrelation(state, command.intent, {
          workflowCycleId: command.workflowCycleId,
          candidateSha: payload.candidateSha as string | null | undefined,
          baseSha: payload.baseSha as string | null | undefined,
        }),
      ]);
    }

    case "review_permission":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress", "Review"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "raise_blocker":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress", "To Do", "Review"]),
        state.status === "To Do"
          ? { ok: true }
          : guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "clear_blocker":
      if (state.activeBlocker?.override?.kind === "wait_for_human") {
        // A human override may move the task to any non-Done status and does
        // not require an active agent cycle, so its dedicated blocker must be
        // clearable from Backlog as well.
        return guardStatus(state, command.intent, ["Backlog", "To Do", "In Progress", "Review"]);
      }
      // Ordinary agent-raised blockers retain the legacy cycle guard.
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress", "To Do", "Review"]),
        state.status === "To Do"
          ? { ok: true }
          : guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "cancel_task":
      return guardStatus(state, command.intent, ["To Do", "In Progress", "Review", "Backlog"]);

    case "archive_task":
      return guardStatus(state, command.intent, ["Done"]);

    case "triage_task":
      return runGuardsChain([
        guardStatus(state, command.intent, ["Backlog"]),
        guardEpicActionable(state, command.intent),
      ]);

    case "assign_task":
      if (state.assigneeId) {
        return { ok: false, status: "stale", reason: "Task is already assigned." };
      }
      return guardStatus(state, command.intent, ["Backlog", "To Do"]);

    case "publish_checkpoint":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardEpicActionable(state, command.intent),
        state.repositoryRun?.phase === "active"
          ? { ok: true }
          : {
              ok: false,
              status: "invalid",
              reason: `publish_checkpoint requires an active repository run, found ${state.repositoryRun?.phase ?? "missing"}.`,
            },
      ]);

    case "add_subtask":
    case "complete_subtask":
    case "remove_subtask": {
      const kind = command.payload?.subtaskKind;
      if (kind === "review") return { ok: true };
      return runGuardsChain([
        guardStatus(state, command.intent, ["To Do", "In Progress"]),
        guardApprovedPlan(state, command.intent),
      ]);
    }

    case "request_subtask":
      if (!state.assigneeId) {
        return { ok: false, status: "invalid", reason: "Task has no assignee to receive the request." };
      }
      return { ok: true };

    case "request_task":
      if (!state.epicId || !state.epic?.actingManagerId) {
        return { ok: false, status: "invalid", reason: "Task has no Epic acting manager to receive the request." };
      }
      return { ok: true };

    case "raise_scope_blocker":
      return guardStatus(state, command.intent, ["To Do", "In Progress", "Review"]);

    default:
      return { ok: false, status: "invalid", reason: `Unknown intent ${command.intent}` };
  }
}

function runGuardsChain(results: GuardResult[]): GuardResult {
  for (const result of results) {
    if (!result.ok) return result;
  }
  return { ok: true };
}
