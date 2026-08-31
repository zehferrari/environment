import type { Prisma } from "@prisma/client";
import { isActiveOwnerPrincipal } from "@/lib/auth/roles";
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
  targetTaskSelectors: string[] | null;
  outsideApprovedTasks: Array<{
    taskId: string;
    workItemKey: string | null;
    status: string;
    workflowEngine: string;
  }>;
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
  if (!isActiveOwnerPrincipal(operator)) {
    throw new Error("Effectful admission requires the active Mission Control owner.");
  }
  return operator;
}

async function requireProductionApproval(
  evidence: RolloutEvidence,
  operator: Awaited<ReturnType<typeof requireOwnerOperator>>,
) {
  if (evidence.mode !== "project_cohort" || !evidence.productionCohort) return;
  const production = evidence.productionCohort;
  if (production.approval.ownerUsername !== operator.username) {
    throw new Error("Production cohort approval owner does not match the active owner operator.");
  }
  const authorization = await db.comment.findUnique({
    where: { id: production.approval.authorizationCommentId },
    select: {
      taskId: true,
      body: true,
      createdAt: true,
      deletedAt: true,
      commentKind: true,
      isGenerated: true,
      userId: true,
      user: { select: { username: true, kind: true, status: true, isOwner: true } },
    },
  });
  if (
    !authorization ||
    authorization.taskId !== production.approval.taskId ||
    authorization.deletedAt ||
    authorization.userId !== operator.id ||
    authorization.user.username !== production.approval.ownerUsername ||
    !isActiveOwnerPrincipal(authorization.user) ||
    authorization.commentKind !== "blocker_notice" ||
    !authorization.isGenerated ||
    authorization.createdAt.toISOString() !== new Date(production.approval.approvedAt).toISOString()
  ) {
    throw new Error("Production admission requires the exact live reporter-approval grant recorded in the evidence.");
  }
  const grantRows = await db.activityLog.findMany({
    where: {
      taskId: production.approval.taskId,
      userId: operator.id,
      kind: "task.blocker.permission.granted",
    },
    select: { payload: true },
  });
  const grant = grantRows.map((row) => {
    try {
      return JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    } catch {
      return null;
    }
  }).find((payload) =>
    payload?.authorizationCommentId === production.approval.authorizationCommentId &&
    payload.permissionKind === "reporter_approval");
  if (!grant || typeof grant.permissionScope !== "string") {
    throw new Error("Production admission approval is not linked to a reporter_approval permission round.");
  }
  const scope = `${grant.permissionScope}\n${authorization.body}`.toLowerCase();
  const requiredScopeTokens = [
    evidence.targetProjectSlug,
    production.deployedEpicSha,
    "PM_ORCHESTRATOR_V2_MUTATION_PROJECTS",
    ...production.taskIdsOrKeys,
    "observation",
    String(production.observationWindow.minimumMinutes),
    "rollback",
    "stop condition",
  ];
  const missingScopeTokens = requiredScopeTokens.filter((token) => !scope.includes(token.toLowerCase()));
  if (missingScopeTokens.length > 0) {
    throw new Error(`Production approval scope is incomplete; missing: ${missingScopeTokens.join(", ")}`);
  }
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
  const operator = await requireOwnerOperator(args.operatorUserId);
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

  const targetTaskSelectors = args.evidence.mode === "project_cohort"
    ? [...new Set((args.evidence.productionCohort?.taskIdsOrKeys ?? []).map((value) => value.trim()))]
    : null;

  const projectTasks = await db.task.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      workItemKey: true,
      title: true,
      status: true,
      private: true,
      workflowEngine: true,
    },
  });
  const tasks = targetTaskSelectors
    ? projectTasks.filter((task) => targetTaskSelectors.includes(task.id) || (
        task.workItemKey !== null && targetTaskSelectors.includes(task.workItemKey)
      ))
    : projectTasks;
  const selectedTaskIds = new Set(tasks.map((task) => task.id));
  const outsideApprovedTasks = targetTaskSelectors
    ? projectTasks.filter((task) => !selectedTaskIds.has(task.id)).map((task) => ({
        taskId: task.id,
        workItemKey: task.workItemKey,
        status: task.status,
        workflowEngine: task.workflowEngine,
      }))
    : [];
  if (targetTaskSelectors) {
    const resolvedTaskIds = new Set(tasks.map((task) => task.id));
    const missingSelectors = targetTaskSelectors.filter((selector) => !projectTasks.some((task) =>
      task.id === selector || task.workItemKey === selector));
    if (missingSelectors.length > 0) {
      throw new Error(`Production cohort task selector(s) not found in ${project.slug}: ${missingSelectors.join(", ")}`);
    }
    if (resolvedTaskIds.size !== targetTaskSelectors.length) {
      throw new Error("Production cohort task selectors must resolve to distinct tasks; do not name the same task by both id and key.");
    }
  }
  await requireProductionApproval(args.evidence, operator);

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
        evidenceId: args.evidence.evidenceId,
        cohortStage: args.evidence.productionCohort?.stage ?? null,
        authorizationCommentId: args.evidence.productionCohort?.approval.authorizationCommentId ?? null,
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
  return {
    projectId: project.id,
    projectSlug: project.slug,
    dryRun: Boolean(args.dryRun),
    targetTaskSelectors,
    outsideApprovedTasks,
    gate,
    counts,
    tasks: results,
  };
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

export async function getProjectAdmissionReport(
  projectSlug: string,
  opts: { taskIdsOrKeys?: string[]; planned?: boolean } = {},
) {
  const project = await db.project.findUnique({
    where: { slug: projectSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!project) throw new Error(`Project not found: ${projectSlug}`);
  const projectTasks = await db.task.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: { id: true, workItemKey: true, title: true, status: true, private: true, workflowEngine: true },
  });
  const taskIdsOrKeys = [...new Set((opts.taskIdsOrKeys ?? []).map((value) => value.trim()).filter(Boolean))];
  const tasks = taskIdsOrKeys.length > 0
    ? projectTasks.filter((task) => taskIdsOrKeys.includes(task.id) || (
        task.workItemKey !== null && taskIdsOrKeys.includes(task.workItemKey)
      ))
    : projectTasks;
  if (taskIdsOrKeys.length > 0) {
    const missingSelectors = taskIdsOrKeys.filter((selector) => !projectTasks.some((task) =>
      task.id === selector || task.workItemKey === selector));
    if (missingSelectors.length > 0) {
      throw new Error(`Admission report task selector(s) not found in ${project.slug}: ${missingSelectors.join(", ")}`);
    }
    if (new Set(tasks.map((task) => task.id)).size !== taskIdsOrKeys.length) {
      throw new Error("Admission report task selectors must resolve to distinct tasks.");
    }
  }
  const configuredEffectful = isProjectInMutationCohort(project.slug);
  const projectInCohort = configuredEffectful || Boolean(opts.planned);
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
    configuredEffectful,
    inspectionAssumedEffectful: Boolean(opts.planned) && !configuredEffectful,
    targetTaskSelectors: taskIdsOrKeys.length > 0 ? taskIdsOrKeys : null,
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
