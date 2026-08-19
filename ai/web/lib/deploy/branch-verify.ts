// Branch-verify spool — PM-side helper.
//
// When an assignee moves a code-touching task to Review (workflow action
// ready_for_review with repoTouched=true), PM drops a JSON job here. The
// monitor-side runner (ai/web/scripts/pm-verify-branch-pushed.ts) consumes the
// file before any reviewer is woken. It resolves the branch worktree, creates
// the PM-owned submission commit for pending changes, then verifies commit
// prefix + expected git identity and rebuilds the active PM worktree when this
// branch is live. It posts a verification task comment +
// pm.repo.verify.* ActivityLog row. Standalone tasks are published and
// verified on origin/<branchName>; Epic children (epicChild) are verified on the LOCAL
// refs/heads/<branchName> against the Epic integration branch and are never
// pushed (P6 local-only model).
//
// The spool dir is shared by the PM web service user and the verify runner
// user (2770, usually group code-agents) so the runner can use a dedicated
// local account with read-only git credentials while PM still writes jobs.

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { ValidationProfileSnapshot } from "@/lib/tasks/validation-profile";

export const BRANCH_VERIFY_DIR =
  process.env.PM_BRANCH_VERIFY_DIR ?? "/var/lib/pm/branch-verify";

// --- PHASEE-07: V2 repository job identity -------------------------------
// Schema-v2 jobs carry a mandatory, fully-correlated identity packet so
// callbacks can be matched through exact correlation alone — no task-scoped
// search fallback. v1 jobs (missing schemaVersion or schemaVersion=1) are
// routed through a separate legacy drain adapter.
export const REPOSITORY_JOB_SCHEMA_V2 = 2 as const;

export type V2RepositoryJobIdentity = {
  schemaVersion: typeof REPOSITORY_JOB_SCHEMA_V2;
  jobId: string;
  taskId: string;
  workflowCycleId: string | null;
  procedureRunId: string;
  procedureStepId: string;
  commandReceiptId: string | null;
  repositoryRunId: string | null;
  repositoryRunVersion: number | null;
  candidateSha: string | null;
  baseSha: string | null;
};

export function isV2RepositoryJob(job: { schemaVersion?: number }): job is { schemaVersion: typeof REPOSITORY_JOB_SCHEMA_V2 } & Record<string, unknown> {
  return job.schemaVersion === REPOSITORY_JOB_SCHEMA_V2;
}

export interface BranchVerifyJob {
  jobId: string;
  taskId: string;
  projectId: string;
  projectSlug: string;
  repositoryPath: string;
  branchName: string;
  // PHASEE-07: schema version for exact callback correlation.
  // V2 jobs carry a mandatory V2RepositoryJobIdentity and are matched
  // through exact correlation only. V1 jobs (missing or schemaVersion=1)
  // route through the legacy drain adapter.
  schemaVersion?: number;
  // ORCH-06/R4: procedure correlation. The verifier callback uses these to
  // route the result back to the correct procedure step via
  // applyProcedureCallback. Optional for backward compatibility with jobs
  // queued by older PM builds.
  procedureRunId?: string;
  procedureStepId?: string;
  workflowCycleId?: string | null;
  // PHASEE-07: additional V2 identity fields for exact correlation.
  commandReceiptId?: string | null;
  repositoryRunId?: string | null;
  repositoryRunVersion?: number | null;
  // Effective deployment PR target branch at enqueue time. Optional so jobs
  // queued by older PM builds can resolve origin/HEAD safely.
  baseBranch?: string | null;
  // Epic-child local-only mode (P6): when epicChild is true the verifier
  // checks refs/heads/<branchName> against the Epic integration branch and
  // never pushes; standalone tasks keep the origin-based flow. Optional so
  // jobs queued by older PM builds behave as standalone.
  epicChild?: boolean;
  // Effective Epic integration branch at enqueue time (null when the Epic has
  // no derivable branch).
  epicBranch?: string | null;
  commitPrefix: string | null;
  expectedGitUserName: string | null;
  expectedGitUserEmail: string | null;
  // Immutable semantic/commit packet captured at submission time. The
  // repository runner creates the PM-owned commit when the worktree is dirty
  // and compares the resulting description with the task request.
  taskTitle?: string;
  taskDescription?: string | null;
  assigneeNote?: string | null;
  baseSha?: string | null;
  previousCandidateSha?: string | null;
  // Role-resolved monitor identity. New jobs never depend on a deployment-
  // specific username; optional fields keep queued jobs from older builds
  // readable during rolling deploys.
  monitorUserId?: string;
  monitorAgentSlug?: string;
  attempt?: number;
  requestedByAgentSlug: string;
  requestedByUserId: string;
  requestedAt: string;
  validationProfile?: ValidationProfileSnapshot;
}

export async function enqueueBranchVerifyJob(job: BranchVerifyJob): Promise<string> {
  await mkdir(BRANCH_VERIFY_DIR, { recursive: true, mode: 0o770 });
  const path = join(BRANCH_VERIFY_DIR, `${job.jobId}.json`);
  // Atomic write (write tmp + rename) so the runner never reads a partial
  // file. tmp filename starts with a dot so directory listings can ignore it.
  const tmp = join(BRANCH_VERIFY_DIR, `.${job.jobId}.json.tmp`);
  await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  const { rename } = await import("fs/promises");
  await rename(tmp, path);
  return path;
}
