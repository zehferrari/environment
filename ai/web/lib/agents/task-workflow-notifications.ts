import { db } from "@/lib/db";
import { extractMentions } from "@/lib/markdown";
import {
  buildTaskAgentUserMessage,
  buildTaskNativeChannelPrompt,
} from "@/lib/agents/task-chat-context";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/session-bindings";
import {
  buildPmTurnSessionKey,
} from "@/lib/agents/openclaw-pm-channel";
import { sendOrQueueOpenClawPmChannelTurn } from "@/lib/agents/pm-channel-jobs";
import { PM_SILENT_REPLY_TOKEN } from "@/lib/agents/pm-silence";
import { createTaskWorkflowToken } from "@/lib/agents/task-workflow-token";
import { resolveDirectedFromComment } from "@/lib/agents/directed-targets";

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

type AgentTarget = {
  slug: string;
  userId: string;
  username: string;
  gatewayPort: number | null;
  reasons: Set<string>;
};

type AgentUser = {
  id: string;
  username: string;
  kind: string;
  status: string;
  agent: { slug: string; deactivatedAt: Date | null; gatewayPort: number | null } | null;
};

export type TaskWorkflowNotificationReason =
  | "backlog_plan_requested"
  | "todo_start_required"
  | "monitor_recovery"
  | "review_requested"
  | "review_feedback"
  | "review_done"
  | "policy_update";

function agentCallbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

function addTargetAgent(
  targetAgents: Map<string, AgentTarget>,
  user: AgentUser | null | undefined,
  reason: string,
  excludeAgentSlugs: ReadonlySet<string>,
) {
  if (
    !user ||
    user.kind !== "agent" ||
    user.status !== "active" ||
    !user.agent ||
    user.agent.deactivatedAt ||
    excludeAgentSlugs.has(user.agent.slug)
  ) {
    return;
  }

  const existing = targetAgents.get(user.agent.slug);
  if (existing) {
    existing.reasons.add(reason);
    return;
  }

  targetAgents.set(user.agent.slug, {
    slug: user.agent.slug,
    userId: user.id,
    username: user.username,
    gatewayPort: user.agent.gatewayPort,
    reasons: new Set([reason]),
  });
}

