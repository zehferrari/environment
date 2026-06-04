import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  updateEpic,
  createTaskInEpic,
  createEpicComment,
  deleteEpicComment,
  restoreEpicComment,
} from "@/lib/epics/actions";
import { auth } from "@/lib/auth";
import {
  uploadAttachment,
  deleteAttachment,
} from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { binTask, deleteEpic } from "@/lib/bin/actions";
import { archiveEpic, unarchiveEpic } from "@/lib/archive/actions";
import { reorderTasks } from "@/lib/tasks/reorder";
import SortableTaskList from "@/components/sortable-task-list";
import AttachmentList from "@/components/attachment-list";
import AttachmentUploadFab from "@/components/attachment-upload-fab";
import { renderFullMarkdown, extractMentions } from "@/lib/markdown";
import { listAssignablePrincipals } from "@/lib/principals";
import { getTaskGitChanges, getTaskGitFileDiff } from "@/lib/tasks/git-changes";
import AutoScrollToLatest from "@/components/auto-scroll-to-latest";
import ChatRoom from "@/components/chat-room";
import ActivityTimeline, { type ActivityTimelineRow } from "@/components/activity-timeline";
import TaskChangesPanel from "@/components/task-changes-panel";
import CommentComposerFab from "@/components/comment-composer-fab";
import ConfirmedDeleteButton from "@/components/confirmed-delete-button";
import DeletedMessageDivider from "@/components/deleted-message-divider";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
} from "@/components/message-avatar";
import DescriptionField from "@/components/description-field";
import { TabsProvider, TabsNav, TabPanel } from "@/components/task-tabs";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import AddEpicTaskFab from "./add-epic-task-fab";
import EpicTasksAiPrompt from "./epic-tasks-ai-prompt";
import EpicTasksClient from "./epic-tasks-client";
import { sendAgentChatMessage } from "@/lib/agents/chat-actions";
import { effectiveCommitPrefix } from "@/lib/work-items/keys";
import DeploymentTab, { canShowDeploymentAction, type DeploymentPrRow } from "@/components/deployment-tab";

type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
};

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

function serializeActor(actor: ActorRow | null) {
  if (!actor) return null;
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind,
    name: actor.name,
    avatarUpdatedAt: actor.avatarUpdatedAt?.toISOString() ?? null,
    agent: actor.agent,
  };
}

type SerializedActor = NonNullable<ReturnType<typeof serializeActor>>;
type TaskActivityActorRow = {
  taskId: string | null;
  kind: string;
  user: ActorRow | null;
};

function buildTaskActivityActorMaps(rows: TaskActivityActorRow[]) {
  const createdBy = new Map<string, SerializedActor>();
  const updatedBy = new Map<string, SerializedActor>();

  for (const row of rows) {
    if (!row.taskId || !row.user) continue;
    const actor = serializeActor(row.user);
    if (!actor) continue;
    if (!updatedBy.has(row.taskId)) updatedBy.set(row.taskId, actor);
    if (row.kind === "task.create" && !createdBy.has(row.taskId)) {
      createdBy.set(row.taskId, actor);
    }
  }

  return { createdBy, updatedBy };
}

export const dynamic = "force-dynamic";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function payloadValue(payload: string | null | undefined, key: string) {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

async function requireActor(): Promise<{ id: string; kind: "human" | "agent" }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  return {
    id,
    kind: session.user?.kind === "agent" ? "agent" : "human",
  };
}

