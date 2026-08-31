"use server";

// Agent-chat server actions (HOMELAB-48).
//
// sendAgentChatMessage persists a message in the per-(target, agent)
// thread. Task- and Epic-scoped chats are delivered through the native
// OpenClaw PM channel, so OpenClaw owns session recording and visible
// reply delivery.
//
// Human-authored task/epic chat messages carry a one-shot description
// write capability and work-item proposal capability by default. The
// agent gets signed tokens in the native-channel prompt and must only use
// them for explicit human update requests. The grant-used timestamps are
// stamped on first use.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { revalidateTaskReplyScope } from "@/lib/tasks/cache";
import { revalidateEpicReplyScope } from "@/lib/epics/cache";
import {
  buildTaskNativeChannelPrompt,
  buildTaskNativeEditGrantPrompt,
  buildTaskNativeIncrementalChannelPrompt,
} from "@/lib/agents/workflow/chat/task/context";
import {
  buildEpicNativeChannelPrompt,
  buildEpicNativeEditGrantPrompt,
  buildEpicNativeIncrementalChannelPrompt,
} from "@/lib/agents/workflow/chat/epic/context";
import { extractMentions } from "@/lib/markdown";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/auth/session-bindings";
import { sendOrQueueOpenClawPmChannelTurn } from "@/lib/agents/pm-channel/jobs";
import { buildUnifiedPmTurnSystemPrompt, nullPmContextText } from "@/lib/agents/pm-channel/context";
import { buildPmChannelDispatchMetrics } from "@/lib/agents/pm-channel/openclaw";
import { createContextGrantUrlMap } from "@/lib/agents/context/grants";
import { DISCUSSION_REPLY_FORMAT_PROMPT } from "@/lib/agents/chat/discussion-reply-format";
import { createTaskDescriptionWriteToken } from "@/lib/agents/workflow/chat/task/token";
import { createEpicDescriptionWriteToken } from "@/lib/agents/workflow/chat/epic/token";
import { createWorkItemGrantToken } from "@/lib/agents/workflow/token/work-item";
import { buildWorkItemPlanningPrompt } from "@/lib/agents/context/project";
import {
  attachmentMaxBytes,
  writeAttachment,
} from "@/lib/attachments/storage";
import { resolveDirectedFromDiscussionRow } from "@/lib/agents/ops/directed-targets";
import {
  formatRecentBlock,
  recentComments,
  recentDiscussion,
} from "@/lib/agents/context/api/recent";
import { isValidClientMessageId } from "@/lib/agents/ops/client-message-id";
import {
  chatContextRevision,
  consumeSpeculativeAgentChatContext,
  directedTargetKey,
  scheduleSpeculativeAgentChatContext,
} from "@/lib/agents/context/speculative";
import { stripChatMarkdown as compactText, truncateSummary } from "@/lib/text";
import { publicOriginFromHeaders } from "@/lib/http/public-origin";
import {
  requireProjectAccess,
  requireEpicAccess,
  requireOwner,
  requireTaskAccess,
  requireViewer,
  type Viewer,
} from "@/lib/auth/permissions";

async function requireActor(): Promise<Viewer> {
  return requireViewer();
}

function agentCallbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

function summarizeRoomMessages(
  messages: Array<{ body: string; sender: { kind: string } }>,
  fallback: string,
) {
  const firstHuman = messages.find((m) => m.sender.kind === "human");
  const source = compactText(firstHuman?.body ?? messages[0]?.body ?? "");
  return truncateSummary(source || fallback);
}

function deleteToBin(formData: FormData) {
  return formData.get("deleteToBin") === "1" || formData.get("deleteToBin") === "true";
}

function uploadedFiles(formData: FormData) {
  return formData
    .getAll("attachments")
    .filter((file): file is File => file instanceof File && file.size > 0);
}

function targetLabelForUser(user: {
  username: string;
  kind: string;
  name?: string | null;
  agent?: { slug?: string | null; name?: string | null } | null;
}) {
  if (user.kind === "agent") {
    return user.agent?.name ?? user.name ?? user.username;
  }
  return user.name ?? user.username;
}

