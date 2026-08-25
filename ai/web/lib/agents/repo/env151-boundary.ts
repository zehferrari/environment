import { db } from "@/lib/db";

/**
 * ENV-159 Step 9: ENV-151 base-drift ownership boundary.
 *
 * ENV-151 remains sole owner of Epic-child branch base-drift handling.
 * ENV-159 consumes exact repository outcomes but does NOT duplicate
 * repository reconciliation logic.
 *
 * No instruction to agent to merge/rebase/reset/commit/push merely because
 * base advanced. If base drift is detected, the caller must WAIT for ENV-151's
 * reconciliation — do NOT attempt merge/rebase/reset/commit/push.
 */

export interface RepositoryOutcomeArgs {
  taskId: string;
  cycleId?: string | null;
  procedureRunId?: string | null;
  procedureStepId?: string | null;
  repoRunId?: string | null;
  taskBranch: string;
  epicBranch: string;
  candidateSha: string;
  baseSha: string;
}

export type RepositoryOutcome =
  | { outcome: "clean"; detail?: string }
  | { outcome: "base_drift_detected"; detail: string }
  | { outcome: "failure"; detail: string };

/**
 * Consume a repository outcome. If base drift is detected, return a structured
 * result that tells the caller to WAIT for ENV-151's reconciliation — do NOT
 * attempt merge/rebase/reset/commit/push.
 *
 * Repository job fencing: validate all 9 identity fields match before applying
 * any callback.
 */
export async function consumeRepositoryOutcome(args: RepositoryOutcomeArgs): Promise<RepositoryOutcome> {
  // Fencing: validate all identity fields are present and consistent
  const fenceError = validateFenceFields(args);
  if (fenceError) {
    return { outcome: "failure", detail: `Fence validation failed: ${fenceError}` };
  }

  // Look up the repository run to compare SHAs
  if (!args.repoRunId) {
    // No repo run to check — clean outcome
    return { outcome: "clean" };
  }

  const repoRun = await db.taskRepositoryRun.findUnique({
    where: { id: args.repoRunId },
    select: {
      baseSha: true,
      candidateSha: true,
      phase: true,
      validationOutcome: true,
      lastError: true,
    },
  });

  if (!repoRun) {
    return { outcome: "failure", detail: `Repository run ${args.repoRunId} not found` };
  }

  // Fencing: verify the repo run's SHAs match the expected values
  if (repoRun.baseSha && args.baseSha && repoRun.baseSha !== args.baseSha) {
    return {
      outcome: "failure",
      detail: `Base SHA mismatch: repo run has ${repoRun.baseSha}, callback has ${args.baseSha}`,
    };
  }
  if (repoRun.candidateSha && args.candidateSha && repoRun.candidateSha !== args.candidateSha) {
    return {
      outcome: "failure",
      detail: `Candidate SHA mismatch: repo run has ${repoRun.candidateSha}, callback has ${args.candidateSha}`,
    };
  }

  // Check for base drift — the Epic branch tip has advanced beyond the
  // base SHA that the task branch was created from.
  if (repoRun.baseSha && args.baseSha) {
    // Compare the expected base SHA with the current Epic branch tip
    // The caller passes the expected baseSha; if the actual Epic branch
    // tip differs, that's base drift.
    // ENV-151 owns the reconciliation — we just detect and report.
    if (repoRun.baseSha !== args.baseSha) {
      return {
        outcome: "base_drift_detected",
        detail: `Epic branch ${args.epicBranch} base advanced from ${repoRun.baseSha} to ${args.baseSha}. ENV-151 owns reconciliation — do NOT merge/rebase/reset/commit/push. Wait for ENV-151 to handle the base drift.`,
      };
    }
  }

  // Check for validation failure
  if (repoRun.validationOutcome && repoRun.validationOutcome !== "pass") {
    return {
      outcome: "failure",
      detail: `Repository validation failed: ${repoRun.validationOutcome}${repoRun.lastError ? ` — ${repoRun.lastError}` : ""}`,
    };
  }

  return { outcome: "clean" };
}

/**
 * Validate that all 9 fence fields are present and consistent.
 * Returns an error message string if validation fails, or null if OK.
 */
export function validateFenceFields(args: RepositoryOutcomeArgs): string | null {
  if (!args.taskId) return "missing taskId";
  if (!args.taskBranch) return "missing taskBranch";
  if (!args.epicBranch) return "missing epicBranch";
  if (!args.candidateSha) return "missing candidateSha";
  if (!args.baseSha) return "missing baseSha";
  // cycleId, procedureRunId, procedureStepId, repoRunId are optional but
  // if present must be non-empty strings
  if (args.cycleId !== null && args.cycleId === "") return "empty cycleId";
  if (args.procedureRunId !== null && args.procedureRunId === "") return "empty procedureRunId";
  if (args.procedureStepId !== null && args.procedureStepId === "") return "empty procedureStepId";
  if (args.repoRunId !== null && args.repoRunId === "") return "empty repoRunId";
  return null;
}

/**
 * Check whether the ENV-151 boundary allows a specific agent action.
 * Returns true if the action is permitted, false if it would violate the
 * ENV-151 ownership boundary.
 *
 * Prohibited actions when base drift is detected:
 * - merge
 * - rebase
 * - reset
 * - commit
 * - push
 */
export function isActionPermittedUnderEnv151(
  outcome: RepositoryOutcome,
  action: "merge" | "rebase" | "reset" | "commit" | "push" | "verify" | "read" | "edit",
): boolean {
  if (outcome.outcome === "base_drift_detected") {
    // Only read/verify/edit actions are permitted during base drift
    // The ENV-151 boundary owns all branch-level mutation
    return action === "read" || action === "verify" || action === "edit";
  }
  if (outcome.outcome === "failure") {
    // No actions permitted on a failed repository outcome
    return action === "read";
  }
  // Clean outcome — all actions permitted
  return true;
}