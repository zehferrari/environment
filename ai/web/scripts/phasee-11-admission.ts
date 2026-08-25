#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import {
  getCohortSummary,
  getLegacyInvocationSummary,
} from "@/lib/tasks/orchestrator/dashboard-data";
import {
  getProjectAdmissionReport,
  runProjectAdmission,
  unpinQuiescentTask,
} from "@/lib/tasks/orchestrator/admission";
import {
  assertRolloutEvidence,
  evaluateObservationWindow,
  evaluateRolloutGates,
  type RolloutEvidence,
} from "@/lib/tasks/orchestrator/rollout-gates";

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function listOption(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv
    .filter((value) => value.startsWith(prefix))
    .flatMap((value) => value.slice(prefix.length).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required --${name}=... option.`);
  return value;
}

function loadEvidence(filePath: string): RolloutEvidence {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  assertRolloutEvidence(value);
  return value;
}

async function ownerId(username: string): Promise<string> {
  const owner = await db.user.findUnique({
    where: { username },
    select: { id: true, kind: true, status: true, isOwner: true },
  });
  if (!owner || owner.kind !== "human" || owner.status !== "active" || !owner.isOwner) {
    throw new Error(`Active Mission Control owner not found: ${username}`);
  }
  return owner.id;
}

async function main() {
  const command = process.argv[2];
  if (!command || flag("help")) {
    console.log([
      "Usage:",
      "  pnpm phasee:admission preflight --evidence=<json>",
      "  pnpm phasee:admission report --project=<slug> [--evidence=<json> | --tasks=<id-or-key,...>] [--planned]",
      "  pnpm phasee:admission observe --project=<slug> --evidence=<json>",
      "  pnpm phasee:admission admit --project=<slug> --operator=<owner-username> --evidence=<json> [--dry-run] [--include-done]",
      "  pnpm phasee:admission unpin --project=<slug> --task=<id-or-key> --operator=<owner-username>",
    ].join("\n"));
    return;
  }

  if (command === "preflight") {
    const report = evaluateRolloutGates(loadEvidence(requiredOption("evidence")));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 2;
    return;
  }

  if (command === "report") {
    const evidencePath = option("evidence");
    const evidence = evidencePath ? loadEvidence(evidencePath) : null;
    const projectSlug = requiredOption("project");
    if (evidence && evidence.targetProjectSlug !== projectSlug) {
      throw new Error("Rollout evidence target does not match the requested project.");
    }
    const taskIdsOrKeys = evidence?.productionCohort?.taskIdsOrKeys ?? listOption("tasks");
    if (flag("planned") && taskIdsOrKeys.length === 0) {
      throw new Error("--planned requires an exact --tasks list or project_cohort evidence.");
    }
    console.log(JSON.stringify(await getProjectAdmissionReport(projectSlug, {
      taskIdsOrKeys,
      planned: flag("planned"),
    }), null, 2));
    return;
  }

  if (command === "observe") {
    const evidence = loadEvidence(requiredOption("evidence"));
    const projectSlug = requiredOption("project");
    if (evidence.mode !== "project_cohort" || evidence.targetProjectSlug !== projectSlug) {
      throw new Error("Observation requires matching project_cohort evidence.");
    }
    const [window, report] = await Promise.all([
      Promise.resolve(evaluateObservationWindow(evidence)),
      getProjectAdmissionReport(projectSlug, {
        taskIdsOrKeys: evidence.productionCohort?.taskIdsOrKeys,
      }),
    ]);
    const since = window.startsAt ? new Date(window.startsAt) : undefined;
    const [cohort, legacyInvocations] = await Promise.all([
      getCohortSummary(report.project.id, { since }),
      getLegacyInvocationSummary(report.project.id, { since }),
    ]);
    const targetTasksHealthy =
      report.tasks.length === (evidence.productionCohort?.taskIdsOrKeys.length ?? 0) &&
      report.tasks.every((task) => task.workflowEngine === "orchestrator_v2");
    const cohortWindow = cohort[0] ?? null;
    const windowCountersHealthy = Boolean(
      cohortWindow &&
      legacyInvocations.totalInvocations === 0 &&
      cohortWindow.callbackHealth.rejected === 0 &&
      (cohortWindow.commandHealth.rejected_operational ?? 0) === 0 &&
      cohortWindow.activeCycleCount === 0 &&
      cohortWindow.activeProcedureCount === 0,
    );
    console.log(JSON.stringify({
      evidenceId: evidence.evidenceId,
      projectSlug,
      stage: evidence.productionCohort?.stage,
      observationWindow: window,
      targetTasksHealthy,
      windowCountersHealthy,
      report,
      cohort,
      legacyInvocations,
    }, null, 2));
    if (!window.applicable || !window.complete || !targetTasksHealthy || !windowCountersHealthy) process.exitCode = 2;
    return;
  }

  if (command === "admit") {
    const username = requiredOption("operator");
    const result = await runProjectAdmission({
      projectSlug: requiredOption("project"),
      operatorUserId: await ownerId(username),
      evidence: loadEvidence(requiredOption("evidence")),
      dryRun: flag("dry-run"),
      includeDone: flag("include-done"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "unpin") {
    const username = requiredOption("operator");
    const result = await unpinQuiescentTask({
      projectSlug: requiredOption("project"),
      taskIdOrKey: requiredOption("task"),
      operatorUserId: await ownerId(username),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
