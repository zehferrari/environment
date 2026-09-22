// Narrow operator repair. Defaults to inspection; never dispatches a message.
import { db } from "@/lib/db";
import { settleDoneTaskExecution, supersedeObsoleteTaskNotifications } from "@/lib/tasks/notification-reconciliation";

async function main() {
  const [taskId, option] = process.argv.slice(2);
  if (!taskId || (option && option !== "--apply")) {
    throw new Error("Usage: node --import tsx scripts/reconcile-completed-task-notifications.ts TASK_ID [--apply]");
  }
  const result = await db.$transaction(async (tx) => {
    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, projectId: true, statusChangedAt: true } });
    if (task.status !== "Done") throw new Error("Only completed tasks can use this repair.");
    if (option !== "--apply") return { taskId, status: task.status, apply: false };
    const superseded = await supersedeObsoleteTaskNotifications(tx, taskId);
    const remainingFailure = await tx.workflowOutbox.findFirst({ where: { taskId, status: "failed" }, select: { id: true } });
    const failedProcedure = await tx.taskProcedureRun.findFirst({ where: { taskId, status: "operational_error" }, select: { id: true } });
    if (remainingFailure || failedProcedure) throw new Error("Unrelated current failures remain; refusing to clear the execution warning.");
    await settleDoneTaskExecution(tx, taskId, task.projectId, task.statusChangedAt ?? new Date());
    return { taskId, status: task.status, apply: true, superseded };
  });
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
