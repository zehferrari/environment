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
  messageId?: string;
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
    } else if (arg === "--message-id" && next) {
      out.messageId = next;
      i += 1;
    } else if (arg === "--required-action" && next) {
      out.requiredAction = next;
      i += 1;
    }
  }
  return out;
}

const EXPECTED_STATUS_BY_KIND: Readonly<Record<string, string>> = {
  "pm-backlog-plan-missing": "Backlog",
  "pm-action-plan-missing": "To Do",
  "pm-action-plan-awaiting-approval": "To Do",
  "pm-todo-not-started": "To Do",
  "pm-in-progress-stale": "In Progress",
  "pm-blocker-response-awaiting-assignee": "In Progress",
  "pm-review-awaiting-reviewer": "Review",
  "pm-review-feedback-awaiting-assignee": "Review",
  "pm-review-response-awaiting-assignee": "Review",
};

function skip(args: {
  taskId: string;
  project: string;
  agent: string;
  kind?: string;
  reason: string;
  status?: string;
}) {
  console.log(JSON.stringify({ ok: true, skipped: true, ...args }, null, 2));
}

function reasonForKind(kind: string | undefined): TaskWorkflowNotificationReason {
  switch (kind) {
    case "pm-backlog-plan-missing":
      return "backlog_plan_requested";
    case "pm-action-plan-missing":
      return "todo_start_required";
    case "pm-action-plan-awaiting-approval":
      return "action_plan_review_requested";
    case "pm-todo-not-started":
      return "todo_start_required";
    case "pm-in-progress-stale":
    case "pm-blocker-response-awaiting-assignee":
      return "monitor_recovery";
    case "pm-review-awaiting-reviewer":
    // Targets the REVIEWER: informal feedback was never formalized via
    // review_feedback/review_done, so the review turn is theirs to finish.
    case "pm-review-feedback-awaiting-assignee":
      return "review_requested";
    default:
      return "monitor_recovery";
  }
}