function targetValueForPrincipal(user: {
  id: string;
  kind: string;
  agent?: { slug?: string | null } | null;
}) {
  if (user.kind === "agent" && user.agent?.slug) return `agent:${user.agent.slug}`;
  return `user:${user.id}`;
}

async function createDiscussionAttachments(args: {
  files: File[];
  projectId: string;
  projectSlug: string;
  taskId: string | null;
  epicId: string | null;
  actorId: string;
}) {
  const created: Array<{ id: string; filename: string; sizeBytes: number; sha256: string }> = [];
  for (const file of args.files) {
    if (file.size > attachmentMaxBytes()) {
      throw new Error(
        `Attachment exceeds size cap (${file.size} > ${attachmentMaxBytes()})`,
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const written = await writeAttachment({
      projectId: args.projectId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      data: buffer,
    });
    const row = await db.attachment.create({
      data: {
        projectId: args.projectId,
        taskId: args.taskId,
        epicId: args.epicId,
        uploaderId: args.actorId,
        filename: file.name,
        storagePath: written.storagePath,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
      },
      select: { id: true },
    });
    await db.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: args.taskId,
        userId: args.actorId,
        kind: args.taskId ? "task.attachment.add" : "epic.attachment.add",
        payload: JSON.stringify({
          attachmentId: row.id,
          filename: file.name,
          sizeBytes: written.sizeBytes,
          sha256: written.sha256,
          source: "discussion",
        }),
      },
    });
    created.push({
      id: row.id,
      filename: file.name,
      sizeBytes: written.sizeBytes,
      sha256: written.sha256,
    });
  }
  return created;
}

function appendAttachmentLinks(
  body: string,
  attachments: Array<{ id: string; filename: string }>,
) {
  if (attachments.length === 0) return body;
  const lines = [
    body,
    body ? "" : "Attached files:",
    ...attachments.map((file) => `- [${file.filename}](/api/attachments/${file.id})`),
  ].filter(Boolean);
  return lines.join("\n");
}


