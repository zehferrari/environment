// One-shot (ENV-60 follow-up): move every task that still has at least one
// UNCOMPLETED sub-task (checklist item) back to "To Do" and unassign it
// (clearing assignee + Action Plan approval). The new sub-task model treats the
// checklist as the task's progress, so a task with open items is not finished.
//
// Read-only inventory. Phase E retired the direct repair writer; an operator
// must submit an authenticated typed command for each selected task.
//
//   pnpm tsx scripts/reopen-tasks-with-open-subtasks.ts            # dry run
//   pnpm tsx scripts/reopen-tasks-with-open-subtasks.ts            # inspect

import { db } from "@/lib/db";

async function main() {
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
    `READ ONLY — ${tasks.length} task(s) with open sub-tasks:\n`,
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

    changed += 1;
  }

  console.log(
    `\nFound ${changed} task(s). Submit authenticated operator commands with explicit evidence; this inventory cannot mutate workflow state.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
