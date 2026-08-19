import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND =
  "task.workflow.legacy_boundary.invoked";

export type LegacyWorkflowBoundaryId =
  | "agent-task-workflow-route"
  | "agent-epic-workflow-route"
  | "browser-board-move-actions"
  | "task-detail-server-actions"
  | "auto-start-and-queue-refill"
  | "review-submission-and-validation"
  | "review-decision-and-finalization"
  | "epic-human-actions"
  | "proposal-application"
  | "workflow-reconciler-and-repair-tools"
  | "subtask-checklist-actions";

/**
 * Durable, best-effort invocation counter for legacy workflow boundaries.
 *
 * This deliberately runs before boundary guards and outside their mutation
 * transactions: E5 needs attempted legacy invocations, including rejected
 * ones, rather than a count derived only from committed task transitions.
 * Counter persistence must never change a boundary's response semantics.
 */
export async function recordLegacyWorkflowBoundaryInvocation(args: {
  legacyBoundary: LegacyWorkflowBoundaryId;
  entryPoint: string;
  projectId?: string | null;
  taskId?: string | null;
  userId?: string | null;
  client?: Prisma.TransactionClient | typeof db;
}) {
  try {
    const client = args.client ?? db;
    await client.activityLog.create({
      data: {
        projectId: args.projectId ?? null,
        taskId: args.taskId ?? null,
        userId: args.userId ?? null,
        kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
        payload: JSON.stringify({
          legacyBoundary: args.legacyBoundary,
          entryPoint: args.entryPoint,
        }),
      },
    });
  } catch (error) {
    console.error(
      "[workflow-boundary] failed to record legacy invocation",
      args.legacyBoundary,
      args.entryPoint,
      error,
    );
  }
}
