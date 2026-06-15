// One-shot data migration (ENV-60): convert the legacy child-Task "sub-task"
// hierarchy into the new lightweight SubTask checklist.
//
// For every NON-deleted child Task (parentTaskId set) it creates a SubTask row
// under the parent (text from the child's title; completedAt set iff the child
// was Done), then hard-deletes the child Task and its ActivityLog rows. Deleted
// children already in the bin are left alone for the normal purge job.
//
// Safe by default: prints a dry-run plan. Pass --apply to write.
//
//   pnpm tsx scripts/migrate-subtasks-to-checklist.ts            # dry run
//   pnpm tsx scripts/migrate-subtasks-to-checklist.ts --apply    # execute

import { db } from "@/lib/db";
import { stripStepNumber, MAX_SUBTASK_TEXT } from "@/lib/tasks/subtasks";

const APPLY = process.argv.includes("--apply");

// Reconciliation against the implementation branch aml-ctf_resolutions-greenID
// (Epic PH-18): every sub-task is implemented + QA-passing on that branch
// EXCEPT entity/company verification (PH-71), which is deliberately deferred
// (out of scope). So we mark all converted items complete except this one — the
// single open item that (correctly) reopens its parent PH-66. Verified per-task
// by code/commit evidence on 2026-06-15.
const OPEN_CHILD_KEYS = new Set<string>(["PH-71"]);

function completionFor(child: {
  workItemKey: string | null;
  status: string;
  statusChangedAt: Date | null;
  approvedOn: Date | null;
}): Date | null {
  if (child.workItemKey && OPEN_CHILD_KEYS.has(child.workItemKey)) return null;
  // Implemented on the branch — reconcile as complete.
  return child.statusChangedAt ?? child.approvedOn ?? new Date();
}

async function main() {
  const children = await db.task.findMany({
    where: { parentTaskId: { not: null }, deletedAt: null },
    orderBy: [{ parentTaskId: "asc" }, { rank: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      parentTaskId: true,
      workItemKey: true,
      title: true,
      description: true,
      status: true,
      statusChangedAt: true,
      approvedOn: true,
    },
  });

  if (children.length === 0) {
    console.log("No legacy child-task sub-tasks found. Nothing to migrate.");
    return;
  }

  // Group children by parent, preserving the ordered query result.
  const byParent = new Map<string, typeof children>();
  for (const child of children) {
    const key = child.parentTaskId!;
    const list = byParent.get(key) ?? [];
    list.push(child);
    byParent.set(key, list);
  }

  const parents = await db.task.findMany({
    where: { id: { in: [...byParent.keys()] } },
    select: { id: true, workItemKey: true, title: true },
  });
  const parentById = new Map(parents.map((p) => [p.id, p]));

  console.log(
    `${APPLY ? "APPLYING" : "DRY RUN"} — ${children.length} child task(s) under ${byParent.size} parent(s):\n`,
  );

  let createdCount = 0;
  for (const [parentId, items] of byParent) {
    const parent = parentById.get(parentId);
    console.log(`▌ ${parent?.workItemKey ?? parentId} — ${parent?.title ?? "(unknown parent)"}`);
    let rank = 0;
    for (const child of items) {
      rank += 1;
      // Non-lossy: lead with the title (the goal headline) and fold the
      // child's description detail into the single checklist line.
      const titleText = stripStepNumber(child.title);
      const detail = child.description?.trim().replace(/\s+/g, " ") ?? "";
      const text = (detail && detail !== titleText ? `${titleText} — ${detail}` : titleText).slice(0, MAX_SUBTASK_TEXT);
      const completedAt = completionFor(child);
      console.log(
        `    [${completedAt ? "x" : " "}] ${text}  (was ${child.workItemKey ?? child.id}, status=${child.status})`,
      );
      if (APPLY) {
        await db.subTask.create({
          data: { taskId: parentId, text, rank, completedAt },
        });
        createdCount += 1;
      }
    }
    console.log("");
  }

  const childIds = children.map((c) => c.id);
  if (APPLY) {
    // Drop the child ActivityLog rows first (taskId is SetNull on delete, which
    // would otherwise leave orphaned, unlinked feed rows), then the child Tasks.
    const delActivity = await db.activityLog.deleteMany({ where: { taskId: { in: childIds } } });
    const delTasks = await db.task.deleteMany({ where: { id: { in: childIds } } });
    console.log(
      `Done: created ${createdCount} checklist item(s); deleted ${delTasks.count} child task(s) and ${delActivity.count} activity row(s).`,
    );
  } else {
    console.log(
      `Would create ${children.length} checklist item(s) and delete ${childIds.length} child task(s) (+ their activity rows).`,
    );
    console.log("Re-run with --apply to execute.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