export async function prebuildAgentChatContext(formData: FormData) {
  const actor = await requireActor();
  if (!actor.canAccessOwnerFeatures) return { scheduled: false };
  const projectSlug = String(formData.get("projectSlug") ?? "");
  const taskIdRaw = String(formData.get("taskId") ?? "");
  const epicIdRaw = String(formData.get("epicId") ?? "");
  const messageId = String(formData.get("messageId") ?? "").trim();
  const bodyRaw = String(formData.get("body") ?? "").trim();
  const taskId = taskIdRaw === "" ? null : taskIdRaw;
  const epicId = epicIdRaw === "" ? null : epicIdRaw;
  const selectedTargets = Array.from(
    new Set(
      formData
        .getAll("discussionTarget")
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  );

  if (!projectSlug || !messageId || !isValidClientMessageId(messageId)) return { scheduled: false };
  if ((taskId === null) === (epicId === null)) return { scheduled: false };
  if (bodyRaw.length > 8000) return { scheduled: false };

  return scheduleSpeculativeAgentChatContext({
    projectSlug,
    taskId,
    epicId,
    messageId,
    bodyRaw,
    selectedTargets,
  });
}

export async function sendAgentChatMessage(formData: FormData) {
  const publicOrigin = publicOriginFromHeaders(await headers());
  const actor = await requireActor();
  if (!actor.canAccessOwnerFeatures) {
    throw new Error("Only the Mission Control owner can send agent messages.");
  }
  const canTriggerAgents = actor.canAccessOwnerFeatures;
  const slug = String(formData.get("projectSlug") ?? "");
  const taskIdRaw = String(formData.get("taskId") ?? "");
  const epicIdRaw = String(formData.get("epicId") ?? "");
  const taskId = taskIdRaw === "" ? null : taskIdRaw;
  const epicId = epicIdRaw === "" ? null : epicIdRaw;
  const bodyRaw = String(formData.get("body") ?? "").trim();
  const files = uploadedFiles(formData);
  const requestedTargets = Array.from(
    new Set(
      formData
        .getAll("discussionTarget")
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  );
  const selectedTargets = !canTriggerAgents
    ? []
    : requestedTargets.includes("all-coders")
      ? ["all-coders"]
      : requestedTargets.filter((value) => value !== "all-coders");
  const requestedBaseArchiveId = String(formData.get("baseArchiveId") ?? "").trim() || null;
  const requestedOriginChannel = String(formData.get("originChannel") ?? "").trim();
  const originChannel = requestedOriginChannel === "description" ? "description" : "chat";
  const decisionForMessageId = String(formData.get("decisionForMessageId") ?? "").trim() || null;
  const decisionOption = String(formData.get("decisionOption") ?? "").trim() || null;
  const requestedMessageId = String(formData.get("messageId") ?? "").trim() || null;
  const allowDescriptionEdit = actor.kind === "human" && canTriggerAgents;
  const allowWorkItemManagement = actor.kind === "human" && canTriggerAgents;

  if (!slug || (!bodyRaw && files.length === 0)) return;
  if ((taskId === null) === (epicId === null)) {
    throw new Error("Chat target must be exactly one of taskId or epicId");
  }
  if (bodyRaw.length > 8000) return;
  if (requestedMessageId && !isValidClientMessageId(requestedMessageId)) {
    throw new Error("Invalid client messageId");
  }

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!project) return;
  await requireProjectAccess(actor, { id: project.id });
  if (taskId) await requireTaskAccess(actor, taskId);
  if (epicId) await requireEpicAccess(actor, epicId);

  if (requestedMessageId) {
    const existing = await db.agentChatMessage.findUnique({
      where: { id: requestedMessageId },
      select: { id: true },
    });
    if (existing) {
      throw new Error("Client messageId already exists");
    }
  }

  const users = await db.user.findMany({
    select: {
      id: true,
      username: true,
      name: true,
      kind: true,
      status: true,
      agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } },
    },
  });

  let task: any = null;
  let epic: any = null;

  if (taskId) {
    task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        epicId: true,
        description: true,
        deletedAt: true,
        private: true,
        parent: { select: { private: true, epic: { select: { private: true } } } },
        epic: { select: { private: true } },
        assignee: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            status: true,
            agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } },
          },
        },
        actingManager: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            status: true,
            agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } },
          },
        },
      },
    });
    if (!task || task.projectId !== project.id || task.deletedAt || task.private || task.parent?.private || task.parent?.epic?.private || task.epic?.private) {
      throw new Error("Private work items cannot be sent to agents.");
    }
  } else if (epicId) {
    epic = await db.epic.findUnique({
      where: { id: epicId },
      select: {
        id: true,
        title: true,
        projectId: true,
        description: true,
        deletedAt: true,
        private: true,
        actingManager: {
          select: {
            id: true,
            username: true,
            name: true,
            kind: true,
            status: true,
            agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } },
          },
        },
      },
    });
    if (!epic || epic.projectId !== project.id || epic.deletedAt || epic.private) {
      throw new Error("Private work items cannot be sent to agents.");
    }
  }

  const dbAgentSlug = "room";
  let baseArchiveId = requestedBaseArchiveId;
  if (baseArchiveId) {
    const archive = await db.agentChatRoomArchive.findFirst({
      where: taskId
        ? { id: baseArchiveId, projectId: project.id, taskId, deletedAt: null }
        : { id: baseArchiveId, projectId: project.id, epicId, deletedAt: null },
      select: { id: true },
    });
    if (!archive) return;
  } else {
    const latestActive = await db.agentChatMessage.findFirst({
      where: taskId
        ? { projectId: project.id, taskId, archiveId: null, agentSlug: dbAgentSlug }
        : { projectId: project.id, epicId, archiveId: null, agentSlug: dbAgentSlug },
      orderBy: { createdAt: "desc" },
      select: { baseArchiveId: true },
    });
    baseArchiveId = latestActive?.baseArchiveId ?? null;
  }

  const createdAttachments = await createDiscussionAttachments({
    files,
    projectId: project.id,
    projectSlug: slug,
    taskId,
    epicId,
    actorId: actor.id,
  });
  const body = appendAttachmentLinks(bodyRaw, createdAttachments);

  const targetAgents = new Map<string, { slug: string; gatewayPort: number | null }>();
  let targetType: string | null = null;
  let targetValue: string | null = null;
  let targetLabel: string | null = null;

  const addAgentTarget = (user: (typeof users)[number] | null | undefined) => {
    if (
      user &&
      user.kind === "agent" &&
      user.status === "active" &&
      user.agent &&
      !user.agent.deactivatedAt
    ) {
      targetAgents.set(user.agent.slug, {
        slug: user.agent.slug,
        gatewayPort: user.agent.gatewayPort ?? null,
      });
      return true;
    }
    return false;
  };

  const principalTarget = (user: (typeof users)[number] | null | undefined) => {
    if (!user || user.status !== "active") return null;
    addAgentTarget(user);
    return {
      type: user.kind === "agent" ? "agent" : "user",
      value: targetValueForPrincipal(user),
      label: targetLabelForUser(user),
    };
  };

  const appliedTargets: Array<{ type: string; value: string; label: string }> = [];

  if (selectedTargets[0] === "all-coders") {
    targetType = "all-coders";
    targetValue = "all-coders";
    targetLabel = "All Coders";
    for (const user of users) {
      if (user.agent?.role === "coding") addAgentTarget(user);
    }
  } else {
    for (const requestedTarget of selectedTargets) {
      if (requestedTarget.startsWith("agent:")) {
        const agentSlug = requestedTarget.slice("agent:".length);
        const target = principalTarget(
          users.find((u) => u.kind === "agent" && u.agent?.slug === agentSlug),
        );
        if (target) appliedTargets.push(target);
      } else if (requestedTarget.startsWith("user:")) {
        const userId = requestedTarget.slice("user:".length);
        const target = principalTarget(users.find((u) => u.id === userId));
        if (target) appliedTargets.push(target);
      }
    }

    if (appliedTargets.length === 1) {
      targetType = appliedTargets[0]!.type;
      targetValue = appliedTargets[0]!.value;
      targetLabel = appliedTargets[0]!.label;
    } else if (appliedTargets.length > 1) {
      targetType = "multi";
      targetValue = JSON.stringify(appliedTargets.map((target) => target.value));
      targetLabel = appliedTargets.map((target) => target.label).join(", ");
    }
  }

  const mentions = canTriggerAgents
    ? extractMentions(bodyRaw, users.map((u) => ({ username: u.username })))
    : [];
  if (canTriggerAgents) {
    for (const user of users) {
      if (mentions.includes(user.username)) addAgentTarget(user);
    }
  }

  if (canTriggerAgents && !targetType) {
    if (task) {
      for (const candidate of [task.actingManager, task.assignee]) {
        const target = principalTarget(candidate);
        if (target) {
          targetType = target.type;
          targetValue = target.value;
          targetLabel = target.label;
          break;
        }
      }
    } else if (epic) {
      const target = principalTarget(epic.actingManager);
      if (target) {
        targetType = target.type;
        targetValue = target.value;
        targetLabel = target.label;
      }
    }
  }

  const msg = await db.agentChatMessage.create({
    data: {
      ...(requestedMessageId ? { id: requestedMessageId } : {}),
      projectId: project.id,
      taskId,
      epicId,
      agentSlug: dbAgentSlug,
      baseArchiveId,
      targetType,
      targetValue,
      targetLabel,
      senderUserId: actor.id,
      body,
      allowDescriptionEdit,
      allowWorkItemManagement,
      originChannel,
    },
    select: { id: true },
  });

  await db.activityLog.create({
    data: {
      projectId: project.id,
      taskId,
      userId: actor.id,
      kind: taskId ? "task.chat.send" : "epic.chat.send",
      payload: JSON.stringify({
        messageId: msg.id,
        agentSlug: dbAgentSlug,
        epicId,
        allowDescriptionEdit,
        allowWorkItemManagement,
        publicOrigin,
        originChannel,
        baseArchiveId,
        targetType,
        targetValue,
        targetLabel,
        decision: decisionOption,
        decisionForMessageId,
        source: decisionOption ? "pm-options" : undefined,
        attachmentIds: createdAttachments.map((file) => file.id),
      }),
    },
  });

  const actorUser = await db.user.findUnique({
    where: { id: actor.id },
    select: { username: true },
  });

  // Directed-message descriptor for the silence rule. Computed once from the
  // just-persisted target* fields against the set of active agent slugs.
  const activeAgentSlugs = new Set(
    users
      .filter((u) => u.kind === "agent" && u.status === "active" && u.agent && !u.agent.deactivatedAt)
      .map((u) => u.agent!.slug),
  );
  const directedDescriptor = resolveDirectedFromDiscussionRow({
    targetType,
    targetValue,
    targetLabel,
    activeAgentSlugs,
  });

  // Speculative-context lookup key shared by every target agent of this send.
  // The directed key pins the cache entry to the recipients/silence rule that
  // was actually sent (see directedTargetKey); the revision is identical across
  // agents, so compute it at most once and reuse it for each consume instead of
  // re-running the ~9-aggregate revision query per agent. Computed lazily so a
  // send where every turn is incremental (no consume) pays nothing.
  const speculativeDirectedKey = directedTargetKey({ targetType, targetValue, targetLabel });
  let speculativeRevisionPromise: Promise<string> | null = null;
  const getSpeculativeRevision = () => {
    speculativeRevisionPromise ??= chatContextRevision({
      projectId: project.id,
      taskId: taskId ? task.id : null,
      epicId: taskId ? null : epic.id,
      excludeMessageId: msg.id,
    });
    return speculativeRevisionPromise;
  };

  // Recent-exchange slice (HOMELAB-41 prioritization fix). This is the
  // single most important context for "did the participant just agree to
  // a specific scope?" — so we compute it once and inline it ABOVE the
  // live-fetch curl block in every per-agent prompt. The just-persisted
  // current message is filtered out by id so it doesn't double-render.
  const scopeForRecent = taskId ? { taskId: task.id as string } : { epicId: epic.id as string };
  const [recentDisc, recentCmts] = await Promise.all([
    recentDiscussion(scopeForRecent),
    recentComments(scopeForRecent),
  ]);
  const inlineRecentBlock = formatRecentBlock({
    scope: taskId ? "task" : "epic",
    discussion: recentDisc,
    comments: recentCmts,
    currentMessageId: msg.id,
  });

  await Promise.all([...targetAgents.values()].map(async (target) => {
    const agentSlug = target.slug;
    const gatewayPort = target.gatewayPort;

    // Live-fetch envelope: hand the model short-lived scoped grant URLs
    // instead of a reusable PM-channel bearer token. All PM surfaces mint
    // this bundle through the shared helper so task/Epic/direct chat use the
    // same endpoint + scope-binding contract.
    const fetchBaseUrl = agentCallbackBaseUrl();
    const grantUrls = await createContextGrantUrlMap({
      baseUrl: fetchBaseUrl,
      agentSlug,
      projectId: project.id,
      taskId: taskId ? task.id : null,
      epicId: taskId ? task.epicId : epic.id,
      turnId: msg.id,
    });

    const sessionBinding = await getOrCreateAgentSessionBinding({
      scopeType: taskId ? "task" : "epic",
      scopeId: taskId ? task.id : epic.id,
      agentSlug,
    });
    const previousDispatchedMessageId = sessionBinding.lastDispatchedMessageId;
    const isIncrementalTurn = !!previousDispatchedMessageId;

    const prebuiltContext = isIncrementalTurn
      ? null
      : await consumeSpeculativeAgentChatContext({
          projectId: project.id,
          taskId: taskId ? task.id : null,
          epicId: taskId ? null : epic.id,
          messageId: msg.id,
          agentSlug,
          directedKey: speculativeDirectedKey,
          revision: await getSpeculativeRevision(),
        });
    const baseSystemPrompt = prebuiltContext?.baseSystemPrompt ?? (taskId
      ? isIncrementalTurn
        ? buildTaskNativeIncrementalChannelPrompt(task.title, agentSlug, previousDispatchedMessageId, directedDescriptor, {
            baseUrl: fetchBaseUrl,
            projectId: project.id,
            inlineRecentBlock,
            taskId: task.id,
            epicId: task.epicId ?? null,
            grantUrls: {
              task: grantUrls.task!,
              epic: grantUrls.epic,
              project: grantUrls.project,
            },
          })
        : buildTaskNativeChannelPrompt(task.title, agentSlug, directedDescriptor, {
            baseUrl: fetchBaseUrl,
            projectId: project.id,
            inlineRecentBlock,
            taskId: task.id,
            epicId: task.epicId ?? null,
            grantUrls: {
              task: grantUrls.task!,
              epic: grantUrls.epic,
              project: grantUrls.project,
            },
          })
      : isIncrementalTurn
        ? buildEpicNativeIncrementalChannelPrompt(epic.title, agentSlug, previousDispatchedMessageId, directedDescriptor, {
            baseUrl: fetchBaseUrl,
            projectId: project.id,
            inlineRecentBlock,
            epicId: epic.id,
            workflowMessageId: msg.id,
            grantUrls: {
              epic: grantUrls.epic!,
              project: grantUrls.project,
            },
          })
        : buildEpicNativeChannelPrompt(epic.title, agentSlug, directedDescriptor, {
            baseUrl: fetchBaseUrl,
            projectId: project.id,
            inlineRecentBlock,
            epicId: epic.id,
            workflowMessageId: msg.id,
            grantUrls: {
              epic: grantUrls.epic!,
              project: grantUrls.project,
            },
          }));

    const descriptionPrompt = allowDescriptionEdit
      ? taskId
        ? buildTaskNativeEditGrantPrompt({
            taskTitle: task.title,
            descriptionUrl: new URL(`/api/tasks/${task.id}/description`, agentCallbackBaseUrl()).toString(),
            messageId: msg.id,
            token: createTaskDescriptionWriteToken(msg.id, task.id, agentSlug),
          })
        : buildEpicNativeEditGrantPrompt({
            epicTitle: epic.title,
            descriptionUrl: new URL(`/api/epics/${epic.id}/description`, agentCallbackBaseUrl()).toString(),
            messageId: msg.id,
            token: createEpicDescriptionWriteToken(msg.id, epic.id, agentSlug),
        })
      : "";
    let workItemPrompt = "";
    if (allowWorkItemManagement) {
      const token = createWorkItemGrantToken(project.id, agentSlug, msg.id);
      const proposeUrl = new URL(
        `/api/agent/projects/${project.id}/proposals`,
        agentCallbackBaseUrl(),
      ).toString();
      workItemPrompt = buildWorkItemPlanningPrompt({
        agentSlug,
        projectSlug: slug,
        proposeUrl,
        grantMessageId: msg.id,
        token,
        publicOrigin,
      });
    }

    const kind = taskId ? "task-chat" as const : "epic-chat" as const;
    const systemPrompt = buildUnifiedPmTurnSystemPrompt({
      kind,
      trustedPrompt: [
        baseSystemPrompt,
        DISCUSSION_REPLY_FORMAT_PROMPT,
        descriptionPrompt,
        workItemPrompt,
      ].filter(Boolean).join("\n\n"),
      primaryBlocks: [{
        title: "CURRENT CHAT MESSAGE (untrustedContext)",
        body,
        trust: "untrusted",
      }],
    });

    const dispatchArgs = {
      gatewayPort,
      agentSlug,
      sessionKey: sessionBinding.openclawSessionKey,
      kind,
      text: body,
      contextText: nullPmContextText(),
      systemPrompt,
      projectId: project.id,
      actor: {
        id: actor.id,
        username: actorUser?.username,
        kind: actor.kind,
      },
      replyTarget: taskId
        ? {
            kind: "task-chat" as const,
            agentSlug,
            taskId: task.id,
            messageId: msg.id,
            projectSlug: slug,
          }
        : {
            kind: "epic-chat" as const,
            agentSlug,
            epicId: epic.id,
            messageId: msg.id,
            projectSlug: slug,
          },
    };
    const dispatchMetrics = buildPmChannelDispatchMetrics(
      dispatchArgs,
      recentDisc.filter((m) => m.id !== msg.id).length + recentCmts.filter((m) => m.id !== msg.id).length,
    );
    const delivery = await sendOrQueueOpenClawPmChannelTurn(dispatchArgs);

    if (delivery.ok) {
      await db.agentSessionBinding.update({
        where: { id: sessionBinding.id },
        data: {
          lastDispatchedMessageId: msg.id,
          lastDispatchedAt: new Date(),
        },
      });
    }

    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: taskId ?? null,
        userId: actor.id,
        kind: taskId
          ? (delivery.ok ? "task.chat.dispatch" : "task.chat.dispatch_failed")
          : (delivery.ok ? "epic.chat.dispatch" : "epic.chat.dispatch_failed"),
        targetAgent: agentSlug,
        payload: JSON.stringify({
          messageId: msg.id,
          agentSlug,
          epicId,
          driver: delivery.driver,
          status: delivery.status ?? null,
          error: delivery.error ?? null,
          dispatchMetrics,
        }),
      },
    });
  }));

  if (taskId) revalidateTaskReplyScope(taskId, "chat");
  if (epicId) revalidateEpicReplyScope(epicId, "chat");

  return { messageId: msg.id };
}


