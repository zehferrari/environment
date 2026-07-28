// pm-epic-merge-job — runner-side Epic merge/cleanup executor.
//
// Consumes ONE spool job dropped by pm.service (lib/deploy/epic-merge.ts):
//   kind "merge"   — merge a Done Epic-child task's LOCAL branch into the Epic
//                    integration branch and push only the Epic branch, or
//                    bounce the task back to Review on conflict/absence;
//   kind "cleanup" — after an Epic reaches Done, remove merged local child
//                    branches + their worktrees (verified against the pushed
//                    Epic branch; origin is never touched).
//
// Runs inside the active PM worktree via the unsandboxed
// pm-epic-merge-runner.service (pm-verify-runner pattern) so git worktree/
// fetch/push work; pm.service's sandbox cannot do any of that.
//
// Invoked as: pnpm exec tsx scripts/pm-epic-merge-job.ts <job-file>

import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { db } from "@/lib/db";
import { EPIC_MERGE_DIR, runEpicMergeSpoolJob, type EpicMergeJob } from "@/lib/deploy/epic-merge";

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error("Usage: pm-epic-merge-job <job.json>");
  if (!existsSync(jobFile)) throw new Error(`Job file not found: ${jobFile}`);
  if (!jobFile.startsWith(EPIC_MERGE_DIR)) {
    throw new Error(`Refusing to read job file outside ${EPIC_MERGE_DIR}`);
  }

  const job = JSON.parse(readFileSync(jobFile, "utf8")) as EpicMergeJob;
  if (job.kind !== "merge" && job.kind !== "cleanup") {
    throw new Error(`Unknown epic-merge job kind: ${(job as { kind?: string }).kind}`);
  }

  const result = await runEpicMergeSpoolJob(job);
  console.log(JSON.stringify({ jobId: job.jobId, kind: job.kind, ...result }, null, 2));
  if ("outcome" in result && result.outcome === "deferred" && jobFile.endsWith(".running")) {
    // Cleanup ran before all child merges landed — put the job back in the
    // spool so the runner retries it on a later tick.
    renameSync(jobFile, jobFile.slice(0, -".running".length));
    return;
  }
  unlinkSync(jobFile);
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    try {
      await db.$disconnect();
    } catch {}
    process.exit(1);
  });
