import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  effectiveEpicBranchName,
  effectiveTaskBranchName,
} from "@/lib/work-items/branches";

export const REPOSITORY_PHASES = [
  "reserved",
  "provisioning",
  "active",
  "validating",
  "review_ready",
  "finalizing",
  "completed",
  "action_required",
  "operational_error",
] as const;

export type RepositoryPhase = (typeof REPOSITORY_PHASES)[number];
export type RepositoryValidationOutcome =
  | "valid"
  | "valid_with_warning"
  | "invalid"
  | "operational_error";

type RepositoryStatePatch = {
  phase: RepositoryPhase;
  repositoryPath?: string | null;
  branchName?: string | null;
  worktreePath?: string | null;
  epicBranch?: string | null;
  baseSha?: string | null;
  candidateSha?: string | null;
  reviewedSha?: string | null;
  validationOutcome?: RepositoryValidationOutcome | null;
  repoTouched?: boolean | null;
  lastError?: string | null;
  incrementAttempt?: boolean;
};

const repositoryStateCompatibilitySelect = {
  id: true,
  taskId: true,
  workflowCycleId: true,
  repositoryPath: true,
  branchName: true,
  worktreePath: true,
  epicBranch: true,
  baseSha: true,
  candidateSha: true,
  reviewedSha: true,
  phase: true,
  validationOutcome: true,
  repoTouched: true,
  lastError: true,
  attempt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskRepositoryRunSelect;

async function repositoryCompatibilityMigrationApplied(
  client: Prisma.TransactionClient | typeof db,
) {
  const rows = await client.$queryRaw<Array<{ count: number | bigint }>>`
    SELECT COUNT(*) AS count
    FROM pragma_table_info('task_repository_runs')
    WHERE name IN ('publication_state_v2', 'replay_count_v2')
  `;
  return Number(rows[0]?.count ?? 0) === 2;
}

export async function updateTaskRepositoryState(
  taskId: string,
  patch: RepositoryStatePatch,
  client: Prisma.TransactionClient | typeof db = db,
) {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "review-submission-and-validation",
    entryPoint: "updateTaskRepositoryState",
    client,
  });
  const {
    incrementAttempt,
    ...data
  } = patch;
  const create = {
    taskId,
    ...data,
    attempt: incrementAttempt ? 1 : 0,
    version: 1,
  };
  const update = {
    ...data,
    ...(incrementAttempt ? { attempt: { increment: 1 } } : {}),
    version: { increment: 1 },
  };
  if (!(await repositoryCompatibilityMigrationApplied(client))) {
    // Checkpoints publish the new code before deployment applies its new
    // migration. The active repository row already exists at that fence, so
    // update while selecting only pre-migration columns. This keeps a
    // successful Git push from becoming an unrecoverable post-push P2022.
    return client.taskRepositoryRun.update({
      where: { taskId },
      data: update,
      select: repositoryStateCompatibilitySelect,
    });
  }
  return client.taskRepositoryRun.upsert({
    where: { taskId },
    create,
    update,
    select: repositoryStateCompatibilitySelect,
  });
}

export async function reserveTaskRepositoryState(taskId: string) {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "review-submission-and-validation",
    entryPoint: "reserveTaskRepositoryState",
  });
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      workItemKey: true,
      branchName: true,
      project: { select: { repositoryPath: true } },
      epic: {
        select: {
          workItemKey: true,
          branchName: true,
        },
      },
    },
  });
  if (!task) return null;
  return updateTaskRepositoryState(taskId, {
    phase: "reserved",
    repositoryPath: task.project.repositoryPath,
    branchName: effectiveTaskBranchName(task),
    epicBranch: task.epic ? effectiveEpicBranchName(task.epic) : null,
    validationOutcome: null,
    lastError: null,
  });
}

export async function resolveActiveMonitorAgent() {
  const monitors = await db.agent.findMany({
    where: {
      role: "monitor",
      deactivatedAt: null,
      user: { is: { status: "active", kind: "agent" } },
    },
    orderBy: { createdAt: "asc" },
    take: 2,
    select: {
      slug: true,
      user: { select: { id: true, username: true } },
    },
  });
  if (monitors.length !== 1 || !monitors[0]?.user) {
    return {
      ok: false as const,
      error: monitors.length === 0
        ? "No active Monitor Agent is registered."
        : "More than one active Monitor Agent is registered for this PM scope.",
    };
  }
  return {
    ok: true as const,
    agentSlug: monitors[0].slug,
    user: monitors[0].user,
  };
}
