import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { PmEvent } from "./index";

/**
 * The legacy PM event bus carries work-item titles into agent wake text. Keep
 * its visibility boundary aligned with browser-visible task access: a task is
 * public only when it and its immediate Epic/parent scopes are public.
 */
export function effectivelyPublicTaskWhere(taskId: string): Prisma.TaskWhereInput {
  return {
    id: taskId,
    archivedAt: null,
    deletedAt: null,
    private: false,
    AND: [
      { OR: [{ epicId: null }, { epic: { private: false } }] },
      {
        OR: [
          { parentTaskId: null },
          {
            parent: {
              private: false,
              OR: [{ epicId: null }, { epic: { private: false } }],
            },
          },
        ],
      },
    ],
  };
}

export async function isEffectivelyPublicTask(taskId: string): Promise<boolean> {
  return Boolean(await db.task.findFirst({
    where: effectivelyPublicTaskWhere(taskId),
    select: { id: true },
  }));
}

export async function isPublicEpic(epicId: string): Promise<boolean> {
  return Boolean(await db.epic.findFirst({
    where: { id: epicId, archivedAt: null, deletedAt: null, private: false },
    select: { id: true },
  }));
}

/** Resolve the current effective visibility rather than trusting event data. */
export async function isEffectivelyPublicPmEvent(event: PmEvent): Promise<boolean> {
  if (event.kind === "deployment.approved") {
    return event.payload.scope === "epic"
      ? isPublicEpic(event.payload.scopeId)
      : isEffectivelyPublicTask(event.payload.scopeId);
  }
  return isEffectivelyPublicTask(event.task.id);
}
