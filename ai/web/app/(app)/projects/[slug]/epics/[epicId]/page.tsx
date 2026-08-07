import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  updateEpic,
  deleteEpicComment,
  restoreEpicComment,
} from "@/lib/epics/actions";
import {
  deleteAttachment,
} from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { binTask, deleteEpic } from "@/lib/bin/actions";
import { archiveEpic, unarchiveEpic } from "@/lib/archive/actions";
import { approveAndMergeDeploymentPullRequest, approveDeploymentLocalChanges } from "@/lib/deploy/actions";
import { reorderTasks } from "@/lib/tasks/reorder";
import { createdAtMs } from "@/lib/tasks/cache";
import { publishBoardTouch } from "@/lib/pm/board-events";
import SortableTaskList from "@/components/sortable-task-list";
import AttachmentList from "@/components/attachment-list";
import { renderFullMarkdown, extractMentions } from "@/lib/markdown";
import { listAssignablePrincipals } from "@/lib/principals";
import { getTaskGitChanges, getTaskGitFileDiff } from "@/lib/tasks/git-changes";
import AutoScrollToLatest from "@/components/auto-scroll-to-latest";
import ChatRoom from "@/components/chat-room";
import ActivityTimeline, { type ActivityTimelineRow } from "@/components/activity-timeline";
import TaskChangesPanel from "@/components/task-changes-panel";
import ConfirmedDeleteButton from "@/components/confirmed-delete-button";
import DeletedMessageDivider from "@/components/deleted-message-divider";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  syntheticRoleMeta,
} from "@/components/message-avatar";
import DescriptionField from "@/components/description-field";
import PrivateToggle from "@/components/private-toggle";
import { TabsProvider, TabsNav, TabPanel } from "@/components/task-tabs";
import StickyViewportSurface from "@/components/sticky-viewport-surface";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import EpicTasksAiPrompt from "./epic-tasks-ai-prompt";
import EpicTasksClient from "./epic-tasks-client";
import { sendAgentChatMessage } from "@/lib/agents/chat/actions";
import { buildEpicActionPlanApprovalUpdate } from "@/lib/epics/action-plan-approval";
import { epicStatusRevision } from "@/lib/epics/status-concurrency";
import { promoteEpicBacklogTasks } from "@/lib/epics/assignment";
import { refillEpicQueue } from "@/lib/epics/queue";
import { effectiveCommitPrefix, effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import { effectiveEpicBranchName } from "@/lib/work-items/branches";
import DeploymentTab, { DeploymentStatusSelect, canShowDeploymentAction, type DeploymentPrRow } from "@/components/deployment-tab";
import {
  accessibleEpicWhere,
  accessibleTaskWhere,
  requireEpicAccess,
  requireOwner,
  requireTaskAccess,
  requireViewer,
  type Viewer,
} from "@/lib/auth/permissions";
import {
  getActorVisibility,
  serializeVisibleActor,
  serializeVisibleActorAs,
  visibleActivityRows,
  type ActorVisibility,
} from "@/lib/users/actor-visibility";
import { buildAgentRedactor } from "@/lib/users/redact-agents";

type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | string | null;
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

function serializeActor(actor: ActorRow | null, visibility: ActorVisibility) {
  return serializeVisibleActor(actor, visibility);
}

async function readBusyAgentSlugs() {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return new Set<string>();
    const snapshot = (await res.json()) as {
      agents?: Record<string, { busy_state?: { is_busy?: boolean } | null }>;
    };
    const busy = new Set<string>();
    for (const [slug, agent] of Object.entries(snapshot.agents ?? {})) {
      if (agent?.busy_state?.is_busy) busy.add(slug);
    }
    return busy;
  } catch {
    return new Set<string>();
  }
}

type SerializedActor = NonNullable<ReturnType<typeof serializeActor>>;
type TaskActivityActorRow = {
  taskId: string | null;
  kind: string;
  user: ActorRow | null;
};

function buildTaskActivityActorMaps(rows: TaskActivityActorRow[], visibility: ActorVisibility) {
  const createdBy = new Map<string, SerializedActor>();
  const updatedBy = new Map<string, SerializedActor>();

  for (const row of rows) {
    if (!row.taskId || !row.user) continue;
    const actor = serializeActor(row.user, visibility);
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

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  }))];
}

async function requireActor(): Promise<Viewer> {
  return requireViewer();
}

