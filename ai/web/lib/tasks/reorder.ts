"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

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
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthenticated");
  if (orderedIds.length === 0) return;

  await db.$transaction(
    orderedIds.map((id, index) =>
      db.task.update({
        where: { id },
        data: { rank: index },
      }),
    ),
  );

  if (revalidatePathHint) revalidatePath(revalidatePathHint);
}
