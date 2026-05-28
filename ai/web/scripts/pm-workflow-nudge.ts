import { db } from "@/lib/db";
import {
  sendTaskWorkflowNotification,
  type TaskWorkflowNotificationReason,
} from "@/lib/agents/task-workflow-notifications";

type Args = {
  taskId?: string;
  agent?: string;
  kind?: string;
  requiredAction?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--task-id" && next) {
      out.taskId = next;
      i += 1;
    } else if (arg === "--agent" && next) {
      out.agent = next;
      i += 1;
    } else if (arg === "--kind" && next) {
      out.kind = next;
      i += 1;
    } else if (arg === "--required-action" && next) {
      out.requiredAction = next;
      i += 1;
    }
  }
  return out;
}

function reasonForKind(kind: string | undefined): TaskWorkflowNotificationReason {
  switch (kind) {
    case "pm-backlog-plan-missing":
      return "backlog_plan_requested";
    case "pm-todo-not-started":
      return "todo_start_required";
    case "pm-review-awaiting-reviewer":
      return "review_requested";
    case "pm-review-feedback-awaiting-assignee":
      return "review_feedback";
    default:
      return "monitor_recovery";
  }
}

function defaultRequiredAction(status: string, kind: string | undefined): string {
  if (kind === "pm-backlog-plan-missing") {
    return "Post a visible task comment with your implementation plan or perspective. Do not change status or start work while the task is in Backlog.";
  }
  if (kind === "pm-todo-not-started") {
    return "Move the task to In Progress through the workflow endpoint, then start work immediately. Do not post an acknowledgement unless you have new task information to add.";
  }
  if (kind === "pm-in-progress-stale") {
    return "Continue implementation now, post a visible progress/blocker comment if needed, or move completed work to Review through the workflow endpoint.";
  }
  if (kind === "pm-review-awaiting-reviewer") {
    return "Review the completed work using the full task context. If satisfied, move the task to Done without posting an approval-only comment. Leave concise feedback only when changes or blockers remain.";
  }
  if (kind === "pm-review-feedback-awaiting-assignee") {
    return "Respond to the reviewer feedback, continue the task, and move it back to Review when addressed.";
  }
  return `Follow the Mission Control workflow for the current ${status} task state.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId || !args.agent) {
    throw new Error("Usage: pm-workflow-nudge --task-id <id> --agent <slug> [--kind <kind>] [--required-action <text>]");
  }

  const [task, targetUser, sender] = await Promise.all([
    db.task.findUnique({
      where: { id: args.taskId },
      select: {
        id: true,
        title: true,
        status: true,
        deletedAt: true,
        project: { select: { slug: true } },
      },
    }),
    db.user.findFirst({
      where: {
        status: "active",
        kind: "agent",
        agent: { is: { slug: args.agent, deactivatedAt: null } },
      },
      select: { id: true, username: true, kind: true },
    }),
    db.user.findFirst({
      where: { username: "karen", status: "active" },
      select: { id: true, username: true, kind: true },
    }) ?? db.user.findFirst({
      where: { username: "zeh", status: "active" },
      select: { id: true, username: true, kind: true },
    }) ?? db.user.findFirst({
      where: { kind: "human", status: "active" },
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true, kind: true },
    }),
  ]);

  if (!task || task.deletedAt) throw new Error(`Task not found or deleted: ${args.taskId}`);
  if (!targetUser) throw new Error(`Active agent user not found for ${args.agent}`);
  if (!sender) throw new Error("No active sender found for PM workflow nudge");

  const requiredAction = args.requiredAction ?? defaultRequiredAction(task.status, args.kind);
  const body = [
    `PM workflow recovery for @${args.agent}:`,
    "",
    `Task "${task.title}" is currently in ${task.status}.`,
    `Karen detected workflow drift${args.kind ? ` (${args.kind})` : ""}.`,
    "",
    `Required action: ${requiredAction}`,
    "",
    "Read the full PM context packet attached to this turn, including task description, comments, activity, task chat, and project context. Use a visible task comment only for a plan, new progress, blocker, feedback, review finding, or necessary question.",
  ].join("\n");

  const result = await sendTaskWorkflowNotification({
    taskId: task.id,
    targetUserId: targetUser.id,
    actor: {
      id: sender.id,
      username: sender.username,
      kind: sender.kind === "agent" ? "agent" : "human",
    },
    reason: reasonForKind(args.kind),
    body,
  });

  console.log(JSON.stringify({
    ok: Boolean(result?.delivery.ok),
    taskId: task.id,
    project: task.project.slug,
    agent: args.agent,
    kind: args.kind ?? null,
    messageId: result?.messageId ?? null,
    delivery: result?.delivery ?? null,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