function workflowPrompt(args: {
  taskTitle: string;
  taskId: string;
  agentSlug: string;
  messageId: string;
  reason: TaskWorkflowNotificationReason;
  branchName: string | null;
  commitPrefix: string | null;
  repositoryPath: string | null;
}) {
  const token = createTaskWorkflowToken(args.messageId, args.taskId, args.agentSlug);
  const workflowUrl = new URL(
    `/api/agent/tasks/${encodeURIComponent(args.taskId)}/workflow`,
    agentCallbackBaseUrl(),
  ).toString();
  const bodyShape = JSON.stringify(
    {
      messageId: args.messageId,
      token,
      action: "<start | ready_for_review | review_feedback | review_done | triage_to_todo>",
      comment: "<required only for review_feedback>",
      repoTouched: "<true | false, only on ready_for_review; default true when branchName is set>",
    },
    null,
    2,
  );

  const codeTouching = Boolean(args.branchName && args.repositoryPath);
  const commitHygiene: string[] = [];
  if (codeTouching) {
    commitHygiene.push(
      "",
      "COMMIT HYGIENE (this task touches the repository):",
      `- Repository: ${args.repositoryPath}`,
      `- Branch: ${args.branchName}`,
      args.commitPrefix
        ? `- COMMIT_PREFIX: ${args.commitPrefix} — every commit message on this task MUST start with this exact prefix (e.g. "${args.commitPrefix} short imperative summary").`
        : "- COMMIT_PREFIX is not set on the task or its epic. Use the task id as a fallback prefix, and ask zeh to set commitPrefix on the task or epic.",
      `- All local changes must be committed (each with the prefix) and pushed to origin/${args.branchName} BEFORE you call action=ready_for_review.`,
      "- On ready_for_review: include `repoTouched: true` in the body. PM will dispatch Karen to verify origin reflects your work and post a pm.repo.verify.* comment.",
      "- If this task changed nothing in the repository (docs-only, decision-only, etc.), set `repoTouched: false` on ready_for_review and Karen will skip the check.",
    );
  }

  const reviewerVerify: string[] = [];
  if (args.reason === "review_requested" && codeTouching) {
    reviewerVerify.push(
      "",
      "REVIEW VERIFICATION (first check, you are the resolved reviewer):",
      `- This task touched ${args.repositoryPath} on branch ${args.branchName}. Before reviewing, look for a pm.repo.verify.* task comment from Karen confirming origin/${args.branchName} reflects the work.`,
      "- If pm.repo.verify.ok is present and recent, proceed with the review.",
      "- If pm.repo.verify.fail is present (no push found / no prefix match), leave concise review_feedback asking the assignee to commit (with the prefix) and push BEFORE you proceed. Do not approve work that isn't on origin yet.",
      "- If no pm.repo.verify.* comment has appeared yet, wait briefly for Karen to publish one. The runner picks up the job within seconds of the assignee's ready_for_review call.",
    );
  }

  return [
    `PM WORKFLOW CAPABILITY for task "${args.taskTitle}".`,
    `This notification is addressed to @${args.agentSlug}. Its workflow reason is ${args.reason}.`,
    "",
    "Workflow rules:",
    "- Backlog is for planning and opinions only. If you are the assignee and the task is in Backlog, reply with your implementation plan/opinion as a task comment. Do not change task status and do not start work.",
    "- To Do means the plan/request is approved for execution. If you are the assignee and the task is in To Do, call the workflow endpoint with action=start, then begin work immediately.",
    "- In Progress means active implementation. When implementation is complete, call the workflow endpoint with action=ready_for_review.",
    "- Review means the completed work is waiting for reviewer feedback. If you are the resolved reviewer and are satisfied, call action=review_done. PM will then assign the next unassigned To Do task in the same Open Epic to the same assignee and wake them. If changes or blockers remain, call action=review_feedback with a clear comment.",
    "- If you are an assignee with review feedback waiting, address that feedback before starting newly assigned To Do work.",
    "- If you are the reviewer or Open Epic acting manager and accept a Backlog plan, call action=triage_to_todo.",
    "- For tasks under an Epic, do not start or advance work unless the Epic status in the context is Open.",
    "- Do not post visible acknowledgements, restatements, or filler. If your workflow action fully handles the turn and you have no new information to add, finish with the exact reply token below.",
    ...commitHygiene,
    ...reviewerVerify,
    "",
    "Workflow endpoint:",
    `POST application/json to: ${workflowUrl}`,
    "Body shape:",
    bodyShape,
    "",
    `Silent reply token: ${PM_SILENT_REPLY_TOKEN}`,
    "Replies to this PM-channel turn are stored as normal task comments. Use a visible comment only for a plan, opinion, completion evidence, review feedback, blocker, or necessary question.",
  ].join("\n");
}