async function approveEpicActionPlan(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const epicId = String(formData.get("epicId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  if (!epicId || !slug) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      title: true,
      projectId: true,
      reporterId: true,
      actingManagerId: true,
      approvedOn: true,
      deletedAt: true,
      project: { select: { slug: true, onlyReportersCanApproveActionPlans: true } },
      _count: {
        select: {
          tasks: { where: { deletedAt: null, parentTaskId: null } },
        },
      },
      actingManager: {
        select: {
          id: true,
          kind: true,
          username: true,
          agent: { select: { slug: true } },
        },
      },
    },
  });
  if (!epic || epic.deletedAt || epic.project.slug !== slug) return;
  const canApprove = epic.project.onlyReportersCanApproveActionPlans
    ? actor.id === epic.reporterId
    : actor.id === epic.reporterId || actor.id === epic.actingManagerId;
  if (!canApprove) {
    throw new Error(epic.project.onlyReportersCanApproveActionPlans
      ? "Only the Epic reporter can approve the Action Plan for this project."
      : "Only the Epic reporter or acting manager can approve the Action Plan.");
  }
  if (epic.approvedOn) return;

  const approvedAt = new Date();
  await db.$transaction([
    db.epic.update({
      where: { id: epic.id },
      data: {
        approvedOn: approvedAt,
        approvedById: actor.id,
      },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: actor.id,
        kind: "epic.action_plan.approve",
        payload: JSON.stringify({ epicId: epic.id }),
      },
    }),
  ]);

  const managerSlug = epic.actingManager?.kind === "agent"
    ? epic.actingManager.agent?.slug ?? null
    : null;
  if (managerSlug && epic._count.tasks === 0) {
    const notify = new FormData();
    notify.set("projectSlug", slug);
    notify.set("epicId", epic.id);
    notify.set("discussionTarget", `agent:${managerSlug}`);
    notify.set("body", [
      `Action Plan approved for Epic "${epic.title}".`,
      "Create the ordered child tasks for this Epic now. Use the work-item proposal endpoint from this turn.",
      "Only create top-level Epic tasks when the Epic has no existing top-level tasks. If the Epic already has its implementation sequence, do not add duplicate tasks.",
      "Each child task title must start with the implementation order: `1.`, `2.`, `3.`, and so on. Keep each task standalone and assignable.",
    ].join("\n"));
    await sendAgentChatMessage(notify);
  }

  revalidatePath(`/projects/${slug}/epics/${epic.id}`);
  revalidatePath(`/projects/${slug}`);
}

function discussionTargetValue(
  principal: { id?: string | null; kind?: string | null; agent?: { slug?: string | null } | null } | null | undefined,
) {
  if (!principal?.id) return null;
  if (principal.kind === "agent" && principal.agent?.slug) return `agent:${principal.agent.slug}`;
  return `user:${principal.id}`;
}

function settledAgentSlugsForMessage(
  rows: Array<{ kind: string; payload: string | null; targetAgent?: string | null }>,
  messageId: string,
  runs: Array<{ messageId: string; agentSlug: string; status: string }> = [],
) {
  const slugs = new Set<string>();
  for (const run of runs) {
    if (run.messageId === messageId && run.status === "complete") {
      slugs.add(run.agentSlug);
    }
  }
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as {
        inReplyToMessageId?: unknown;
        messageId?: unknown;
        agentSlug?: unknown;
      };
      const agentSlug =
        typeof row.targetAgent === "string"
          ? row.targetAgent
          : typeof payload.agentSlug === "string"
            ? payload.agentSlug
            : null;
      if (!agentSlug) continue;
      if (
        row.kind === "epic.chat.reply" &&
        payload.inReplyToMessageId === messageId
      ) {
        slugs.add(agentSlug);
      }
    } catch {
      // Ignore old or malformed audit payloads.
    }
  }
  return slugs;
}

const EPIC_TABS = ["Description", "Action Plan", "Deployment", "Tasks", "Attachments", "Comments", "Activities", "Changes"] as const;

