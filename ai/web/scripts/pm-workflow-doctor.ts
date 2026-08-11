// Read-only by default. --apply performs only the reconciler's bounded safe
// repairs: reclaim/requeue an existing durable effect or retry an existing
// process-cancellation fence. It never invents a transition from comments.

import { runWorkflowReconciliation } from "@/lib/tasks/workflow-reconciler";

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const apply = flag("apply");
  const report = await runWorkflowReconciliation({
    projectId: option("project") ?? undefined,
    dryRun: !apply,
  });
  if (flag("json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[pm-workflow-doctor]${apply ? "" : " (read only)"} inspected ${report.inspectedTasks} task(s): ` +
      `${report.findings.length} finding(s), ${report.repaired} repaired, ${report.escalated} escalated`,
    );
    console.log(
      `  metrics: outbox=${JSON.stringify(report.metrics.outboxByStatus)} ` +
      `repository=${JSON.stringify(report.metrics.repositoryByPhase)} ` +
      `execution=${JSON.stringify(report.metrics.executionByState)} ` +
      `cancellationPending=${report.metrics.cancellationPending}`,
    );
    for (const finding of report.findings) {
      console.log(
        `  ${finding.kind} ${finding.taskId ?? finding.rowId}: ${finding.detail} ` +
        `→ ${finding.repair}${finding.repaired ? " [done]" : ""}${finding.error ? ` [${finding.error}]` : ""}`,
      );
    }
    for (const error of report.errors) console.log(`  error: ${error}`);
  }
  if (flag("strict") && report.findings.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error("[pm-workflow-doctor] failed", error);
  process.exit(1);
});
