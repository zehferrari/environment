// ENV-123 — the operator-facing watchdog CLI.
//
// The same pass the PM worker drain runs, on demand. `--dry-run` is the
// important mode: it detects and prints without repairing anything, so an
// operator can see exactly what the watchdog would do to production before
// letting it.
//
// Usage:
//   pnpm workflow-watchdog --dry-run          # detect only, change nothing
//   pnpm workflow-watchdog                    # detect and repair
//   pnpm workflow-watchdog --json             # machine-readable report
//   pnpm workflow-watchdog --project=<id>     # one project only
//   pnpm workflow-watchdog --strict           # exit 1 if anything is stalled

import { WATCHDOG_DETECTORS } from "@/lib/agents/watchdog/detectors";
import { runWorkflowWatchdog } from "@/lib/agents/watchdog/run";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const report = await runWorkflowWatchdog({
    projectId: option("project") ?? undefined,
    dryRun,
  });

  if (flag("json")) {
    console.log(JSON.stringify({ dryRun, ...report }, null, 2));
  } else {
    console.log(
      `[workflow-watchdog]${dryRun ? " (dry run)" : ""} scanned ${report.counts.tasks} tasks, ` +
        `${report.counts.runs} runs, ${report.counts.continuations} continuations — ` +
        `${report.counts.findings} finding(s), ${report.repaired} repaired, ` +
        `${report.escalated} escalated, ${report.breakerOpen} breaker-open`,
    );
    for (const detector of WATCHDOG_DETECTORS) {
      const hits = report.outcomes.filter((row) => row.detectorId === detector.id);
      if (hits.length === 0) continue;
      console.log(`  ${detector.id} — ${hits.length} task(s)`);
      for (const hit of hits.slice(0, 10)) {
        console.log(
          `        ${hit.taskId} → ${hit.state} (${hit.reasonCode})` +
            (hit.recoveryAction ? ` · recovery: ${hit.recoveryAction}` : "") +
            (hit.repairOutcome ? ` [${hit.repairOutcome}]` : ""),
        );
      }
      if (hits.length > 10) console.log(`        … and ${hits.length - 10} more`);
    }
    for (const error of report.errors) console.log(`  error: ${error}`);
  }

  if (flag("strict") && report.outcomes.some((row) => row.state === "stalled")) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[workflow-watchdog] failed", error);
  process.exit(1);
});