export async function getAgentChatRoomMessages(formData: FormData) {
  const actor = await requireOwner();
  const slug = String(formData.get("projectSlug") ?? "");
  const taskIdRaw = String(formData.get("taskId") ?? "");
  const epicIdRaw = String(formData.get("epicId") ?? "");
  const taskId = taskIdRaw === "" ? null : taskIdRaw;
  const epicId = epicIdRaw === "" ? null : epicIdRaw;

  if (!slug || (taskId === null) === (epicId === null)) return [];

  const target = taskId
    ? await db.task.findUnique({
        where: { id: taskId },
        select: { id: true, projectId: true, deletedAt: true, project: { select: { slug: true } } },
      })
    : await db.epic.findUnique({
        where: { id: epicId! },
        select: { id: true, projectId: true, deletedAt: true, project: { select: { slug: true } } },
      });

  if (!target || target.project.slug !== slug || target.deletedAt) return [];
  await requireProjectAccess(actor, { id: target.projectId });

  const messages = await db.agentChatMessage.findMany({
    where: {
      taskId,
      epicId,
      agentSlug: "room",
      archiveId: null,
    },
    orderBy: { createdAt: "asc" },
    include: {
      sender: {
        select: {
          id: true,
          username: true,
          kind: true,
          name: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, name: true, avatar: true } },
        },
      },
      deletedBy: { select: { username: true, name: true, kind: true } },
    },
  });

  return messages.map((message) => ({
    ...message,
    createdAt: message.createdAt.toISOString(),
    editGrantUsedAt: message.editGrantUsedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  }));
}