async function approveEpicActionPlan(formData: FormData) {
  "use server";
  const actor = await requireOwner();
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
      status: true,
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
  if (epic.approvedOn) return;

  const approvedAt = new Date();
  const approvalUpdate = buildEpicActionPlanApprovalUpdate({
    currentStatus: epic.status,
    approvedAt,
    actorId: actor.id,
  });
  await db.$transaction([
    db.epic.update({
      where: { id: epic.id },
      data: approvalUpdate.data,
    }),
    db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: actor.id,
        kind: "epic.action_plan.approve",
        payload: JSON.stringify({
          epicId: epic.id,
          ...(approvalUpdate.promoted
            ? { status: "To Do", from: "Backlog", via: "action_plan_approval" }
            : {}),
        }),
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
  } else if (
    epic._count.tasks > 0 &&
    (approvalUpdate.promoted || epic.status === "To Do" || epic.status === "In Progress")
  ) {
    // Only start the queue when this approval puts the Epic INTO (or keeps it
    // in) In Progress. The deploy-review sign-off re-approves a
    // Ready-to-Deploy Epic (resetEpicActionPlanForDeployReview nulls
    // approvedOn, so this action runs again) — that must NOT promote Backlog
    // or tell the manager the finished Epic is back In Progress.
    //
    // The approval is the human go-signal: start the queue in the same
    // request instead of waiting for a manager turn that never comes
    // (observed 24-minute dead-epic stalls on both KYC epics). Promote the
    // Backlog, assign every free pool worker, wake each assignee, and brief
    // the acting manager with a grant-bearing epic-chat turn.
    const promoted = await db.$transaction((tx) =>
      promoteEpicBacklogTasks(tx, {
        epicId: epic.id,
        projectId: epic.projectId,
        actorUserId: actor.id,
        via: "epic-approval",
      }),
    );
    const refill = await refillEpicQueue({
      epicId: epic.id,
      actor: { id: actor.id, kind: "human" },
      via: "epic-approval",
      contextLine: `Epic "${epic.title}" was approved and is now In Progress.`,
    });
    if (managerSlug) {
      const queueSummary = refill.assignments.length > 0
        ? refill.assignments
            .map((assigned) => `- "${assigned.task.title}" -> @${assigned.worker.username}`)
            .join("\n")
        : `- no assignment made (${refill.skipped ?? "queue busy"})`;
      const notify = new FormData();
      notify.set("projectSlug", slug);
      notify.set("epicId", epic.id);
      notify.set("discussionTarget", `agent:${managerSlug}`);
      notify.set("body", [
        `Action Plan approved for Epic "${epic.title}" — the Epic is now In Progress.`,
        `PM promoted ${promoted.length} Backlog task${promoted.length === 1 ? "" : "s"} to To Do and started the queue:`,
        queueSummary,
        "You are the acting manager: keep every pool worker busy. Whenever a worker is free and an unblocked To Do task exists, use this turn's workflow grant (assign_next / advance_queue). Do not wait for a human prompt.",
        "Do not post an acknowledgement-only response.",
      ].join("\n"));
      await sendAgentChatMessage(notify);
    }
    for (const assigned of refill.assignments) {
      revalidatePath(`/projects/${slug}/tasks/${assigned.task.id}`);
    }
  }

  revalidatePath(`/projects/${slug}/epics/${epic.id}`);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(epic.projectId);
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
    if (run.messageId === messageId && run.status === "completed") {
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

const DEVELOPMENT_TAB = "Development";
const EPIC_TABS = ["Description", "Action Plan", "Tasks", "Attachments", "Comments", "Activities", DEVELOPMENT_TAB, "Changes"] as const;
const OWNER_ONLY_EPIC_TABS = new Set(["Action Plan", "Activities", DEVELOPMENT_TAB, "Changes"]);

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
  if (normalized === "deployment") {
    return tabs.find((tab) => tab === DEVELOPMENT_TAB) ?? null;
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
  let selectedTab = chatArchive || chatRoom === "current"
    ? "Action Plan"
    : tabFromSearchParam(tab, EPIC_TABS) ?? "Description";

  const viewer = await requireActor();

  const epic = await db.epic.findFirst({
    where: accessibleEpicWhere(viewer, { id: epicId }),
    include: {
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          repositoryPath: true,
          onlyReportersCanApproveActionPlans: true,
          onlyReportersCanApprovePullRequests: true,
          deploymentProductionBranch: true,
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
      deployReviewer: {
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
      workers: {
        orderBy: { createdAt: "asc" },
        include: {
          user: {
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
        where: accessibleTaskWhere(viewer, { deletedAt: null, parentTaskId: null }),
        orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          workItemKey: true,
          title: true,
          status: true,
          alertReporter: true,
          createdAt: true,
          updatedAt: true,
          statusChangedAt: true,
          approvedOn: true,
          archivedAt: true,
          branchName: true,
          commitPrefix: true,
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
        include: { uploader: { select: { username: true, kind: true } } },
      },
      comments: {
        // Soft-deleted comments (HOMELAB-41 / item 2) stay on the
        // human-facing page so the dotted divider can render; agent
        // context filters deletedAt: null upstream.
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          body: true,
          createdAt: true,
          deletedAt: true,
          deletedById: true,
          userId: true,
          authorAgentSlug: true,
          provider: true,
          model: true,
          commentKind: true,
          isGenerated: true,
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

  const canDeleteComments = viewer.isOwner;
  // Deployment is an optional post-Done step, only for repo-backed projects.
  const epicHasDeployment = Boolean(epic.project.repositoryPath) && epic.status === "Done";
  const epicTabs = EPIC_TABS
    .filter((name) => name !== DEVELOPMENT_TAB || epicHasDeployment)
    .filter((name) => viewer.isOwner || !OWNER_ONLY_EPIC_TABS.has(name));
  if (!epicTabs.some((name) => name === selectedTab)) selectedTab = "Description";
  const taskIds = epic.tasks.map((task) => task.id);
  const [principals, recentReplyActivity, allActivity, taskActivityRows, deploymentPullRequests, busyAgentSlugs, actorVisibility, agentUsers] = await Promise.all([
    viewer.isOwner ? listAssignablePrincipals(viewer) : Promise.resolve([]),
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
    }) as Promise<Array<ActivityTimelineRow & { taskId: string | null }>>,
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
    viewer.isOwner && selectedTab === DEVELOPMENT_TAB
      ? db.deploymentPullRequest.findMany({
          where: { OR: [{ epicId: epic.id }, ...(taskIds.length ? [{ taskId: { in: taskIds } }] : [])] },
          orderBy: [{ taskId: "asc" }, { updatedAt: "desc" }],
          include: { task: { select: { workItemKey: true, title: true } } },
        }) as Promise<DeploymentPrRow[]>
      : Promise.resolve([]),
    viewer.isOwner ? readBusyAgentSlugs() : Promise.resolve(new Set<string>()),
    getActorVisibility(viewer),
    viewer.isOwner
      ? Promise.resolve([])
      : db.user.findMany({ where: { kind: "agent" }, select: { username: true } }),
  ]);
  const visibleTaskIds = new Set(taskIds);
  const visibleAttachments = epic.attachments.map((attachment) => ({
    ...attachment,
    uploader: !viewer.isOwner && attachment.uploader?.kind === "agent"
      ? (actorVisibility.owner ? { username: actorVisibility.owner.username } : null)
      : attachment.uploader,
  }));
  const visibleActivity = visibleActivityRows(
    allActivity.filter((row) => (
      viewer.isOwner || (row.taskId ? visibleTaskIds.has(row.taskId) : !row.kind.startsWith("task."))
    )),
    actorVisibility,
  );
  const taskActivityActors = buildTaskActivityActorMaps(taskActivityRows, actorVisibility);
  const selectedAgentSlug = viewer.isOwner ? chat || epic.actingManager?.agent?.slug || null : null;
  // Resolved reviewer for role-aware comment identity on an epic.
  const resolvedReviewerId = epic.actingManagerId ?? null;
  // Body redactor: strips real agent slugs/usernames/names from member-visible
  // comment bodies. No-op for the owner.
  const redactBody = buildAgentRedactor(actorVisibility.agentIdentities, actorVisibility.maskAgents);
  const visibleEpicComments = viewer.isOwner
    ? epic.comments
    : epic.comments.filter((comment) => {
        // Deleted agent comments stay hidden from members (the deleted-divider
        // reveal would expose the raw body + deleting agent's slug).
        if (comment.user.kind === "agent") return !comment.deletedAt;
        // Owner's @agent-mention notes stay hidden (they embed real slugs).
        return !(
          comment.user.id === actorVisibility.owner?.id &&
          extractMentions(comment.body, agentUsers).length > 0
        );
      });

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
  const currentUserId = viewer.id;
  const epicChatCursorKey = `epic:${epic.id}`;
  const epicChatReadCursor = currentUserId
    ? await db.chatReadCursor.findUnique({
        where: { userId_agentSlug: { userId: currentUserId, agentSlug: epicChatCursorKey } },
        select: { lastReadAt: true },
      })
    : null;
  // Normalize both sides to epoch ms before comparing the read cursor so the
  // unread filter stays correct regardless of whether createdAt is a Date or a
  // (cache-revived) ISO string. See the task page for the cached-string variant.
  const epicChatReadCursorMs = epicChatReadCursor ? epicChatReadCursor.lastReadAt.getTime() : null;
  const unreadActionPlanMessages = currentUserId
    ? chatMessages.filter((message) => (
        !message.deletedAt
        && !message.body.startsWith("PM workflow notification for @")
        && message.sender.id !== currentUserId
        && (epicChatReadCursorMs === null || createdAtMs(message.createdAt) > epicChatReadCursorMs)
      ))
    : [];
  const firstUnreadMessageId = unreadActionPlanMessages[0]?.id ?? null;
  if (currentUserId && selectedTab === "Action Plan" && !chatArchive) {
    await db.chatReadCursor.upsert({
      where: { userId_agentSlug: { userId: currentUserId, agentSlug: epicChatCursorKey } },
      create: { userId: currentUserId, agentSlug: epicChatCursorKey },
      update: { lastReadAt: new Date() },
    });
  }
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
  const draftDescription = viewer.id
    ? await getDescriptionDraft({
        scope: "epic",
        targetId: epic.id,
        requesterUserId: viewer.id,
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
  const childTaskCommitPrefixes = epic.tasks.flatMap((task) => [
    effectiveTaskCommitPrefix({ ...task, epic }),
    task.workItemKey,
  ]);
  const epicChangeCommitPrefixes = uniqueStrings([
    epicCommitPrefix,
    epic.workItemKey,
    ...childTaskCommitPrefixes,
  ]);
  // Preserve an explicit child override for Epics that do not configure a
  // shared branch; only then fall back to the Epic's human-key branch.
  const epicChangeBranchName = epic.branchName?.trim()
    || epic.tasks.find((task) => task.branchName?.trim())?.branchName?.trim()
    || effectiveEpicBranchName(epic);
  const epicChanges = selectedTab === "Changes"
    ? await getTaskGitChanges({
        repositoryPath: epic.project.repositoryPath,
        branchName: epicChangeBranchName,
        commitPrefix: epicChangeCommitPrefixes,
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
          status: "completed",
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
  const workerOptions = principalOptions.filter((option) => option.actor?.kind === "agent");
  const workerIds = epic.workers.map((worker) => worker.userId);
  const reporterOptions = epic.reporter && !principals.some((p) => p.id === epic.reporterId)
    ? [
        ...principalOptions,
        {
          value: epic.reporter.id,
          label: actorDisplayName(serializeActor(epic.reporter, actorVisibility)!),
          actor: serializeActor(epic.reporter, actorVisibility),
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
    Boolean(viewer.id && (
      viewer.kind !== "agent" ||
      (epic.project.onlyReportersCanApproveActionPlans
        ? viewer.id === epic.reporterId
        : viewer.id === epic.reporterId || viewer.id === epic.actingManagerId)
    ));
  const doneActivity = visibleActivity.find((row) =>
    row.kind === "epic.status" && payloadValue(row.payload, "to") === "Done"
  );
  const createdActivity = [...visibleActivity].reverse().find((row) => row.kind === "epic.create");
  const updatedActivity = visibleActivity.find((row) => (
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

  const reorderProjectId = epic.projectId;
  async function reorderEpicTasks(orderedIds: string[]): Promise<void> {
    "use server";
    const actor = await requireViewer();
    await requireEpicAccess(actor, epicId);
    const ids = [...new Set(orderedIds)];
    const taskCount = await db.task.count({
      where: accessibleTaskWhere(actor, { id: { in: ids }, epicId }),
    });
    if (taskCount !== ids.length) throw new Error("Not authorized");
    await Promise.all(ids.map((id) => requireTaskAccess(actor, id)));
    await reorderTasks(ids);
    publishBoardTouch(reorderProjectId);
    revalidatePath(`/projects/${slug}/epics/${epicId}`);
    revalidatePath(`/projects/${slug}`);
  }

  return (
    <StickyViewportSurface kind="epic-detail">
    <div className="mx-auto w-full max-w-none">
      {/* ----- Main -------------------------------------------------- */}
      <div className="min-w-0">
        <section data-task-quick-add-context className="space-y-section-gap rounded-panel border border-line bg-panel p-card-lg shadow-sm">
          {/* Sticky one-row editor header: title, privacy, status and save stay visible. */}
          <div
            data-detail-header
            data-epic-header
            className="sticky top-[var(--detail-sticky-top)] z-20 -mx-5 -mt-5 flex flex-wrap items-end gap-3 rounded-t-2xl border-b border-line bg-panel px-5 py-2 shadow-sm xl:flex-nowrap"
          >
            <label className="min-w-[18rem] flex-1">
              <span className="mb-0.5 block text-nano font-semibold uppercase tracking-wider text-text-muted">
                Epic title
                {epic.workItemKey ? (
                  <span className="ml-2 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-nano text-text-muted">
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
                className="h-9 w-full rounded-lg border border-transparent bg-transparent px-2 text-heading font-semibold tracking-tight outline-none transition focus:border-line focus:bg-bg"
                aria-label="Epic title"
              />
            </label>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-nano font-semibold uppercase tracking-wider text-text-muted">
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
                className="h-9 rounded-lg bg-accent px-3 text-body font-medium text-bg hover:opacity-90"
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
          <input
            form="epicMain"
            type="hidden"
            name="statusRevision"
            value={epicStatusRevision(epic.statusChangedAt)}
          />

          {/* Tabbed content */}
          <TabsProvider defaultTab={selectedTab}>
            <TabsNav
              tabs={epicTabs}
              sticky
              badges={viewer.isOwner ? { "Action Plan": unreadActionPlanMessages.length } : undefined}
            />
            <div className="pt-4">
              <TabPanel name="Description">
                <div className="grid gap-card xl:grid-cols-[minmax(0,1fr)_20rem]">
                  <DescriptionField
                    formId="epicMain"
                    previewHtml={renderFullMarkdown(epic.description ?? "").__html}
                    defaultValue={epic.description ?? ""}
                    projectSlug={slug}
                    epicId={epic.id}
                    aiTargets={viewer.isOwner ? aiTargetOptions : []}
                    defaultAiTarget={viewer.isOwner ? defaultAiTarget : ""}
                    descriptionLabel="Epic"
                    draftDescription={draftDescription}
                    aiRunning={viewer.isOwner && isAiDescriptionRunning}
                    runningMessageId={viewer.isOwner ? runningDescriptionRun?.messageId ?? null : null}
                    runningAgentSlug={viewer.isOwner ? runningDescriptionRun?.agentSlug ?? null : null}
                    rows={12}
                  />

                  <aside className="space-y-section-gap xl:sticky xl:top-[calc(var(--detail-sticky-top)+var(--detail-header-height)+var(--detail-tabs-height)+1rem)] xl:self-start">
                    {/* Status + Private — mirrors the Task form's sidebar top. */}
                    <div className="flex items-end gap-3">
                      <label className="min-w-0 flex-1">
                        <span className="mb-0.5 block text-nano font-semibold uppercase tracking-wider text-text-muted">
                          Status
                        </span>
                        <select
                          key={`${epic.status}:${epicStatusRevision(epic.statusChangedAt)}`}
                          form="epicMain"
                          name="status"
                          defaultValue={epic.status}
                          className="h-9 w-full rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
                          aria-label="Status"
                        >
                          <option value="Backlog">Backlog</option>
                          <option value="To Do">To Do</option>
                          <option value="In Progress">In Progress</option>
                          <option value="Done">Done</option>
                        </select>
                      </label>
                      {viewer.isOwner ? (
                        <PrivateToggle
                          formId="epicMain"
                          defaultChecked={epic.private}
                          includeSubmittedField
                        />
                      ) : null}
                    </div>

                    {viewer.isOwner ? (
                      <div className="grid grid-cols-2 gap-3 rounded-card border border-line bg-panel-soft p-card">
                        <div className="min-w-0">
                          <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Report by</span>
                          <AvatarCombobox formId="epicMain" name="reporterId" defaultValue={epic.reporterId ?? ""} options={reporterOptions} emptyLabel="No reporter" ariaLabel="Report by" />
                        </div>
                        <div className="min-w-0">
                          <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Worker pool</span>
                          <AvatarCombobox formId="epicMain" name="assigneeId" defaultValues={workerIds} options={workerOptions} emptyLabel="No workers" ariaLabel="Worker pool" multiple />
                          <input form="epicMain" type="hidden" name="workerPoolSubmitted" value="1" />
                        </div>
                        <div className="min-w-0">
                          <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Acting manager</span>
                          <AvatarCombobox formId="epicMain" name="actingManagerId" defaultValue={epic.actingManagerId ?? ""} options={principalOptions} emptyLabel="No acting manager" ariaLabel="Acting manager" />
                        </div>
                        <div className="min-w-0">
                          <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Deploy reviewer</span>
                          <AvatarCombobox formId="epicMain" name="deployReviewerId" defaultValue={epic.deployReviewerId ?? ""} options={workerOptions} emptyLabel="Use Monitor Agent" ariaLabel="Deploy reviewer" />
                        </div>
                      </div>
                    ) : null}

                    {/* Branch, commit prefix, and deployment — persisted by the card's single Save. */}
                    <div className="space-y-3 rounded-card border border-line bg-panel-soft p-card">
                      <label className="block">
                        <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">
                          Branch
                        </span>
                        <input
                          form="epicMain"
                          name="branchName"
                          defaultValue={epic.branchName ?? ""}
                          maxLength={200}
                          placeholder={epicChangeBranchName ? `defaults to ${epicChangeBranchName}` : "feature/HOMELAB-99"}
                          className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 font-mono text-caption outline-none focus:border-accent"
                          aria-label="Branch"
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block min-w-0">
                          <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">
                            Commit prefix
                          </span>
                          <input
                            form="epicMain"
                            name="commitPrefix"
                            defaultValue={epic.commitPrefix ?? ""}
                            maxLength={200}
                            placeholder={epicCommitPrefix ? `defaults to ${epicCommitPrefix}` : "HOMELAB-99"}
                            className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 font-mono text-caption outline-none focus:border-accent"
                            aria-label="Commit prefix"
                          />
                        </label>
                        <div className="min-w-0">
                          {epicHasDeployment ? (
                            <DeploymentStatusSelect formId="epicMain" defaultValue={epic.deploymentStatus} />
                          ) : (
                            <div>
                              <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Deployment status</span>
                              <div className="flex min-h-9 items-center rounded-lg border border-line bg-bg px-2 text-caption text-text-muted">
                                {epic.deploymentStatus}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <form
                        action={epic.archivedAt ? unarchiveEpic : archiveEpic}
                        className="flex h-full flex-col gap-2 rounded-card border border-line bg-panel-soft p-card"
                      >
                        <input type="hidden" name="epicId" value={epic.id} />
                        <input type="hidden" name="projectSlug" value={slug} />
                        <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                          Archive
                        </div>
                        <p className="flex-1 text-caption text-text-muted">
                          {epic.archivedAt
                            ? "Restore this epic to active project views without changing its status."
                            : "Hide this epic from active grids without changing its status."}
                        </p>
                        <button
                          type="submit"
                          className="mt-auto w-full rounded-lg border border-line bg-transparent px-control-x py-control-y text-caption font-medium text-text hover:border-accent hover:text-accent"
                        >
                          {epic.archivedAt ? "Restore from archive" : "Archive epic"}
                        </button>
                      </form>

                      {/* Danger zone — soft delete moves the Epic and all its non-deleted
                          tasks (plus sub-tasks) to the bin. Its own form. Auto-purged after
                          7 days. */}
                      <form
                        action={deleteEpic}
                        className="flex h-full flex-col gap-2 rounded-card border border-line bg-panel-soft p-card"
                      >
                        <input type="hidden" name="epicId" value={epic.id} />
                        <input type="hidden" name="projectSlug" value={slug} />
                        <div className="text-micro font-semibold uppercase tracking-wider text-crit">
                          Danger zone
                        </div>
                        <p className="flex-1 text-caption text-text-muted">
                          Move this epic to the bin. The {epic.tasks.length} task
                          {epic.tasks.length === 1 ? "" : "s"} under it (plus sub-tasks) go
                          with it. Auto-purged after 7 days.
                        </p>
                        <button
                          type="submit"
                          className="mt-auto w-full rounded-lg border border-crit bg-transparent px-control-x py-control-y text-caption font-medium text-crit hover:bg-crit hover:text-on-crit"
                        >
                          Delete epic
                        </button>
                      </form>
                    </div>

                    {/* Dates — moved to the bottom to mirror the Task form. */}
                    <div className="rounded-card border border-line bg-panel-soft p-card">
                      <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                        Dates
                      </div>
                      <dl className="mt-2 space-y-1 text-caption">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-text-muted">Created</dt>
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
                              <MessageAvatar actor={serializeActor(epic.reporter, actorVisibility)!} size="sm" />
                            ) : null}
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-text-muted">Updated</dt>
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
                            <dt className="text-text-muted">Approved</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={epic.approvedOn.toISOString()}
                                title={epic.approvedOn.toISOString()}
                                className="tabular-nums"
                              >
                                {timeAgo(epic.approvedOn)}
                              </time>
                              {epic.approvedBy ? <MessageAvatar actor={serializeActor(epic.approvedBy, actorVisibility)!} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                        {epic.status === "Done" && epic.statusChangedAt ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-text-muted">Done</dt>
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
                            <dt className="text-text-muted">Archived</dt>
                            <dd className="flex items-center gap-2">
                              <time
                                dateTime={epic.archivedAt.toISOString()}
                                title={epic.archivedAt.toISOString()}
                                className="tabular-nums"
                              >
                                {timeAgo(epic.archivedAt)}
                              </time>
                              {epic.archivedBy ? <MessageAvatar actor={serializeActor(epic.archivedBy, actorVisibility)!} size="sm" /> : null}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                  </aside>
                </div>
              </TabPanel>

              {viewer.isOwner ? <TabPanel name="Action Plan">
                <div className="space-y-3 pt-2">
                  {canApproveActionPlan ? (
                    <form action={approveEpicActionPlan} className="flex justify-end">
                      <input type="hidden" name="epicId" value={epic.id} />
                      <input type="hidden" name="projectSlug" value={slug} />
                      <button
                        type="submit"
                        className="rounded-lg bg-accent px-control-x py-control-y text-caption font-medium text-bg hover:opacity-90"
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
                    firstUnreadMessageId={firstUnreadMessageId}
                    currentUserId={currentUserId}
                    currentUsername={viewer.username}
                    pendingProposals={pendingProposals}
                  />
                </div>
              </TabPanel> : null}

              <TabPanel name="Tasks">
                <div>
          {/* Header mirrors the main Tasks tab: h2 heading + a count subtitle. */}
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-heading font-semibold tracking-tight">Tasks</h2>
              <p className="mt-1 text-body text-text-muted">
                {epic.tasks.length} task{epic.tasks.length === 1 ? "" : "s"} in implementation order.
              </p>
            </div>
            <Link
              href={`/projects/${slug}`}
              className="text-caption text-text-muted hover:text-accent"
            >
              Open board →
            </Link>
          </div>
          {epic.tasks.length === 0 ? (
            <>
              <p className="text-caption text-text-muted">
                {viewer.isOwner
                  ? "No tasks linked to this epic yet. Add one manually or ask AI to propose the first task breakdown."
                  : "No tasks linked to this epic yet."}
              </p>
              {viewer.isOwner ? (
                <EpicTasksAiPrompt
                  projectSlug={slug}
                  epicId={epic.id}
                  epicTitle={epic.title}
                  aiTargets={aiTargetOptions}
                  defaultAiTarget={defaultAiTarget}
                  isAiRunning={pendingAgents.length > 0}
                />
              ) : null}
            </>
          ) : (
            <EpicTasksClient
              initialTasks={epic.tasks.map((t) => ({
                id: t.id,
                workItemKey: t.workItemKey,
                title: t.title,
                status: t.status,
                alertReporter: t.alertReporter,
                href: `/projects/${slug}/tasks/${t.id}`,
                createdAt: t.createdAt.toISOString(),
                statusChangedAt: t.statusChangedAt?.toISOString() ?? null,
                approvedOn: t.approvedOn?.toISOString() ?? null,
                archivedAt: t.archivedAt?.toISOString() ?? null,
                reporter: viewer.isOwner ? serializeActor(t.reporter, actorVisibility) : null,
                assignee: viewer.isOwner ? serializeActor(t.assignee, actorVisibility) : null,
                reviewer: viewer.isOwner ? serializeActor(t.actingManager, actorVisibility) : null,
                createdBy: viewer.isOwner ? (taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter, actorVisibility)) : null,
                updatedBy: viewer.isOwner ? (taskActivityActors.updatedBy.get(t.id) ?? taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter, actorVisibility)) : null,
                assigneeName: viewer.isOwner ? (serializeActor(t.assignee, actorVisibility)?.username ?? null) : null,
                reviewerName: viewer.isOwner ? (serializeActor(t.actingManager, actorVisibility)?.username ?? null) : null,
                updatedAt: t.updatedAt.toISOString(),
                activeWorking:
                  (t.status === "In Progress" &&
                    Boolean(t.assignee?.agent?.slug && busyAgentSlugs.has(t.assignee.agent.slug))) ||
                  (t.status === "Review" &&
                    Boolean(t.actingManager?.agent?.slug && busyAgentSlugs.has(t.actingManager.agent.slug))),
              }))}
              projectSlug={slug}
              reorderEpicTasks={reorderEpicTasks}
              epicId={epic.id}
              showTaskRoles={viewer.isOwner}
              roleOptions={viewer.isOwner ? principalOptions : []}
            />
          )}

                </div>
              </TabPanel>

              <TabPanel name="Attachments">
                <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-body font-semibold tracking-wide text-text">
              Attachments
            </h2>
            <span className="text-caption text-text-muted">
              Max {formatBytes(attachmentMaxBytes())} per file
            </span>
          </div>
          <AttachmentList
          attachments={visibleAttachments}
            projectSlug={slug}
            deleteAction={deleteAttachment}
          />
                </div>
              </TabPanel>

              <TabPanel name="Comments">
                <div className="flex h-[calc(100dvh-14rem)] min-h-[560px] flex-col">
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                    {visibleEpicComments.length === 0 ? (
                      <p className="text-caption text-text-muted">
                        No comments yet.
                      </p>
                    ) : (
                      <ul className="space-y-3">
                        {visibleEpicComments.map((c) => {
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
                                    dangerouslySetInnerHTML={renderFullMarkdown(redactBody(c.body))}
                                  />
                                </DeletedMessageDivider>
                              </li>
                            );
                          }
                          const commentAuthor = serializeVisibleActorAs(
                            c.user,
                            c.user.id === resolvedReviewerId ? "reviewer" : "assignee",
                            actorVisibility,
                          )!;
                          const authorRole = syntheticRoleMeta(commentAuthor);
                          return (
                            <li
                              key={c.id}
                              className="flex items-start gap-3 text-body"
                            >
                              <MessageAvatar actor={commentAuthor} size="sm" />
                              <div className={`min-w-0 flex-1 rounded-card border border-line bg-panel-soft px-3 py-2 ${authorRole?.accentClass ?? ""}`}>
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <strong className="truncate font-medium text-text">
                                      {actorDisplayName(commentAuthor)}
                                    </strong>
                                    {authorRole ? (
                                      <span className={`rounded-full px-2 py-0.5 text-nano font-semibold uppercase tracking-wide ${authorRole.chipClass}`}>
                                        {authorRole.label}
                                      </span>
                                    ) : null}
                                    {c.isGenerated ? (
                                      <span className="rounded-full border border-line bg-bg-elev px-2 py-0.5 text-nano font-semibold uppercase tracking-wide text-text-muted">
                                        System
                                      </span>
                                    ) : null}
                                    {c.provider && c.model ? (
                                      <span className="rounded-full border border-line bg-bg-elev px-2 py-0.5 text-nano font-medium text-text-muted" title={`${c.provider}/${c.model}`}>
                                        {c.provider}/{c.model}
                                      </span>
                                    ) : null}
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
                                  dangerouslySetInnerHTML={renderFullMarkdown(redactBody(c.body))}
                                />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {visibleEpicComments.length > 0 ? (
                      <AutoScrollToLatest
                        whenTab="Comments"
                        watchKey={`${visibleEpicComments.length}:${visibleEpicComments.at(-1)?.id ?? ""}`}
                      />
                    ) : null}
                  </div>

                </div>
              </TabPanel>

              {viewer.isOwner ? <TabPanel name="Activities">
                <div className="pt-2">
                  <ActivityTimeline rows={visibleActivity} />
                </div>
              </TabPanel> : null}

              {viewer.isOwner && epicHasDeployment ? <TabPanel name={DEVELOPMENT_TAB}>
                <DeploymentTab
                  mode="epic"
                  title={epic.title}
                  deploymentStatus={epic.deploymentStatus}
                  branchName={epicChangeBranchName}
                  commitPrefix={epicCommitPrefix}
                  productionBranch={epic.project.deploymentProductionBranch}
                  rows={deploymentPullRequests}
                  canAct={(row) => canShowDeploymentAction({
                    provider: row.provider,
                    viewerKind: viewer.kind,
                    viewerId: viewer.id,
                    reporterId: epic.reporterId,
                    reviewerId: epic.actingManagerId,
                    onlyReportersCanApprovePullRequests: epic.project.onlyReportersCanApprovePullRequests,
                  })}
                  approveLocalChangesAction={approveDeploymentLocalChanges}
                  approveAndMergeAction={approveAndMergeDeploymentPullRequest}
                />
              </TabPanel> : null}

              {viewer.isOwner ? <TabPanel name="Changes">
                <TaskChangesPanel
                  changes={epicChanges}
                  branchName={epicChangeBranchName}
                  commitPrefix={epicCommitPrefix}
                  commitPrefixes={epicChangeCommitPrefixes}
                  scopeLabel="epic"
                  baseHref={`/projects/${slug}/epics/${epic.id}`}
                  selectedDiff={selectedDiff}
                  projectSlug={slug}
                  epicId={epic.id}
                  aiTargets={aiTargetOptions}
                  defaultAiTarget={defaultAiTarget}
                />
              </TabPanel> : null}
            </div>
          </TabsProvider>
        </section>
      </div>
    </div>
    </StickyViewportSurface>
  );
}