export async function sendTaskWorkflowNotification(args: {
  taskId: string;
  targetUserId: string;
  actor: Actor;
  reason: TaskWorkflowNotificationReason;
  body: string;
}) {
  const [task, actorUser, targetUser] = await Promise.all([
    db.task.findUnique({
      where: { id: args.taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        branchName: true,
        commitPrefix: true,
        deletedAt: true,
        project: { select: { slug: true, repositoryPath: true } },
        epic: { select: { commitPrefix: true } },
      },
    }),
    db.user.findUnique({
      where: { id: args.actor.id },
      select: { username: true },
    }),
    db.user.findUnique({
      where: { id: args.targetUserId },
      select: {
        id: true,
        username: true,
        kind: true,
        status: true,
        agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
      },
    }),
  ]);

  if (!task || task.deletedAt) return null;
  if (
    !targetUser ||
    targetUser.kind !== "agent" ||
    targetUser.status !== "active" ||
    !targetUser.agent ||
    targetUser.agent.deactivatedAt
  ) {
    return null;
  }

  const mirroredBody = [
    `PM workflow notification for @${targetUser.agent.slug}:`,
    "",
    args.body,
  ].join("\n");

  const msg = await db.agentChatMessage.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      epicId: null,
      agentSlug: targetUser.agent.slug,
      senderUserId: args.actor.id,
      body: mirroredBody,
      allowDescriptionEdit: false,
      originChannel: "comment",
      originCommentId: null,
    },
    select: { id: true, createdAt: true },
  });

  await db.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      userId: args.actor.id,
      kind: "task.workflow.notify",
      targetAgent: targetUser.agent.slug,
      payload: JSON.stringify({
        messageId: msg.id,
        agentSlug: targetUser.agent.slug,
        reason: args.reason,
      }),
    },
  });

  const userMessage = await buildTaskAgentUserMessage({
    taskId: task.id,
    agentSlug: targetUser.agent.slug,
    currentTurn: {
      id: msg.id,
      agentChatMessageId: msg.id,
      source: "task comment",
      actorUsername: args.actor.username ?? actorUser?.username ?? null,
      actorKind: args.actor.kind,
      body: args.body,
      createdAt: msg.createdAt,
    },
  });
  const sessionBinding = await getOrCreateAgentSessionBinding({
    scopeType: "task",
    scopeId: task.id,
    agentSlug: targetUser.agent.slug,
  });
  const delivery = await sendOrQueueOpenClawPmChannelTurn({
    gatewayPort: targetUser.agent.gatewayPort,
    agentSlug: targetUser.agent.slug,
    sessionKey: buildPmTurnSessionKey(sessionBinding.openclawSessionKey, msg.id),
    kind: "task-comment",
    text: args.body,
    contextText: userMessage,
    systemPrompt: [
      buildTaskNativeChannelPrompt(task.title, targetUser.agent.slug),
      workflowPrompt({
        taskTitle: task.title,
        taskId: task.id,
        agentSlug: targetUser.agent.slug,
        messageId: msg.id,
        reason: args.reason,
        branchName: task.branchName ?? null,
        commitPrefix: task.commitPrefix ?? task.epic?.commitPrefix ?? null,
        repositoryPath: task.project.repositoryPath ?? null,
      }),
    ].join("\n\n"),
    projectId: task.projectId,
    actor: {
      id: args.actor.id,
      username: args.actor.username ?? actorUser?.username ?? null,
      kind: args.actor.kind,
    },
    replyTarget: {
      kind: "task-comment",
      agentSlug: targetUser.agent.slug,
      taskId: task.id,
      messageId: msg.id,
      projectSlug: task.project.slug,
    },
  });

  await db.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      userId: args.actor.id,
      kind: delivery.ok ? "task.workflow.dispatch" : "task.workflow.dispatch_failed",
      targetAgent: targetUser.agent.slug,
      payload: JSON.stringify({
        messageId: msg.id,
        agentSlug: targetUser.agent.slug,
        reason: args.reason,
        driver: delivery.driver,
        status: delivery.status ?? null,
        error: delivery.error ?? null,
      }),
    },
  });

  return { messageId: msg.id, agentSlug: targetUser.agent.slug, delivery };
}