export async function archiveChatRoom(formData: FormData) {
  const actor = await requireOwner();

  const slug = String(formData.get("projectSlug") ?? "");
  const taskIdRaw = String(formData.get("taskId") ?? "");
  const epicIdRaw = String(formData.get("epicId") ?? "");
  const taskId = taskIdRaw === "" ? null : taskIdRaw;
  const epicId = epicIdRaw === "" ? null : epicIdRaw;
  const customTitle = String(formData.get("customTitle") ?? "").trim() || null;
  const moveToBin = deleteToBin(formData);

  if (!slug) return;
  if ((taskId === null) === (epicId === null)) {
    throw new Error("Chat room target must be exactly one of taskId or epicId");
  }

  const target = taskId
    ? await db.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          title: true,
          projectId: true,
          deletedAt: true,
          project: { select: { slug: true } },
        },
      })
    : await db.epic.findUnique({
        where: { id: epicId! },
        select: {
          id: true,
          title: true,
          projectId: true,
          deletedAt: true,
          project: { select: { slug: true } },
        },
      });

  if (!target || target.project.slug !== slug || target.deletedAt) return;
  await requireProjectAccess(actor, { id: target.projectId });

  const scopeWhere = taskId
    ? {
        projectId: target.projectId,
        taskId,
        epicId: null,
        agentSlug: "room",
        archiveId: null,
      }
    : {
        projectId: target.projectId,
        taskId: null,
        epicId,
        agentSlug: "room",
        archiveId: null,
      };

  const created = await db.$transaction(async (tx) => {
    const messages = await tx.agentChatMessage.findMany({
      where: scopeWhere,
      orderBy: { createdAt: "asc" },
      include: { sender: { select: { kind: true } } },
    });
    if (messages.length === 0) return null;

    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    const parentArchiveId = messages.find((m) => m.baseArchiveId)?.baseArchiveId ?? null;
    const summary = customTitle || summarizeRoomMessages(
      messages,
      taskId ? "Task chat room" : "Epic chat room",
    );
    const archive = await tx.agentChatRoomArchive.create({
      data: {
        projectId: target.projectId,
        taskId,
        epicId,
        archivedById: actor.id,
        parentArchiveId,
        deletedAt: moveToBin ? new Date() : null,
        deletedById: moveToBin ? actor.id : null,
        summary,
        startedAt: first.createdAt,
        endedAt: last.createdAt,
        messageCount: messages.length,
      },
      select: { id: true },
    });

    await tx.agentChatMessage.updateMany({
      where: scopeWhere,
      data: { archiveId: archive.id },
    });
    await tx.activityLog.create({
      data: {
        projectId: target.projectId,
        taskId: taskId ?? null,
        userId: actor.id,
        kind: taskId
          ? (moveToBin ? "task.chat.delete_to_bin" : "task.chat.archive")
          : (moveToBin ? "epic.chat.delete_to_bin" : "epic.chat.archive"),
        payload: JSON.stringify({
          archiveId: archive.id,
          parentArchiveId,
          messageCount: messages.length,
          summary,
        }),
      },
    });
    return archive;
  });

  if (!created) return;
  if (taskId) revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  if (epicId) revalidatePath(`/projects/${slug}/epics/${epicId}`);
}

