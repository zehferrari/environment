// ENV-116 — read-only workflow-invariant monitor.
//
// Evaluates every invariant in lib/workflow-invariants.ts against live PM
// state and prints the violations. Writes nothing, ever: it is safe for the
// Monitor Agent to run on a schedule against the production database.
//
// Usage:
//   pnpm workflow-invariants-monitor                 # human summary, exit 0
//   pnpm workflow-invariants-monitor --json          # machine-readable
//   pnpm workflow-invariants-monitor --strict        # exit 1 if any violation
//   pnpm workflow-invariants-monitor --since-days=3  # narrow the run window
//   pnpm workflow-invariants-monitor --project=<id>  # one project only

import { checkWorkflowInvariants } from "@/lib/workflow-invariants-db";
import { WORKFLOW_INVARIANTS } from "@/lib/workflow-invariants";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const sinceDays = Number.parseFloat(option("since-days") ?? "14");
  const projectId = option("project");
  const report = await checkWorkflowInvariants({
    projectId: projectId ?? undefined,
    sinceMs: Number.isFinite(sinceDays) && sinceDays > 0
      ? sinceDays * 24 * 60 * 60 * 1000
      : undefined,
  });

  if (flag("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[workflow-invariants] scanned ${report.counts.runs} runs, ${report.counts.tasks} tasks, ${report.counts.blockers} active blockers`,
    );
    for (const invariant of WORKFLOW_INVARIANTS) {
      const violations = report.byInvariant[invariant.id] ?? [];
      const label = violations.length === 0 ? "ok  " : "FAIL";
      console.log(
        `  ${label} ${invariant.id} (Epic item ${invariant.epicItem}) — ${violations.length} violation(s): ${invariant.statement}`,
      );
      for (const violation of violations.slice(0, 5)) {
        console.log(
          `        ${violation.code} ${violation.subjectKind}:${violation.subjectId} — ${violation.detail}`,
        );
      }
      if (violations.length > 5) {
        console.log(`        … and ${violations.length - 5} more`);
      }
    }
  }

  if (flag("strict") && !report.ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("[workflow-invariants] monitor failed:", error);
  process.exit(2);
});
