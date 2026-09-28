import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isActionableEpicStatus, type ReviewOwnerTask } from "./workflow-actors";

/** An independent, available task reviewer takes first refusal; otherwise use
 * the actionable Epic manager. The reporter is a separate escalation target. */
export async function resolvePermissionReviewerId(task: Pick<ReviewOwnerTask, "assigneeId" | "actingManagerId" | "epic">, client: Prisma.TransactionClient = db): Promise<string | null> {
  const candidates = [...new Set([task.actingManagerId,
    isActionableEpicStatus(task.epic?.status) ? task.epic?.actingManagerId : null,
  ].filter((id): id is string => Boolean(id) && id !== task.assigneeId))];
  if (!candidates.length) return null;
  const available = await client.user.findMany({ where: { id: { in: candidates }, status: "active" },
    select: { id: true, kind: true, agent: { select: { deactivatedAt: true } } } });
  return candidates.find(id => available.some(user => user.id === id
    && (user.kind === "human" || user.agent && !user.agent.deactivatedAt))) ?? null;
}

