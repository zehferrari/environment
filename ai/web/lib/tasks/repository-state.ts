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

export async function updateTaskRepositoryState(
  taskId: string,
  patch: RepositoryStatePatch,
  client: Prisma.TransactionClient | typeof db = db,
) {
  const {
    incrementAttempt,
    ...data
  } = patch;
  return client.taskRepositoryRun.upsert({
    where: { taskId },
    create: {
      taskId,
      ...data,
      attempt: incrementAttempt ? 1 : 0,
      version: 1,
    },
    update: {
      ...data,
      ...(incrementAttempt ? { attempt: { increment: 1 } } : {}),
      version: { increment: 1 },
    },
  });
}

export async function reserveTaskRepositoryState(taskId: string) {
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