export async function sendTaskCommentNotifications(args: {
  taskId: string;
  commentId: string;
  body: string;
  actor: Actor;
  excludeAgentSlugs?: string[];
}) {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      status: true,
      deletedAt: true,
      project: { select: { slug: true } },
      assignee: {
        select: {
          id: true,
          username: true,
          kind: true,
          status: true,
          agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
        },
      },
      actingManager: {
        select: {
          id: true,
          username: true,
          kind: true,
          status: true,
          agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
        },
      },
      reporter: {
        select: {
          id: true,
          username: true,
          kind: true,
          status: true,
          agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
        },
      },
      epic: {
        select: {
          status: true,
          actingManager: {
            select: {
              id: true,
              username: true,
              kind: true,
              status: true,
              agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
            },
          },
        },
      },
    },
  });
  if (!task || task.deletedAt) return [];

  const users = await db.user.findMany({
    select: {
      id: true,
      username: true,
      kind: true,
      status: true,
      agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
    },
  });
  const actorUser = users.find((u) => u.id === args.actor.id);
  const mentions = extractMentions(
    args.body,
    users.map((u) => ({ username: u.username })),
  );
  const mentionedUsers = users.filter((u) => mentions.includes(u.username));
  const excluded = new Set(args.excludeAgentSlugs ?? []);
  if (actorUser?.kind === "agent" && actorUser.agent?.slug) {
    excluded.add(actorUser.agent.slug);
  }

  const targetAgents = new Map<string, AgentTarget>();
  addTargetAgent(targetAgents, task.assignee, "assigned", excluded);
  addTargetAgent(targetAgents, task.actingManager, "reviewer", excluded);
  const hasOpenEpicManager = task.epic?.status === "Open" && task.epic.actingManager;
  if (task.epic?.status === "Open") {
    addTargetAgent(targetAgents, task.epic.actingManager, "epic-manager", excluded);
  }
  if (!task.actingManager && !hasOpenEpicManager) {
    addTargetAgent(targetAgents, task.reporter, "reporter", excluded);
  }
  for (const user of mentionedUsers) {
    addTargetAgent(targetAgents, user, "mentioned", excluded);
  }

  // Directed-message descriptor for the silence rule. A comment with no
  // @-mentions of an agent is a broadcast to assignee/reviewer/etc.; any
  // mention narrows the directed set so the non-mentioned roles go silent.
  const mentionableAgents = users
    .filter((u) => u.kind === "agent" && u.status === "active" && u.agent && !u.agent.deactivatedAt)
    .map((u) => ({ username: u.username, agentSlug: u.agent!.slug }));
  const directedDescriptor = resolveDirectedFromComment({
    body: args.body,
    mentionableAgents,
  });

  const mirroredBody = [
    `Task comment from @${actorUser?.username ?? args.actor.username ?? "unknown"}:`,
    "",
    args.body,
  ].join("\n");

  const mirroredMessages = await db.$transaction(async (tx) => {
    const mirrored: Array<{
      id: string;
      agentSlug: string;
      reason: string[];
      commentCreatedAt: Date;
    }> = [];
    for (const target of targetAgents.values()) {
      const msg = await tx.agentChatMessage.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          epicId: null,
          agentSlug: target.slug,
          senderUserId: args.actor.id,
          body: mirroredBody,
          allowDescriptionEdit: false,
          originChannel: "comment",
          originCommentId: args.commentId,
        },
        select: { id: true, createdAt: true },
      });
      const reason = [...target.reasons];
      mirrored.push({
        id: msg.id,
        agentSlug: target.slug,
        reason,
        commentCreatedAt: msg.createdAt,
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "task.chat.send",
          targetAgent: target.slug,
          payload: JSON.stringify({
            messageId: msg.id,
            agentSlug: target.slug,
            mirroredFromCommentId: args.commentId,
            reason,
          }),
        },
      });
    }
    return mirrored;
  });

  await Promise.all(mirroredMessages.map(async (msg) => {
    const userMessage = await buildTaskAgentUserMessage({
      taskId: task.id,
      agentSlug: msg.agentSlug,
      currentTurn: {
        id: args.commentId,
        agentChatMessageId: msg.id,
        source: "task comment",
        actorUsername: actorUser?.username ?? args.actor.username,
        actorKind: args.actor.kind,
        body: args.body,
        createdAt: msg.commentCreatedAt,
      },
      directedDescriptor,
    });
    const sessionBinding = await getOrCreateAgentSessionBinding({
      scopeType: "task",
      scopeId: task.id,
      agentSlug: msg.agentSlug,
    });
    const target = targetAgents.get(msg.agentSlug);
    const delivery = await sendOrQueueOpenClawPmChannelTurn({
      gatewayPort: target?.gatewayPort ?? null,
      agentSlug: msg.agentSlug,
      sessionKey: buildPmTurnSessionKey(sessionBinding.openclawSessionKey, msg.id),
      kind: "task-comment",
      text: args.body,
      contextText: userMessage,
      systemPrompt: buildTaskNativeChannelPrompt(task.title, msg.agentSlug, directedDescriptor),
      projectId: task.projectId,
      actor: {
        id: args.actor.id,
        username: actorUser?.username ?? args.actor.username,
        kind: args.actor.kind,
      },
      replyTarget: {
        kind: "task-comment",
        agentSlug: msg.agentSlug,
        taskId: task.id,
        messageId: msg.id,
        projectSlug: task.project.slug,
      },
    });
    await db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actor.id,
        kind: delivery.ok ? "task.comment.dispatch" : "task.comment.dispatch_failed",
        targetAgent: msg.agentSlug,
        payload: JSON.stringify({
          commentId: args.commentId,
          messageId: msg.id,
          agentSlug: msg.agentSlug,
          reason: msg.reason,
          driver: delivery.driver,
          status: delivery.status ?? null,
          error: delivery.error ?? null,
        }),
      },
    });
  }));

  return mirroredMessages;
}