function tabParam(tab: string) {
  return tab
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tabFromSearchParam(raw: string | undefined, tabs: readonly string[]) {
  if (!raw) return null;
  const normalized = tabParam(raw);
  if (normalized === "discussion") {
    return tabs.find((tab) => tab === "Action Plan") ?? null;
  }
  return tabs.find((tab) => tabParam(tab) === normalized) ?? null;
}

const TASK_STATUS_ORDER = [
  "Backlog",
  "To Do",
  "In Progress",
  "Review",
  "Done",
] as const;

export default async function EpicDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; epicId: string }>;
  searchParams: Promise<{ chat?: string; chatArchive?: string; chatRoom?: string; tab?: string; commit?: string; file?: string }>;
}) {
  const [{ slug, epicId }, { chat = "", chatArchive = "", chatRoom = "", tab = "", commit = "", file = "" }] = await Promise.all([
    params,
    searchParams,
  ]);
  const selectedTab = chatArchive || chatRoom === "current"
    ? "Action Plan"
    : tabFromSearchParam(tab, EPIC_TABS) ?? "Description";

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    include: {
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          repositoryPath: true,
          onlyReportersCanApproveActionPlans: true,
        },
      },
      actingManager: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          status: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
        },
      },
      assignee: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          status: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
        },
      },
      reporter: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          status: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
        },
      },
      approvedBy: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, name: true, avatar: true } },
        },
      },
      archivedBy: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, name: true, avatar: true } },
        },
      },
      tasks: {
        where: { deletedAt: null, parentTaskId: null },
        orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          workItemKey: true,
          title: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          statusChangedAt: true,
          approvedOn: true,
          archivedAt: true,
          reporter: {
            select: {
              id: true,
              username: true,
              name: true,
              kind: true,
              avatarUpdatedAt: true,
              agent: { select: { slug: true, name: true, avatar: true } },
            },
          },
          assignee: {
            select: {
              id: true,
              username: true,
              name: true,
              kind: true,
              avatarUpdatedAt: true,
              agent: { select: { slug: true, name: true, avatar: true } },
            },
          },
          actingManager: {
            select: {
              id: true,
              username: true,
              name: true,
              kind: true,
              avatarUpdatedAt: true,
              agent: { select: { slug: true, name: true, avatar: true } },
            },
          },
        },
      },
      attachments: {
        orderBy: { createdAt: "desc" },
        include: { uploader: { select: { username: true } } },
      },
      comments: {
        // Soft-deleted comments (HOMELAB-41 / item 2) stay on the
        // human-facing page so the dotted divider can render; agent
        // context filters deletedAt: null upstream.
        orderBy: { createdAt: "asc" },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              kind: true,
              name: true,
              avatarUpdatedAt: true,
              agent: { select: { slug: true, name: true, avatar: true } },
            },
          },
          deletedBy: {
            select: { id: true, username: true, name: true, kind: true },
          },
        },
      },
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) notFound();

  // Comment delete is a human-only control (mirrors the task editor).
  const session = await auth();
  const canDeleteComments = session?.user?.kind !== "agent";
  const taskIds = epic.tasks.map((task) => task.id);
  const [principals, recentReplyActivity, allActivity, taskActivityRows, deploymentPullRequests] = await Promise.all([
    listAssignablePrincipals(),
    db.activityLog.findMany({
      where: {
        projectId: epic.project.id,
        kind: {
          in: [
            "epic.chat.reply",
            "epic.chat.dispatch_failed",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 160,
      select: { kind: true, payload: true, targetAgent: true },
    }),
    db.activityLog.findMany({
      where: {
        projectId: epic.project.id,
        payload: { contains: epic.id },
      },
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            kind: true,
            name: true,
            avatarUpdatedAt: true,
            agent: { select: { slug: true, name: true, avatar: true } },
          },
        },
      },
    }) as Promise<ActivityTimelineRow[]>,
    taskIds.length > 0
      ? db.activityLog.findMany({
          where: { taskId: { in: taskIds } },
          orderBy: { createdAt: "desc" },
          select: {
            taskId: true,
            kind: true,
            user: { select: actorSelect },
          },
        })
      : Promise.resolve([]),
    db.deploymentPullRequest.findMany({
      where: { OR: [{ epicId: epic.id }, ...(taskIds.length ? [{ taskId: { in: taskIds } }] : [])] },
      orderBy: [{ taskId: "asc" }, { updatedAt: "desc" }],
      include: { task: { select: { workItemKey: true, title: true } } },
    }) as Promise<DeploymentPrRow[]>,
  ]);
  const taskActivityActors = buildTaskActivityActorMaps(taskActivityRows);
  const selectedAgentSlug = chat || epic.actingManager?.agent?.slug || null;

  const chatMessages = await db.agentChatMessage.findMany({
    where: {
      epicId: epic.id,
      agentSlug: "room",
      archiveId: null,
    },
    // Soft-deleted bubbles (HOMELAB-41 / item 2) stay in this list so
    // ChatRoom can render the collapsed dotted divider. Agent context
    // (lib/agents/context/epic.ts) filters them out.
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
  const pendingProposals = await db.workItemProposal.findMany({
    where: {
      status: "pending",
      projectId: epic.projectId,
      grantMessageId: { in: chatMessages.map((m) => m.id) },
    },
    include: {
      project: { select: { name: true } },
    },
  });
  const pendingDescriptionMessages = await db.agentChatMessage.findMany({
    where: {
      epicId: epic.id,
      allowDescriptionEdit: true,
      originChannel: "description",
      editGrantUsedAt: null,
    },
    select: { id: true },
  });
  const pendingDescMsgIds = pendingDescriptionMessages.map((m) => m.id);
  const runningDescriptionRun = pendingDescMsgIds.length > 0
    ? await db.pmChannelRun.findFirst({
        where: {
          epicId: epic.id,
          messageId: { in: pendingDescMsgIds },
          status: { in: ["queued", "accepted", "streaming"] },
        },
        select: { messageId: true, agentSlug: true },
      })
    : null;
  const isAiDescriptionRunning = runningDescriptionRun !== null;

  // Draft is requester-bound — only the human who clicked "Ask AI" sees
  // it, and only while their page heartbeats. See lib/description-drafts.ts.
  const { getDescriptionDraft } = await import("@/lib/description-drafts");
  const draftDescription = session?.user?.id
    ? await getDescriptionDraft({
        scope: "epic",
        targetId: epic.id,
        requesterUserId: session.user.id,
      })
    : null;

  const [chatArchives, binChatArchives, selectedChatArchive] = await Promise.all([
    db.agentChatRoomArchive.findMany({
      where: { projectId: epic.project.id, epicId: epic.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        messageCount: true,
      },
    }),
    db.agentChatRoomArchive.findMany({
      where: { projectId: epic.project.id, epicId: epic.id, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      take: 20,
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        messageCount: true,
        deletedAt: true,
      },
    }),
    chatArchive
      ? db.agentChatRoomArchive.findFirst({
          where: { id: chatArchive, projectId: epic.project.id, epicId: epic.id },
          include: {
            messages: {
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
              },
            },
          },
        })
      : Promise.resolve(null),
  ]);
  const visibleChatMessages = selectedChatArchive?.messages ?? chatMessages;
  const visibleActionPlanMessages = visibleChatMessages.filter(
    (message) => !message.body.startsWith("PM workflow notification for @"),
  );
  const activeActionPlanMessageCount = chatMessages.filter(
    (message) => !message.body.startsWith("PM workflow notification for @"),
  ).length;
  const epicCommitPrefix = effectiveCommitPrefix({
    commitPrefix: epic.commitPrefix,
    workItemKey: epic.workItemKey,
  });
  const epicChanges = selectedTab === "Changes"
    ? await getTaskGitChanges({
        repositoryPath: epic.project.repositoryPath,
        branchName: epic.branchName,
        commitPrefix: epicCommitPrefix,
      })
    : { commits: [], ref: null, error: null };
  const selectedDiff = selectedTab === "Changes"
    ? await getTaskGitFileDiff({
        repositoryPath: epic.project.repositoryPath,
        commitHash: commit,
        filePath: file,
      })
    : null;
  const viewingChatArchive = Boolean(selectedChatArchive);
  const selectedChatArchiveDeleted = Boolean(selectedChatArchive?.deletedAt);
  const humanChatMessageIds = chatMessages
    .filter((message) => message.sender.kind !== "agent")
    .map((message) => message.id);
  const completedChatRuns = humanChatMessageIds.length
    ? await db.pmChannelRun.findMany({
        where: {
          kind: "epic-chat",
          epicId: epic.id,
          messageId: { in: humanChatMessageIds },
          status: "complete",
        },
        select: { messageId: true, agentSlug: true, status: true },
      })
    : [];

  const pendingAgents: Array<{ slug: string; username: string }> = [];
  let pendingChatMessageId: string | null = null;

  if (chatMessages.some((message) => message.sender.kind !== "agent")) {
    const users = await db.user.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        kind: true,
        status: true,
        agent: { select: { slug: true, role: true, deactivatedAt: true, name: true } },
      },
    });

    for (const message of [...chatMessages].reverse()) {
      if (message.sender.kind === "agent") continue;
      const mentions = extractMentions(
        message.body,
        users.map((u) => ({ username: u.username })),
      );
      const targetAgents = new Map<string, { slug: string; username: string }>();
      const addPendingAgent = (u: (typeof users)[number] | null | undefined) => {
        if (
          u &&
          u.kind === "agent" &&
          u.status === "active" &&
          u.agent &&
          !u.agent.deactivatedAt
        ) {
          targetAgents.set(u.agent.slug, {
            slug: u.agent.slug,
            username: u.agent.name || u.username,
          });
        }
      };

      if (message.targetType === "all-coders") {
        for (const u of users) {
          if (u.agent?.role === "coding") addPendingAgent(u);
        }
      } else if (message.targetType === "agent" && message.targetValue?.startsWith("agent:")) {
        const agentSlug = message.targetValue.slice("agent:".length);
        addPendingAgent(users.find((u) => u.agent?.slug === agentSlug));
      } else if (message.targetType === "multi" && message.targetValue) {
        try {
          const targets = JSON.parse(message.targetValue) as unknown;
          if (Array.isArray(targets)) {
            for (const target of targets) {
              if (typeof target !== "string" || !target.startsWith("agent:")) continue;
              const agentSlug = target.slice("agent:".length);
              addPendingAgent(users.find((u) => u.agent?.slug === agentSlug));
            }
          }
        } catch {
          // Ignore malformed historical target payloads.
        }
      } else if (!message.targetType && mentions.length === 0) {
        addPendingAgent(epic.actingManager);
      }

      for (const u of users) {
        if (mentions.includes(u.username)) {
          addPendingAgent(u);
        }
      }

      const settled = settledAgentSlugsForMessage(recentReplyActivity, message.id, completedChatRuns);
      const stillPending = [...targetAgents.values()].filter((agent) => !settled.has(agent.slug));
      if (stillPending.length > 0) {
        pendingChatMessageId = message.id;
        pendingAgents.push(...stillPending);
        break;
      }
    }
  }

  const discussionTargets = principals.map((p) => ({
    value: p.kind === "agent" && p.agentSlug ? `agent:${p.agentSlug}` : `user:${p.id}`,
    label: p.name,
    group: p.kind === "agent" ? "Agents" as const : "Users" as const,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt,
      agent: p.kind === "agent"
        ? { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar }
        : null,
    },
  }));
  const defaultDiscussionTarget = discussionTargetValue(epic.actingManager);
  const principalOptions: AvatarComboboxOption[] = principals.map((p) => ({
    value: p.id,
    label: p.name,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt,
      agent: p.kind === "agent"
        ? { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar }
        : null,
    },
  }));
  const reporterOptions = epic.reporter && !principals.some((p) => p.id === epic.reporterId)
    ? [
        ...principalOptions,
        {
          value: epic.reporter.id,
          label: actorDisplayName(serializeActor(epic.reporter)!),
          actor: serializeActor(epic.reporter),
        },
      ]
    : principalOptions;
  const aiTargetOptions: AvatarComboboxOption[] = principals.flatMap((p) => {
    if (p.kind !== "agent" || !p.agentSlug) return [];
    return [{
      value: `agent:${p.agentSlug}`,
      label: p.name,
      actor: {
        id: p.id,
        username: p.username,
        kind: p.kind,
        name: p.name,
        avatarUpdatedAt: p.avatarUpdatedAt,
        agent: { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar },
      },
    }];
  });
  const defaultAiTarget = [discussionTargetValue(epic.actingManager)].find((value) =>
    Boolean(value?.startsWith("agent:") && aiTargetOptions.some((option) => option.value === value)),
  ) ?? aiTargetOptions[0]?.value ?? "";
  const canApproveActionPlan =
    !epic.approvedOn &&
    Boolean(session?.user?.id && (
      epic.project.onlyReportersCanApproveActionPlans
        ? session.user.id === epic.reporterId
        : session.user.id === epic.reporterId || session.user.id === epic.actingManagerId
    ));
  const doneActivity = allActivity.find((row) =>
    row.kind === "epic.status" && payloadValue(row.payload, "to") === "Done"
  );
  const createdActivity = [...allActivity].reverse().find((row) => row.kind === "epic.create");
  const updatedActivity = allActivity.find((row) => (
    row.kind === "epic.update" ||
    row.kind === "epic.status" ||
    row.kind === "epic.action_plan.approve"
  )) ?? createdActivity;

  const tasksByStatus = new Map<string, typeof epic.tasks>();
  for (const s of TASK_STATUS_ORDER) tasksByStatus.set(s, []);
  for (const t of epic.tasks) {
    const list = tasksByStatus.get(t.status) ?? [];
    list.push(t);
    tasksByStatus.set(t.status, list);
  }

  async function reorderEpicTasks(orderedIds: string[]): Promise<void> {
    "use server";
    await reorderTasks(orderedIds);
    revalidatePath(`/projects/${slug}/epics/${epicId}`);
    revalidatePath(`/projects/${slug}`);
  }

  return (
    <div className="mx-auto w-full max-w-none">
      {/* ----- Main -------------------------------------------------- */}
      <div className="min-w-0">
        <section className="space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          {/* Sticky one-row editor header: title, status and save stay visible. */}
          <div className="sticky top-0 z-30 -mx-5 -mt-5 flex flex-wrap items-end gap-3 rounded-t-2xl border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-2 shadow-sm xl:flex-nowrap">
            <label className="min-w-[18rem] flex-1">
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Epic title
                {epic.workItemKey ? (
                  <span className="ml-2 rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {epic.workItemKey}
                  </span>
                ) : null}
              </span>
              <input
                form="epicMain"
                name="title"
                defaultValue={epic.title}
                required
                maxLength={200}
                className="h-9 w-full rounded-lg border border-transparent bg-transparent px-2 text-xl font-semibold tracking-tight outline-none transition focus:border-[var(--color-line)] focus:bg-[var(--color-bg)]"
                aria-label="Epic title"
              />
            </label>
            <label className="w-32 shrink-0">
              <span className="mb-0.5 block text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Status
              </span>
              <select
                form="epicMain"
                name="status"
                defaultValue={epic.status}
                className="h-9 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 text-xs outline-none focus:border-[var(--color-accent)]"
                aria-label="Status"
              >
                <option value="Backlog">Backlog</option>
                <option value="Open">Open</option>
                <option value="Done">Done</option>
              </select>
            </label>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Updated{" "}
                <time
                  dateTime={epic.updatedAt.toISOString()}
                  title={epic.updatedAt.toISOString()}
                >
                  {timeAgo(epic.updatedAt)}
                </time>
              </span>
              <button
                form="epicMain"
                type="submit"
                className="h-9 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Save changes
              </button>
            </div>
          </div>
          {/* One edit form for the whole card: controls carry form="epicMain"
              so the single Save persists status, title, description and
              acting manager together. Empty form so the panels' own forms
              (add-task / upload / comment) are never nested inside it. */}
          <form id="epicMain" action={updateEpic} />
          <input form="epicMain" type="hidden" name="epicId" value={epic.id} />
          <input form="epicMain" type="hidden" name="projectSlug" value={slug} />

          {/* Tabbed content */}
          <TabsProvider defaultTab={selectedTab}>
            <TabsNav
              tabs={EPIC_TABS}
              sticky
            />
            <div className="pt-4">
              <TabPanel name="Description">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
                  <DescriptionField
                    formId="epicMain"
                    previewHtml={renderFullMarkdown(epic.description ?? "").__html}
                    defaultValue={epic.description ?? ""}
                    projectSlug={slug}
                    epicId={epic.id}
                    aiTargets={aiTargetOptions}
                    defaultAiTarget={defaultAiTarget}
                    descriptionLabel="Epic"
                    draftDescription={draftDescription}
                    aiRunning={isAiDescriptionRunning}
                    runningMessageId={runningDescriptionRun?.messageId ?? null}
                    runningAgentSlug={runningDescriptionRun?.agentSlug ?? null}
                    rows={12}
                  />

                  <aside className="space-y-4 xl:sticky xl:top-32 xl:self-start">
                    {/* Dates */}
                    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Dates
                      </div>
                      <dl className="mt-2 space-y-1 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[var(--color-text-muted)]">Created</dt>
                          <dd className="flex items-center gap-2">
                            <time
                              dateTime={epic.createdAt.toISOString()}
                              title={epic.createdAt.toISOString()}
                              className="tabular-nums"
                            >
                              {timeAgo(epic.createdAt)}
                            </time>
                            {createdActivity?.user ? (
                              <MessageAvatar actor={createdActivity.user} size="sm" />
                            ) : epic.reporter ? (
                              <MessageAvatar actor={serializeActor(epic.reporter)!} size="sm" />
                            ) : null}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[var(--color-text-muted)]">Updated</dt>
                          <dd className="flex items-center gap-2">
                            <time
                              dateTime={epic.updatedAt.toISOString()}
                              title={epic.updatedAt.toISOString()}
                              className="tabular-nums"
                            >
                              {timeAgo(epic.updatedAt)}
                            </time>
                            {updatedActivity?.user ? (
                              <MessageAvatar actor={updatedActivity.user} size="sm" />
                            ) : null}
                          </dd>
                        </div>
                        {epic.approvedOn ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-[var(--color-text-muted)]">Approved</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={epic.approvedOn.toISOString()}
                                title={epic.approvedOn.toISOString()}
                                className="tabular-nums"
                              >
                                {timeAgo(epic.approvedOn)}
                              </time>
                              {epic.approvedBy ? <MessageAvatar actor={serializeActor(epic.approvedBy)!} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                        {epic.status === "Done" && epic.statusChangedAt ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-[var(--color-text-muted)]">Done</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={epic.statusChangedAt.toISOString()}
                                title={epic.statusChangedAt.toISOString()}
                                className="tabular-nums"
                              >
                                {timeAgo(epic.statusChangedAt)}
                              </time>
                              {doneActivity?.user ? <MessageAvatar actor={doneActivity.user} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                        {epic.archivedAt ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-[var(--color-text-muted)]">Archived</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={epic.archivedAt.toISOString()}
                                title={epic.archivedAt.toISOString()}
                                className="tabular-nums"
                              >
                                {timeAgo(epic.archivedAt)}
                              </time>
                              {epic.archivedBy ? <MessageAvatar actor={serializeActor(epic.archivedBy)!} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>

                    <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Report by
                        </span>
                        <AvatarCombobox
                          formId="epicMain"
                          name="reporterId"
                          defaultValue={epic.reporterId ?? ""}
                          options={reporterOptions}
                          emptyLabel="No reporter"
                          ariaLabel="Report by"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Acting manager
                        </span>
                        <AvatarCombobox
                          formId="epicMain"
                          name="actingManagerId"
                          defaultValue={epic.actingManagerId ?? ""}
                          options={principalOptions}
                          emptyLabel="No acting manager"
                          ariaLabel="Acting manager"
                        />
                      </label>
                    </div>

                    <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Branch
                        </span>
                        <input
                          form="epicMain"
                          name="branchName"
                          defaultValue={epic.branchName ?? ""}
                          maxLength={200}
                          placeholder="feature/HOMELAB-99"
                          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
                          aria-label="Branch"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Commit prefix
                        </span>
                        <input
                          form="epicMain"
                          name="commitPrefix"
                          defaultValue={epic.commitPrefix ?? ""}
                          maxLength={200}
                          placeholder={epic.workItemKey ? `defaults to ${epic.workItemKey}` : "HOMELAB-99"}
                          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
                          aria-label="Commit prefix"
                        />
                      </label>
                    </div>

                    <form
                      action={epic.archivedAt ? unarchiveEpic : archiveEpic}
                      className="space-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4"
                    >
                      <input type="hidden" name="epicId" value={epic.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        Archive
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {epic.archivedAt
                          ? "Restore this epic to active project views without changing its status."
                          : "Hide this epic from active grids without changing its status."}
                      </p>
                      <button
                        type="submit"
                        className="w-full rounded-lg border border-[var(--color-line)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      >
                        {epic.archivedAt ? "Restore from archive" : "Archive epic"}
                      </button>
                    </form>

                    {/* Danger zone — soft delete moves the Epic and all its non-deleted
                        tasks (plus sub-tasks) to the bin. Its own form. Auto-purged after
                        7 days. */}
                    <form
                      action={deleteEpic}
                      className="space-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4"
                    >
                      <input type="hidden" name="epicId" value={epic.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-crit)]">
                        Danger zone
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        Move this epic to the bin. The {epic.tasks.length} task
                        {epic.tasks.length === 1 ? "" : "s"} under it (plus sub-tasks) go
                        with it. Auto-purged after 7 days.
                      </p>
                      <button
                        type="submit"
                        className="w-full rounded-lg border border-[var(--color-crit)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-crit)] hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
                      >
                        Delete epic
                      </button>
                    </form>
                  </aside>
                </div>
              </TabPanel>


              <TabPanel name="Deployment">
                <DeploymentTab
                  mode="epic"
                  title={epic.title}
                  deploymentStatus={epic.deploymentStatus}
                  rows={deploymentPullRequests}
                  canAct={(row) => canShowDeploymentAction({
                    provider: row.provider,
                    viewerKind: session?.user?.kind === "agent" ? "agent" : "human",
                    viewerId: session?.user?.id ?? null,
                    reporterId: epic.reporterId,
                  })}
                />
              </TabPanel>

              <TabPanel name="Action Plan">
                <div className="space-y-3 pt-2">
                  {canApproveActionPlan ? (
                    <form action={approveEpicActionPlan} className="flex justify-end">
                      <input type="hidden" name="epicId" value={epic.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <button
                        type="submit"
                        className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
                      >
                        Approve Plan
                      </button>
                    </form>
                  ) : null}
                  <ChatRoom
                    projectSlug={slug}
                    epicId={epic.id}
                    messages={visibleActionPlanMessages}
                    activeMessageCount={activeActionPlanMessageCount}
                    archives={chatArchives}
                    binArchives={binChatArchives}
                    selectedArchiveId={selectedChatArchive?.id ?? null}
                    selectedArchiveDeleted={selectedChatArchiveDeleted}
                    viewingArchive={viewingChatArchive}
                    discussionTargets={discussionTargets}
                    defaultDiscussionTarget={defaultDiscussionTarget}
                    pendingAgents={pendingAgents}
                    latestMessageId={viewingChatArchive ? null : pendingChatMessageId}
                    currentUserId={session?.user?.id ?? null}
                    pendingProposals={pendingProposals}
                  />
                </div>
              </TabPanel>

              <TabPanel name="Tasks">
                <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-text)]">
              Tasks ({epic.tasks.length})
            </h2>
            <Link
              href={`/projects/${slug}`}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
            >
              Open board →
            </Link>
          </div>
          {epic.tasks.length === 0 ? (
            <>
              <p className="text-xs text-[var(--color-text-muted)]">
                No tasks linked to this epic yet. Add one manually or ask AI to propose the first task breakdown.
              </p>
              <EpicTasksAiPrompt
                projectSlug={slug}
                epicId={epic.id}
                epicTitle={epic.title}
                aiTargets={aiTargetOptions}
                defaultAiTarget={defaultAiTarget}
                isAiRunning={pendingAgents.length > 0}
              />
            </>
          ) : (
            <EpicTasksClient
              initialTasks={epic.tasks.map((t) => ({
                id: t.id,
                workItemKey: t.workItemKey,
                title: t.title,
                status: t.status,
                href: `/projects/${slug}/tasks/${t.id}`,
                createdAt: t.createdAt.toISOString(),
                statusChangedAt: t.statusChangedAt?.toISOString() ?? null,
                approvedOn: t.approvedOn?.toISOString() ?? null,
                archivedAt: t.archivedAt?.toISOString() ?? null,
                reporter: serializeActor(t.reporter),
                assignee: serializeActor(t.assignee),
                reviewer: serializeActor(t.actingManager),
                createdBy: taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter),
                updatedBy: taskActivityActors.updatedBy.get(t.id) ?? taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter),
                assigneeName: t.assignee?.username ?? null,
                reviewerName: t.actingManager?.username ?? null,
                updatedAt: t.updatedAt.toISOString(),
              }))}
              projectSlug={slug}
              reorderEpicTasks={reorderEpicTasks}
              epicId={epic.id}
            />
          )}

          <AddEpicTaskFab
            projectSlug={slug}
            epicId={epic.id}
            createTaskAction={createTaskInEpic}
          />
                </div>
              </TabPanel>

              <TabPanel name="Attachments">
                <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-text)]">
              Attachments
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">
              Max {formatBytes(attachmentMaxBytes())} per file
            </span>
          </div>
          <AttachmentList
            attachments={epic.attachments}
            projectSlug={slug}
            deleteAction={deleteAttachment}
          />

          <AttachmentUploadFab
            projectSlug={slug}
            epicId={epic.id}
            maxLabel={formatBytes(attachmentMaxBytes())}
            uploadAction={uploadAttachment}
          />
                </div>
              </TabPanel>

              <TabPanel name="Comments">
                <div className="flex h-[calc(100dvh-14rem)] min-h-[560px] flex-col">
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                    {epic.comments.length === 0 ? (
                      <p className="text-xs text-[var(--color-text-muted)]">
                        No comments yet.
                      </p>
                    ) : (
                      <ul className="space-y-3">
                        {epic.comments.map((c) => {
                          if (c.deletedAt) {
                            // Soft-deleted (HOMELAB-41 / item 2):
                            // collapsed dotted divider; humans with
                            // delete privilege can restore via ↺.
                            // Agents never see deleted bodies.
                            return (
                              <li key={c.id}>
                                <DeletedMessageDivider
                                  deletedAt={c.deletedAt}
                                  deletedBy={c.deletedBy}
                                  restore={canDeleteComments ? {
                                    action: restoreEpicComment,
                                    fields: { commentId: c.id, epicId: epic.id, projectSlug: slug },
                                  } : undefined}
                                >
                                  <div
                                    className="md"
                                    dangerouslySetInnerHTML={renderFullMarkdown(c.body)}
                                  />
                                </DeletedMessageDivider>
                              </li>
                            );
                          }
                          return (
                            <li
                              key={c.id}
                              className="flex items-start gap-3 text-sm"
                            >
                              <MessageAvatar actor={c.user} size="sm" />
                              <div className="min-w-0 flex-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <strong className="truncate font-medium text-[var(--color-text)]">
                                      {actorDisplayName(c.user)}
                                    </strong>
                                    <MessageTimestamp value={c.createdAt} />
                                  </div>
                                  {canDeleteComments ? (
                                    <ConfirmedDeleteButton
                                      action={deleteEpicComment}
                                      fields={{ commentId: c.id, epicId: epic.id, projectSlug: slug }}
                                      title="Delete comment"
                                      description="The comment will be hidden behind a collapsed dotted divider that humans can expand. Agents will never see it in their context again."
                                      confirmLabel="Delete comment"
                                      buttonTitle="Delete comment"
                                      ariaLabel="Delete comment"
                                    />
                                  ) : null}
                                </div>
                                <div
                                  className="md"
                                  dangerouslySetInnerHTML={renderFullMarkdown(c.body)}
                                />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {epic.comments.length > 0 ? (
                      <AutoScrollToLatest
                        whenTab="Comments"
                        watchKey={`${epic.comments.length}:${epic.comments.at(-1)?.id ?? ""}`}
                      />
                    ) : null}
                  </div>

                  <CommentComposerFab
                    projectSlug={slug}
                    epicId={epic.id}
                    action={createEpicComment}
                    title="Epic Comment"
                    placeholder="Write a comment — **markdown** supported"
                  />
                </div>
              </TabPanel>

              <TabPanel name="Activities">
                <div className="pt-2">
                  <ActivityTimeline rows={allActivity} />
                </div>
              </TabPanel>

              <TabPanel name="Changes">
                <TaskChangesPanel
                  changes={epicChanges}
                  branchName={epic.branchName}
                  commitPrefix={epicCommitPrefix}
                  baseHref={`/projects/${slug}/epics/${epic.id}`}
                  selectedDiff={selectedDiff}
                />
              </TabPanel>
            </div>
          </TabsProvider>
        </section>
      </div>
    </div>
  );
}
