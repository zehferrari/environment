// Branch-verify spool — PM-side helper.
//
// When an assignee moves a code-touching task to Review (workflow action
// ready_for_review with repoTouched=true), PM drops a JSON job here. The
// monitor-side runner (ai/web/scripts/pm-verify-branch-pushed.ts) consumes the
// file before any reviewer is woken. It resolves the branch worktree, rejects
// dirty local changes, pushes clean local branch commits when needed, verifies
// origin/<branchName> has the task/epic commit prefix and expected git
// identity, rebuilds the active PM worktree when this branch is live, then
// posts a verification task comment + pm.repo.verify.* ActivityLog row.
//
// The spool dir is shared by the PM web service user and the verify runner
// user (2770, usually group code-agents) so the runner can use a dedicated
// local account with read-only git credentials while PM still writes jobs.

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

export const BRANCH_VERIFY_DIR =
  process.env.PM_BRANCH_VERIFY_DIR ?? "/var/lib/pm/branch-verify";

export interface BranchVerifyJob {
  jobId: string;
  taskId: string;
  projectId: string;
  projectSlug: string;
  repositoryPath: string;
  branchName: string;
  // Effective deployment PR target branch at enqueue time. Optional so jobs
  // queued by older PM builds can resolve origin/HEAD safely.
  baseBranch?: string | null;
  commitPrefix: string | null;
  expectedGitUserName: string | null;
  expectedGitUserEmail: string | null;
  requestedByAgentSlug: string;
  requestedByUserId: string;
  requestedAt: string;
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