// Hard-delete a chat message. Chats are conversation, not work
// items — they're SOFT-deleted (HOMELAB-41 / item 2): the row stays
// with deletedAt + deletedById stamped so the frontend can render a
// collapsed dotted divider that a human reviewer can expand on demand.
// Active reads (and ALL agent-context builders) filter deletedAt: null
// so deleted content never reaches an agent. Repeat-deleting a row is a
// no-op so the action stays idempotent. Scope is project-slug enforced.
export async function deleteChatMessage(formData: FormData) {
  const actor = await requireOwner();
  const slug = String(formData.get("projectSlug") ?? "");
  const messageId = String(formData.get("messageId") ?? "");
  if (!slug || !messageId) return;

  const msg = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    include: { project: { select: { slug: true } } },
  });
  if (!msg || msg.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: msg.projectId });
  if (msg.deletedAt) return; // already soft-deleted

  await db.$transaction([
    db.agentChatMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), deletedById: actor.id },
    }),
    db.activityLog.create({
      data: {
        projectId: msg.projectId,
        taskId: msg.taskId,
        userId: actor.id,
        kind: msg.taskId ? "task.chat.delete" : "epic.chat.delete",
        payload: JSON.stringify({
          messageId,
          agentSlug: msg.agentSlug,
          allowDescriptionEdit: msg.allowDescriptionEdit,
          soft: true,
        }),
      },
    }),
  ]);

  if (msg.taskId) revalidatePath(`/projects/${slug}/tasks/${msg.taskId}`);
  if (msg.epicId) revalidatePath(`/projects/${slug}/epics/${msg.epicId}`);
}

