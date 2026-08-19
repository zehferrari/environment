import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { computeActivityDedupeKey, writeDeduplicatedActivity } from "@/lib/tasks/orchestrator/activity-dedup";
import {
  ENGINE_ORCHESTRATOR_V2,
  inspectTaskAdmission,
  isProjectInMutationCohort,
  pinToV2,
  unpinFromV2,
} from "@/lib/tasks/orchestrator/ownership";
import {
  evaluateRolloutGates,
  type RolloutEvidence,
  type RolloutGateReport,
} from "@/lib/tasks/orchestrator/rollout-gates";

export type ProjectAdmissionTaskResult = {
  taskId: string;
  workItemKey: string | null;
  title: string;
  status: string;
  private: boolean;
  outcome: "admitted" | "already_pinned" | "would_admit" | "skipped";
  reasonCode: string;
  reason: string;
};

export type ProjectAdmissionResult = {
  projectId: string;
  projectSlug: string;
  dryRun: boolean;
  gate: RolloutGateReport;
  counts: {
    total: number;
    admitted: number;
    alreadyPinned: number;
    wouldAdmit: number;
    skipped: number;
  };
  tasks: ProjectAdmissionTaskResult[];
};

async function requireOwnerOperator(operatorUserId: string) {
  const operator = await db.user.findUnique({
    where: { id: operatorUserId },
    select: { id: true, username: true, kind: true, status: true, isOwner: true },
  });
  if (!operator || operator.kind !== "human" || operator.status !== "active" || !operator.isOwner) {
    throw new Error("Effectful admission requires the active Mission Control owner.");
  }
  return operator;
}

async function auditSkip(args: {
  tx: Prisma.TransactionClient;
  projectId: string;
  taskId: string;
  operatorUserId: string;
  evidenceId: string;
  reasonCode: string;
}) {
  const payload = {
    evidenceId: args.evidenceId,
    reasonCode: args.reasonCode,
  };
  await writeDeduplicatedActivity({
    client: args.tx,
    projectId: args.projectId,
    taskId: args.taskId,
    userId: args.operatorUserId,
    kind: "task.workflow.engine_admission_skipped",
    payload,
    dedupeKey: computeActivityDedupeKey("task.workflow.engine_admission_skipped", args.taskId, payload),
  });
}

/**
 * Audited project-scoped admission job. Each task is independently fenced in
 * its own transaction so a concurrent workflow mutation can only turn that
 * task into a stable skip; it cannot create mixed task/cycle ownership.
 */
