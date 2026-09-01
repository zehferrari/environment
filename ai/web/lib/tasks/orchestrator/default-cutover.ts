import { db } from "@/lib/db";
import { isActiveOwnerPrincipal } from "@/lib/auth/roles";
import {
  getLegacyDrainInventory,
  getLegacyInvocationSummary,
} from "@/lib/tasks/orchestrator/dashboard-data";
import { inspectTaskAdmission, pinToV2 } from "@/lib/tasks/orchestrator/ownership";

export type LegacyDefaultCandidate = {
  taskId: string;
  workItemKey: string | null;
  projectSlug: string;
  status: string;
  eligible: boolean;
  reasonCode: string;
  reason: string;
};

export async function getLegacyDefaultCutoverReport(opts: { since?: Date } = {}) {
  const tasks = await db.task.findMany({
    where: {
      archivedAt: null,
      deletedAt: null,
      workflowEngine: "legacy",
      status: { in: ["Backlog", "To Do"] },
    },
    orderBy: [{ project: { slug: "asc" } }, { createdAt: "asc" }],
    select: {
      id: true,
      workItemKey: true,
      status: true,
      project: { select: { slug: true } },
    },
  });
  const candidates = await db.$transaction(async (tx) => Promise.all(tasks.map(async (task) => {
    const inspection = await inspectTaskAdmission(tx, task.id, { projectInCohort: true });
    return {
      taskId: task.id,
      workItemKey: task.workItemKey,
      projectSlug: task.project.slug,
      status: task.status,
      eligible: inspection?.eligible === true,
      reasonCode: inspection?.code ?? "task_not_found",
      reason: inspection?.eligible === false ? inspection.reason : inspection?.code ?? "task_not_found",
    } satisfies LegacyDefaultCandidate;
  })));
  const [drain, legacyInvocations, newLegacyRepositoryJobs] = await Promise.all([
    getLegacyDrainInventory(),
    getLegacyInvocationSummary(undefined, { since: opts.since }),
    opts.since
      ? db.taskRepositoryRun.count({
          where: {
            createdAt: { gte: opts.since },
            task: { archivedAt: null, deletedAt: null, workflowEngine: "legacy" },
          },
        })
      : Promise.resolve(null),
  ]);
  const blocked = candidates.filter((task) => !task.eligible);
  const gate = {
    applicable: Boolean(opts.since),
    actionableLegacyTaskCount: candidates.length,
    blockedLegacyTaskCount: blocked.length,
    legacyDrainCount: drain.length,
    legacyInvocationDelta: legacyInvocations.totalInvocations,
    newLegacyRepositoryJobCount: newLegacyRepositoryJobs,
    ready: Boolean(
      opts.since &&
      candidates.length === 0 &&
      drain.length === 0 &&
      legacyInvocations.totalInvocations === 0 &&
      newLegacyRepositoryJobs === 0
    ),
  };
  return {
    generatedAt: new Date().toISOString(),
    since: opts.since?.toISOString() ?? null,
    gate,
    candidates,
    drain,
    legacyInvocations,
  };
}

export async function runLegacyDefaultCutover(args: {
  operatorUserId: string;
  dryRun?: boolean;
}) {
  const operator = await db.user.findUnique({
    where: { id: args.operatorUserId },
    select: { id: true, username: true, kind: true, status: true, isOwner: true },
  });
  if (!isActiveOwnerPrincipal(operator)) {
    throw new Error("V2 default cutover requires the active Mission Control owner.");
  }
  const before = await getLegacyDefaultCutoverReport();
  const results: Array<{ taskId: string; outcome: string; reason?: string }> = [];
  for (const candidate of before.candidates) {
    if (!candidate.eligible) {
      results.push({ taskId: candidate.taskId, outcome: "skipped", reason: candidate.reason });
      continue;
    }
    if (args.dryRun) {
      results.push({ taskId: candidate.taskId, outcome: "would_pin" });
      continue;
    }
    const result = await db.$transaction((tx) => pinToV2(tx, candidate.taskId, {
      projectInCohort: true,
      operatorUserId: operator.id,
      evidenceId: "phasee-e5-v2-default",
      cohortStage: "e5_default",
    }));
    results.push(result.ok
      ? { taskId: candidate.taskId, outcome: result.code }
      : { taskId: candidate.taskId, outcome: "skipped", reason: result.reason });
  }
  return {
    dryRun: Boolean(args.dryRun),
    operator: operator.username,
    counts: {
      total: results.length,
      pinned: results.filter((item) => item.outcome === "pinned").length,
      wouldPin: results.filter((item) => item.outcome === "would_pin").length,
      skipped: results.filter((item) => item.outcome === "skipped").length,
    },
    results,
  };
}