// Restore a soft-deleted chat bubble (HOMELAB-41 / item 2 follow-up).
// Inverse of deleteChatMessage. Clears deletedAt + deletedById so the
// row is visible to humans again AND eligible for inclusion in agent
// context. Idempotent on already-restored rows. Scope is project-slug
// enforced like its sibling.
export async function restoreChatMessage(formData: FormData) {
  const actor = await requireOwner();
  const slug = String(formData.get("projectSlug") ?? "");
  const messageId = String(formData.get("messageId") ?? "");
  if (!slug || !messageId) return;

  const msg = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    include: { project: { select: { slug: true } } },
  });
  if (!msg || msg.project.slug !== slug) return;
  await requireProjectAccess(actor, { id: msg.projectId });
  if (!msg.deletedAt) return; // already restored / never deleted

  await db.$transaction([
    db.agentChatMessage.update({
      where: { id: messageId },
      data: { deletedAt: null, deletedById: null },
    }),
    db.activityLog.create({
      data: {
        projectId: msg.projectId,
        taskId: msg.taskId,
        userId: actor.id,
        kind: msg.taskId ? "task.chat.restore" : "epic.chat.restore",
        payload: JSON.stringify({ messageId, agentSlug: msg.agentSlug }),
      },
    }),
  ]);

  if (msg.taskId) revalidatePath(`/projects/${slug}/tasks/${msg.taskId}`);
  if (msg.epicId) revalidatePath(`/projects/${slug}/epics/${msg.epicId}`);
}
