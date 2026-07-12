import { db } from "@/lib/db";
import {
  sendTaskWorkflowNotification,
  type TaskWorkflowNotificationReason,
} from "@/lib/agents/workflow/notifications/task";
import { startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";

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
    case "pm-action-plan-missing":
      return "backlog_plan_requested";
    case "pm-action-plan-awaiting-approval":
      return "action_plan_review_requested";
    case "pm-todo-not-started":
      return "todo_start_required";
    case "pm-review-awaiting-reviewer":
      return "review_requested";
    case "pm-review-feedback-awaiting-assignee":
    case "pm-review-response-awaiting-assignee":
      return "review_feedback";
    default:
      return "monitor_recovery";
  }
}

function defaultRequiredAction(status: string, kind: string | undefined): string {
  if (kind === "pm-backlog-plan-missing" || kind === "pm-action-plan-missing") {
    return "Post one concise technical Action Plan message. Do not change status or start work until reviewer/reporter approval stamps approved_on.";
  }
  if (kind === "pm-action-plan-awaiting-approval") {
    return "Review the Action Plan. If acceptable, approve it so approved_on is set; otherwise reply with concise feedback in Action Plan.";
  }
  if (kind === "pm-todo-not-started") {
    return "The Action Plan is approved. Move the task to In Progress through the workflow endpoint, then start work immediately. Do not post an acknowledgement unless you have new task information to add.";
  }
  if (kind === "pm-in-progress-stale") {
    return "Continue implementation now, or move the task to Review through the workflow endpoint with one concise note if work is complete or waiting for reviewer/manager/reporter feedback.";
  }
  if (kind === "pm-review-awaiting-reviewer") {
    return "Review the completed work using the full task context. If satisfied, move the task to Done without posting an approval-only comment. Leave concise feedback only when changes or blockers remain.";
  }
  if (kind === "pm-review-feedback-awaiting-assignee" || kind === "pm-review-response-awaiting-assignee") {
    return "If the task is in Review because it was waiting for feedback or an external response, call action=start to resume it in In Progress. Address the feedback/response, then call action=ready_for_review again with one concise note.";
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
      where: {
        status: "active",
        kind: "agent",
        agent: { is: { role: "monitor", deactivatedAt: null } },
      },
      select: { id: true, username: true, kind: true },
    }) ?? db.user.findFirst({
      where: { kind: "human", status: "active", isOwner: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true, kind: true },
    }),
  ]);

  if (!task || task.deletedAt) throw new Error(`Task not found or deleted: ${args.taskId}`);
  if (!targetUser) throw new Error(`Active agent user not found for ${args.agent}`);
  if (!sender) throw new Error("No active sender found for PM workflow nudge");

  const actor = {
    id: sender.id,
    username: sender.username,
    kind: sender.kind === "agent" ? "agent" as const : "human" as const,
  };
  let requiredAction = args.requiredAction ?? defaultRequiredAction(task.status, args.kind);
  let autoStarted = false;
  if (args.kind === "pm-todo-not-started") {
    const autoStart = await startApprovedTodoTaskIfIdle({
      taskId: task.id,
      actor,
      via: "pm-workflow-nudge",
    });
    if (autoStart.started) {
      autoStarted = true;
      requiredAction = "PM already moved this approved To Do task to In Progress because you have no other In Progress task. Start implementation now; reply only for new progress, a blocker, or a necessary question.";
    } else if (autoStart.reason === "busy") {
      console.log(JSON.stringify({
        ok: true,
        skipped: true,
        reason: "assignee_busy",
        taskId: task.id,
        project: task.project.slug,
        agent: args.agent,
        kind: args.kind ?? null,
        activeTask: autoStart.activeTask ?? null,
      }, null, 2));
      return;
    }
  }
  const body = [
    `PM workflow recovery for @${args.agent}:`,
    "",
    `Task "${task.title}" is currently in ${autoStarted ? "In Progress" : task.status}.`,
    `The monitor agent detected workflow drift${args.kind ? ` (${args.kind})` : ""}.`,
    "",
    `Required action: ${requiredAction}`,
    "",
    "Read the full PM context packet attached to this turn, including task description, comments, Action Plan, activity, and project context. Use one concise visible reply only for a plan, new progress, blocker, feedback, review finding, or necessary question.",
  ].join("\n");

  const result = await sendTaskWorkflowNotification({
    taskId: task.id,
    targetUserId: targetUser.id,
    actor,
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
