// One-shot (ENV-60 follow-up): move every task that still has at least one
// UNCOMPLETED sub-task (checklist item) back to "To Do" and unassign it
// (clearing assignee + Action Plan approval). The new sub-task model treats the
// checklist as the task's progress, so a task with open items is not finished.
//
// Safe by default: prints a dry-run plan. Pass --apply to write.
//
//   pnpm tsx scripts/reopen-tasks-with-open-subtasks.ts            # dry run
//   pnpm tsx scripts/reopen-tasks-with-open-subtasks.ts --apply    # execute

import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");

async function main() {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "workflow-reconciler-and-repair-tools",
    entryPoint: "main",
  });
  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      checklist: { some: { completedAt: null } },
    },
    select: {
      id: true,
      projectId: true,
      workItemKey: true,
      title: true,
      status: true,
      assigneeId: true,
      assignee: { select: { username: true } },
      _count: { select: { checklist: true } },
      checklist: { where: { completedAt: null }, select: { id: true } },
    },
  });

  if (tasks.length === 0) {
    console.log("No tasks with uncompleted sub-tasks. Nothing to do.");
    return;
  }

  console.log(
    `${APPLY ? "APPLYING" : "DRY RUN"} — ${tasks.length} task(s) with open sub-tasks:\n`,
  );

  let changed = 0;
  for (const task of tasks) {
    const open = task.checklist.length;
    const total = task._count.checklist;
    const needsMove = task.status !== "To Do";
    const needsUnassign = task.assigneeId !== null;
    const note = !needsMove && !needsUnassign ? " (already To Do + unassigned)" : "";
    console.log(
      `  ${task.workItemKey ?? task.id} — ${task.title}\n` +
        `      ${open}/${total} open · status ${task.status} → To Do · assignee ${task.assignee?.username ?? "(none)"} → (none)${note}`,
    );
    if (!needsMove && !needsUnassign) continue;

    if (APPLY) {
      const now = new Date();
      const maxRank = await db.task.aggregate({
        where: { status: "To Do", deletedAt: null },
        _max: { rank: true },
      });
      await db.$transaction([
        db.task.update({
          where: { id: task.id },
          data: {
            status: "To Do",
            rank: (maxRank._max.rank ?? 0) + 1,
            statusChangedAt: now,
            assignee: { disconnect: true },
            approvedOn: null,
            approvedBy: { disconnect: true },
          },
        }),
        ...(needsMove
          ? [
              db.activityLog.create({
                data: {
                  projectId: task.projectId,
                  taskId: task.id,
                  kind: "task.move",
                  payload: JSON.stringify({ from: task.status, to: "To Do", via: "reopen-open-subtasks" }),
                },
              }),
            ]
          : []),
        ...(needsUnassign
          ? [
              db.activityLog.create({
                data: {
                  projectId: task.projectId,
                  taskId: task.id,
                  kind: "task.assign",
                  payload: JSON.stringify({ from: task.assignee?.username ?? null, to: null, via: "reopen-open-subtasks" }),
                },
              }),
            ]
          : []),
      ]);
    }
    changed += 1;
  }

  console.log(
    `\n${APPLY ? "Updated" : "Would update"} ${changed} task(s).${APPLY ? "" : " Re-run with --apply to execute."}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
