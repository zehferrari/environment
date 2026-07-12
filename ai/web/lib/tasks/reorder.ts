"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { accessibleTaskWhere, requireViewer } from "@/lib/auth/permissions";

// Generic rank-only reorder. The caller is responsible for sending a
// list of ids that belong to a single logical group (column, parent
// task, epic+status). Ranks are written as 0..N so the values stay
// small; sort orders only matter within a scope, so collisions across
// scopes are fine. Lives outside lib/workflow because the workflow
// rules concern transitions/assignment, not ordering.
export async function reorderTasks(
  orderedIds: string[],
  revalidatePathHint?: string,
): Promise<void> {
  const viewer = await requireViewer();
  const ids = [...new Set(orderedIds)];
  if (ids.length === 0) return;
  const visibleCount = await db.task.count({
    where: accessibleTaskWhere(viewer, { id: { in: ids } }),
  });
  if (visibleCount !== ids.length) throw new Error("Not authorized");

  await db.$transaction(
    ids.map((id, index) =>
      db.task.update({
        where: { id },
        data: { rank: index },
      }),
    ),
  );

  if (revalidatePathHint) revalidatePath(revalidatePathHint);
}