function defaultRequiredAction(status: string, kind: string | undefined): string {
  if (kind === "pm-backlog-plan-missing" || kind === "pm-action-plan-missing") {
    return "Call action=submit_plan with one concise structured Action Plan. A plain chat reply is discussion only. Do not change status or start work until reviewer/reporter approval stamps approved_on.";
  }
  if (kind === "pm-action-plan-awaiting-approval") {
    return "Review the Action Plan. If acceptable, approve it so approved_on is set; otherwise reply with concise feedback in Action Plan.";
  }
  if (kind === "pm-todo-not-started") {
    return "The Action Plan is approved. Move the task to In Progress through the workflow endpoint, then start work immediately. Do not post an acknowledgement unless you have new task information to add.";
  }
  if (kind === "pm-in-progress-stale") {
    return "Continue implementation now. If completed, use ready_for_review with one concise note. Never move incomplete work to Review as a waiting room. Task execution remains with the visible assignee; independent work for another agent must be a separate explicitly assigned PM task. Use flag_blocker only for a human/external dependency. If an Epic-child task's open checks require a remotely deployable commit, use publish_checkpoint only with a fresh explicit active-owner authorization comment id; PM will publish only the Epic branch and keep the task In Progress.";
  }
  if (kind === "pm-blocker-response-awaiting-assignee") {
    return "A decision owner responded after your active blocker. Re-evaluate it now: if the dependency is resolved, call action=clear_blocker with the evidence and resume; otherwise leave the alert set and post only material new blocker evidence.";
  }
  if (kind === "pm-review-awaiting-reviewer") {
    return "Review the completed work using the full task context. If satisfied, move the task to Done without posting an approval-only comment. If changes or blockers remain, call action=review_feedback with concise feedback so the task returns to the front of To Do for the assignee.";
  }
  if (kind === "pm-review-feedback-awaiting-assignee") {
    return "You left review feedback as a comment but never formalized it. Call action=review_feedback with a concise summary so the task returns to the front of To Do for the assignee, or action=review_done if the work is acceptable.";
  }
  if (kind === "pm-review-response-awaiting-assignee") {
    return "A response arrived while this task is in Review. Reply in the task comments if a response is needed. Do not call action=start from Review — if code changes are required, the reviewer must call action=review_feedback to return the task to the front of To Do.";
  }
  if (kind === "pm-epic-not-open") {
    return "This task's parent Epic is not actionable (Backlog/Done). A human must move the Epic to To Do or In Progress if work should continue, or return the task to Backlog/Done. Agents must not change Epic status.";
  }
  return `Follow the Mission Control workflow for the current ${status} task state.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId || !args.agent) {
    throw new Error("Usage: pm-workflow-nudge --task-id <id> --agent <slug> [--kind <kind>] [--message-id <id>] [--required-action <text>]");
  }

  const [task, targetUser, monitorSender] = await Promise.all([
    db.task.findUnique({
      where: { id: args.taskId },
      select: {
        id: true,
        title: true,
        status: true,
        statusChangedAt: true,
        approvedOn: true,
        deletedAt: true,
        project: { select: { slug: true } },
        assignee: { select: { agent: { select: { slug: true } } } },
        actingManager: { select: { agent: { select: { slug: true } } } },
        reporter: { select: { agent: { select: { slug: true } } } },
        epic: {
          select: {
            status: true,
            actingManager: { select: { agent: { select: { slug: true } } } },
          },
        },
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
    }),
  ]);

  if (!task || task.deletedAt) throw new Error(`Task not found or deleted: ${args.taskId}`);

  const expectedStatus = args.kind ? EXPECTED_STATUS_BY_KIND[args.kind] : undefined;
  if (expectedStatus && task.status !== expectedStatus) {
    skip({
      taskId: task.id,
      project: task.project.slug,
      agent: args.agent,
      kind: args.kind,
      status: task.status,
      reason: `incident-stale-task-is-${task.status}`,
    });
    return;
  }

  // Channel-health incidents are observations about one exact message/run,
  // not permission to wake whichever agent happened to own the task when the
  // monitor first saw it. Revalidate the identity and current workflow owner
  // at the final write boundary. This closes the race where a task moves to
  // Review during the monitor's T1/T2/T3 confirmation windows.
  if (args.kind?.startsWith("pm-channel-")) {
    if (!args.messageId) {
      skip({
        taskId: task.id,
        project: task.project.slug,
        agent: args.agent,
        kind: args.kind,
        status: task.status,
        reason: "channel-incident-missing-message-id",
      });
      return;
    }

    const sourceMessage = await db.agentChatMessage.findUnique({
      where: { id: args.messageId },
      select: {
        taskId: true,
        agentSlug: true,
        targetValue: true,
        createdAt: true,
        deletedAt: true,
      },
    });
    const addressedAgent = sourceMessage?.agentSlug === "room" && sourceMessage.targetValue?.startsWith("agent:")
      ? sourceMessage.targetValue.slice("agent:".length)
      : sourceMessage?.agentSlug;
    if (
      !sourceMessage ||
      sourceMessage.deletedAt ||
      sourceMessage.taskId !== task.id ||
      addressedAgent !== args.agent
    ) {
      skip({
        taskId: task.id,
        project: task.project.slug,
        agent: args.agent,
        kind: args.kind,
        status: task.status,
        reason: "channel-incident-message-no-longer-matches",
      });
      return;
    }

    const currentWorkflowAgent = task.status === "Review"
      ? task.actingManager?.agent?.slug
        ?? (task.epic?.status === "To Do" || task.epic?.status === "In Progress"
          ? task.epic.actingManager?.agent?.slug
          : undefined)
        ?? task.reporter?.agent?.slug
      : task.assignee?.agent?.slug;
    if (currentWorkflowAgent !== args.agent) {
      skip({
        taskId: task.id,
        project: task.project.slug,
        agent: args.agent,
        kind: args.kind,
        status: task.status,
        reason: "channel-incident-target-is-not-current-workflow-owner",
      });
      return;
    }

    if (task.statusChangedAt && sourceMessage.createdAt < task.statusChangedAt) {
      skip({
        taskId: task.id,
        project: task.project.slug,
        agent: args.agent,
        kind: args.kind,
        status: task.status,
        reason: "channel-incident-predates-current-task-state",
      });
      return;
    }

    const laterSuccessfulRun = await db.pmChannelRun.findFirst({
      where: {
        taskId: task.id,
        agentSlug: args.agent,
        createdAt: { gte: sourceMessage.createdAt },
        status: { in: ["completed", "complete"] },
      },
      select: { id: true },
    });
    if (laterSuccessfulRun) {
      skip({
        taskId: task.id,
        project: task.project.slug,
        agent: args.agent,
        kind: args.kind,
        status: task.status,
        reason: "channel-incident-already-has-successful-run",
      });
      return;
    }
  }

  if (!targetUser) {
    // Human (or inactive-agent) target: degrade to a clear rc=0 skip so the
    // monitor ladder never burns wake/restart attempts on a non-agent user.
    const namedUser = await db.user.findFirst({
      where: { username: args.agent },
      select: { username: true, kind: true, status: true },
    });
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: "target-not-active-agent",
      taskId: task.id,
      project: task.project.slug,
      agent: args.agent,
      kind: args.kind ?? null,
      target: namedUser,
      message: namedUser
        ? `${args.agent} is a ${namedUser.status} ${namedUser.kind} user — PM-channel nudges only reach active agents; notify them via Telegram or the board instead.`
        : `No user matches agent slug ${args.agent} — nothing to nudge.`,
    }, null, 2));
    return;
  }
  const sender = monitorSender ?? await db.user.findFirst({
    where: { kind: "human", status: "active", isOwner: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, kind: true },
  });
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
    } else if (autoStart.reason === "not_approved") {
      requiredAction = "Call action=submit_plan with the structured actionPlan payload now, then stop for reviewer approval. A plain Action Plan chat reply is discussion only and cannot satisfy approved_on.";
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