export async function runProjectAdmission(args: {
  projectSlug: string;
  operatorUserId: string;
  evidence: RolloutEvidence;
  includeDone?: boolean;
  dryRun?: boolean;
}): Promise<ProjectAdmissionResult> {
  await requireOwnerOperator(args.operatorUserId);
  const project = await db.project.findUnique({
    where: { slug: args.projectSlug },
    select: { id: true, slug: true },
  });
  if (!project) throw new Error(`Project not found: ${args.projectSlug}`);
  if (args.evidence.targetProjectSlug !== project.slug) {
    throw new Error("Rollout evidence target does not match the requested project.");
  }

  const gate = evaluateRolloutGates(args.evidence);
  if (!gate.ready) {
    const failures = gate.gates.filter((item) => !item.passed).map((item) => item.id).join(", ");
    throw new Error(`Effectful admission preflight failed: ${failures}`);
  }

  const tasks = await db.task.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      workItemKey: true,
      title: true,
      status: true,
      private: true,
    },
  });

  const results: ProjectAdmissionTaskResult[] = [];
  const projectInCohort = isProjectInMutationCohort(project.slug);
  for (const task of tasks) {
    const result = await db.$transaction(async (tx) => {
      const inspection = await inspectTaskAdmission(tx, task.id, { projectInCohort });
      if (!inspection) {
        return { outcome: "skipped" as const, reasonCode: "task_not_found", reason: "Task disappeared during admission." };
      }
      if (inspection.code === "already_pinned") {
        return { outcome: "already_pinned" as const, reasonCode: "already_pinned", reason: "Task is already durably owned by orchestrator_v2." };
      }
      if (task.status === "Done" && !args.includeDone) {
        if (!args.dryRun) {
          await auditSkip({ tx, projectId: project.id, taskId: task.id, operatorUserId: args.operatorUserId, evidenceId: args.evidence.evidenceId, reasonCode: "done_projection_disabled" });
        }
        return { outcome: "skipped" as const, reasonCode: "done_projection_disabled", reason: "Done-task projection checks were not requested." };
      }
      if (args.evidence.mode === "e2_internal_canary" && !task.private) {
        if (!args.dryRun) {
          await auditSkip({ tx, projectId: project.id, taskId: task.id, operatorUserId: args.operatorUserId, evidenceId: args.evidence.evidenceId, reasonCode: "canary_task_not_private" });
        }
        return { outcome: "skipped" as const, reasonCode: "canary_task_not_private", reason: "E2 admits private tasks only." };
      }
      if (!inspection.eligible) {
        if (!args.dryRun) {
          await auditSkip({ tx, projectId: project.id, taskId: task.id, operatorUserId: args.operatorUserId, evidenceId: args.evidence.evidenceId, reasonCode: inspection.code });
        }
        return { outcome: "skipped" as const, reasonCode: inspection.code, reason: inspection.reason };
      }
      if (args.dryRun) {
        return { outcome: "would_admit" as const, reasonCode: "eligible", reason: "All admission fences are clear." };
      }
      const pin = await pinToV2(tx, task.id, {
        projectInCohort,
        operatorUserId: args.operatorUserId,
      });
      if (!pin.ok) {
        await auditSkip({ tx, projectId: project.id, taskId: task.id, operatorUserId: args.operatorUserId, evidenceId: args.evidence.evidenceId, reasonCode: pin.code });
        return { outcome: "skipped" as const, reasonCode: pin.code, reason: pin.reason };
      }
      return pin.code === "already_pinned"
        ? { outcome: "already_pinned" as const, reasonCode: pin.code, reason: "Task is already durably owned by orchestrator_v2." }
        : { outcome: "admitted" as const, reasonCode: pin.code, reason: "Task was durably pinned to orchestrator_v2." };
    });

    results.push({
      taskId: task.id,
      workItemKey: task.workItemKey,
      title: task.title,
      status: task.status,
      private: task.private,
      ...result,
    });
  }

  const counts = {
    total: results.length,
    admitted: results.filter((item) => item.outcome === "admitted").length,
    alreadyPinned: results.filter((item) => item.outcome === "already_pinned").length,
    wouldAdmit: results.filter((item) => item.outcome === "would_admit").length,
    skipped: results.filter((item) => item.outcome === "skipped").length,
  };
  return { projectId: project.id, projectSlug: project.slug, dryRun: Boolean(args.dryRun), gate, counts, tasks: results };
}

export async function unpinQuiescentTask(args: {
  projectSlug: string;
  taskIdOrKey: string;
  operatorUserId: string;
}) {
  await requireOwnerOperator(args.operatorUserId);
  const task = await db.task.findFirst({
    where: {
      deletedAt: null,
      project: { slug: args.projectSlug },
      OR: [{ id: args.taskIdOrKey }, { workItemKey: args.taskIdOrKey }],
    },
    select: { id: true, workflowEngine: true },
  });
  if (!task) throw new Error(`Task not found in ${args.projectSlug}: ${args.taskIdOrKey}`);
  if (task.workflowEngine !== ENGINE_ORCHESTRATOR_V2) {
    throw new Error("Task is not durably owned by orchestrator_v2.");
  }
  return db.$transaction((tx) => unpinFromV2(tx, task.id, { operatorUserId: args.operatorUserId }));
}

export async function getProjectAdmissionReport(projectSlug: string) {
  const project = await db.project.findUnique({
    where: { slug: projectSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!project) throw new Error(`Project not found: ${projectSlug}`);
  const tasks = await db.task.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: { id: true, workItemKey: true, title: true, status: true, private: true, workflowEngine: true },
  });
  const projectInCohort = isProjectInMutationCohort(project.slug);
  const inspected = [];
  for (const task of tasks) {
    const inspection = await db.$transaction((tx) => inspectTaskAdmission(tx, task.id, { projectInCohort }));
    inspected.push({ ...task, inspection });
  }
  const skippedReasons: Record<string, number> = {};
  for (const row of inspected) {
    if (!row.inspection || row.inspection.eligible) continue;
    skippedReasons[row.inspection.code] = (skippedReasons[row.inspection.code] ?? 0) + 1;
  }
  return {
    project,
    configuredEffectful: projectInCohort,
    counts: {
      total: inspected.length,
      admitted: inspected.filter((row) => row.workflowEngine === ENGINE_ORCHESTRATOR_V2).length,
      eligible: inspected.filter((row) => row.inspection?.code === "eligible").length,
      skipped: inspected.filter((row) => row.inspection && !row.inspection.eligible).length,
    },
    skippedReasons,
    tasks: inspected,
  };
}
