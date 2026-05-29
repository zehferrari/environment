// Branch-verify spool — PM-side helper.
//
// When an assignee moves a code-touching task to Review (workflow action
// ready_for_review with repoTouched=true), PM drops a JSON job here. The
// karen-side runner (ai/web/scripts/pm-verify-branch-pushed.ts) consumes the
// file, runs `git -C <repositoryPath> fetch origin <branchName>` against the
// already-cloned local repo, looks for commits whose subject starts with the
// task/epic commit prefix on origin/<branchName>, and posts a verification
// task comment + pm.repo.verify.* ActivityLog row.
//
// The spool dir is karen-owned (0700) like the switch spool — created by the
// installer (ai/web/deploy/install-pm-verify.sh). The PM web service runs as
// karen so it can write here without sudo.

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
  commitPrefix: string | null;
  requestedByAgentSlug: string;
  requestedByUserId: string;
  requestedAt: string;
}

export async function enqueueBranchVerifyJob(job: BranchVerifyJob): Promise<string> {
  await mkdir(BRANCH_VERIFY_DIR, { recursive: true, mode: 0o700 });
  const path = join(BRANCH_VERIFY_DIR, `${job.jobId}.json`);
  // Atomic write (write tmp + rename) so the runner never reads a partial
  // file. tmp filename starts with a dot so directory listings can ignore it.
  const tmp = join(BRANCH_VERIFY_DIR, `.${job.jobId}.json.tmp`);
  await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
  const { rename } = await import("fs/promises");
  await rename(tmp, path);
  return path;
}
