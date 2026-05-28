import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { renderFullMarkdown } from "@/lib/markdown";
import {
  archiveDirectAgentChat,
  deleteDirectAgentArchive,
  deleteDirectAgentMessage,
  getConversationFolderIds,
  getAgentChatUploadDir,
} from "@/lib/agents/direct-chat-actions";
import { getPmChannelRunSnapshot } from "@/lib/agents/pm-channel-runs";
import ChatLayoutClient from "./chat-layout-client";
import ChatInput from "@/components/chat-input";
import ProposalReview from "./proposal-review";
import ChatMessagesContainer from "./chat-messages-container";
import ArchiveSidebarClient from "./archive-sidebar-client";
import NewChatButton from "@/components/new-chat-button";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function formatArchivePeriod(startedAt: Date, endedAt: Date) {
  const sameDay = startedAt.toDateString() === endedAt.toDateString();
  const date = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" }).format(startedAt);
  const start = new Intl.DateTimeFormat("en-AU", { timeStyle: "short" }).format(startedAt);
  const end = new Intl.DateTimeFormat("en-AU", sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(endedAt);
  return sameDay ? `${date}, ${start}-${end}` : `${date}, ${start} - ${end}`;
}

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}`;
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-0.5 pl-1" aria-hidden="true">
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-240ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-120ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current" />
    </span>
  );
}

const messageSenderSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
} as const;

function serializeSender(sender: {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
}) {
  return {
    id: sender.id,
    username: sender.username,
    kind: sender.kind,
    name: sender.name,
    avatarUpdatedAt: sender.avatarUpdatedAt?.toISOString() ?? null,
    agent: sender.agent,
  };
}

type ArchiveSummary = {
  id: string;
  summary: string;
  startedAt: Date;
  endedAt: Date;
  parentArchiveId: string | null;
  messageCount: number;
};

type ArchiveTreeNode = ArchiveSummary & { children: ArchiveTreeNode[] };

function buildArchiveTree(archives: ArchiveSummary[]) {
  const nodes = new Map<string, ArchiveTreeNode>();
  for (const archive of archives) {
    nodes.set(archive.id, { ...archive, children: [] });
  }
  const roots: ArchiveTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentArchiveId ? nodes.get(node.parentArchiveId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortTree = (items: ArchiveTreeNode[]) => {
    items.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    for (const item of items) sortTree(item.children);
  };
  sortTree(roots);
  return roots;
}

function ArchiveTree({
  nodes,
  slug,
  selectedArchiveId,
  depth = 0,
}: {
  nodes: ArchiveTreeNode[];
  slug: string;
  selectedArchiveId: string | null;
  depth?: number;
}) {
  return (
    <div className={`relative ${depth === 0 ? "space-y-3" : "ml-4 mt-2.5 space-y-3 border-l-2 border-[var(--color-accent)]/20 pl-4"}`}>
      {nodes.map((archive) => {
        const period = formatArchivePeriod(archive.startedAt, archive.endedAt);
        const selected = selectedArchiveId === archive.id;
        const hasChildren = archive.children.length > 0;
        
        return (
          <div key={archive.id} className="relative group/node">
            {/* Horizontal branch line connecting nested children */}
            {depth > 0 ? (
              <div 
                className="absolute -left-4 top-[1.35rem] h-px w-4 bg-[var(--color-accent)]/20" 
                aria-hidden="true" 
              />
            ) : null}

            {/* Tree node dot indicator */}
            <div 
              className={`absolute top-[1rem] z-10 h-3 w-3 rounded-full border-2 bg-[var(--color-panel)] transition-all ${
                depth > 0 ? "-left-[22px]" : "-left-1.5"
              } ${
                selected 
                  ? "border-[var(--color-accent)] scale-110 shadow-sm shadow-[var(--color-accent)]/20" 
                  : "border-[var(--color-line)] group-hover/node:border-[var(--color-accent)]/40"
              }`}
              aria-hidden="true"
            />

            <div
              className={`rounded-xl border p-3 transition-all duration-200 shadow-sm ${
                selected
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.04] shadow-[var(--color-accent)]/[0.02]"
                  : "border-[var(--color-line)] bg-[var(--color-panel-soft)] hover:border-[var(--color-accent)]/30 hover:bg-[var(--color-panel)]"
              }`}
            >
              <Link href={`/agents/${slug}/chat?archive=${archive.id}`} className="block">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[10px] font-semibold text-[var(--color-text-muted)] tracking-wider">
                    {period}
                  </span>
                  
                  {/* Relationship Badges */}
                  {archive.parentArchiveId ? (
                    <span className="inline-flex items-center gap-1 rounded bg-[var(--color-panel-soft)] border border-[var(--color-line)] px-1 py-0.5 text-[8px] font-medium text-[var(--color-text-muted)]">
                      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                      Continuation
                    </span>
                  ) : hasChildren ? (
                    <span className="inline-flex items-center gap-1 rounded bg-[var(--color-accent-soft)] border border-[var(--color-accent)]/20 px-1 py-0.5 text-[8px] font-medium text-[var(--color-accent)]">
                      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12 2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/></svg>
                      Root
                    </span>
                  ) : null}
                </div>

                <p className="mt-1.5 line-clamp-2 text-xs font-semibold text-[var(--color-text)] leading-relaxed">
                  {archive.summary}
                </p>

                <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--color-text-muted)] border-t border-[var(--color-line)]/40 pt-2">
                  <span>
                    {archive.messageCount} msg{archive.messageCount === 1 ? "" : "s"}
                  </span>
                  
                  {hasChildren && (
                    <span className="text-[9px] text-[var(--color-text-muted)] opacity-80 flex items-center gap-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                      {archive.children.length} child{archive.children.length === 1 ? "" : "ren"}
                    </span>
                  )}
                </div>
              </Link>
              
              <div className="mt-2.5 flex justify-end">
                <form action={deleteDirectAgentArchive}>
                  <input type="hidden" name="agentSlug" value={slug} />
                  <input type="hidden" name="archiveId" value={archive.id} />
                  <button
                    type="submit"
                    disabled={hasChildren}
                    aria-label={hasChildren ? "Cannot delete parent of a continuation" : "Delete archived chat"}
                    title={hasChildren ? "Cannot delete: this archive has active continuation children" : "Delete archived chat"}
                    className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition-all ${
                      hasChildren 
                        ? "bg-[var(--color-line)]/20 text-[var(--color-text-muted)]/40 border border-transparent cursor-not-allowed" 
                        : "border border-[var(--color-line)] text-[var(--color-text-muted)] hover:border-[var(--color-crit)] hover:bg-[var(--color-crit)]/[0.04] hover:text-[var(--color-crit)] cursor-pointer"
                    }`}
                  >
                    {hasChildren ? "Locked" : "Delete"}
                  </button>
                </form>
              </div>
            </div>
            
            {/* Recursive children tree */}
            {hasChildren ? (
              <ArchiveTree
                nodes={archive.children}
                slug={slug}
                selectedArchiveId={selectedArchiveId}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default async function DirectAgentChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ agent: string }>;
  searchParams: Promise<{ archive?: string }>;
}) {
  const { agent: slug } = await params;
  const { archive: selectedArchiveId = "" } = await searchParams;
  const session = await auth();
  const currentUserId = session?.user?.id ?? null;
  const agent = await db.agent.findUnique({
    where: { slug },
    include: { user: { select: { username: true, status: true } } },
  });
  if (!agent || agent.deactivatedAt || agent.user?.status !== "active") notFound();

  const [activeMessages, archives, binArchives, selectedArchive] = await Promise.all([
    db.directAgentChatMessage.findMany({
      where: { agentSlug: slug, archiveId: null },
      // Soft-deleted bubbles (HOMELAB-41 / item 2) stay in this list so
      // chat-messages-container can render the collapsed dotted divider.
      orderBy: { createdAt: "asc" },
      take: 120,
      include: {
        sender: { select: messageSenderSelect },
        deletedBy: { select: { username: true, name: true, kind: true } },
      },
    }),
    db.directAgentChatArchive.findMany({
      where: { agentSlug: slug, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        parentArchiveId: true,
        messageCount: true,
      },
    }),
    db.directAgentChatArchive.findMany({
      where: { agentSlug: slug, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      take: 50,
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        parentArchiveId: true,
        messageCount: true,
        deletedAt: true,
      },
    }),
    selectedArchiveId
      ? db.directAgentChatArchive.findFirst({
        where: { id: selectedArchiveId, agentSlug: slug },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
            include: { sender: { select: messageSenderSelect } },
          },
        },
      })
      : Promise.resolve(null),
  ]);
  const viewingArchive = Boolean(selectedArchive);
  const activeBaseArchiveId = activeMessages.find((m) => m.baseArchiveId)?.baseArchiveId ?? null;
  // The project the active conversation is attached to (carried forward),
  // the project list for the picker, and any pending work-item proposals
  // this agent submitted that are awaiting review.
  const attachedProjectId =
    [...activeMessages].reverse().find((m) => m.projectId)?.projectId ?? null;
  const [projects, pendingProposalsRaw] = await Promise.all([
    db.project.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.workItemProposal.findMany({
      where: { agentSlug: slug, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        summary: true,
        operations: true,
        validation: true,
        createdAt: true,
        agentSlug: true,
        grantMessageId: true,
        project: { select: { name: true } },
      },
    }),
  ]);

  const taskEpicGrantMessageIds = pendingProposalsRaw.map(p => p.grantMessageId).filter(Boolean) as string[];
  const taskEpicMessages = taskEpicGrantMessageIds.length > 0
    ? await db.agentChatMessage.findMany({
        where: { id: { in: taskEpicGrantMessageIds } },
        select: { id: true },
      })
    : [];
  const taskEpicMessageIdSet = new Set(taskEpicMessages.map(m => m.id));

  const pendingProposals = pendingProposalsRaw
    .filter((p) => !p.grantMessageId || !taskEpicMessageIdSet.has(p.grantMessageId))
    .slice(0, 10);
  const activeBaseArchive = activeBaseArchiveId
    ? archives.find((archive) => archive.id === activeBaseArchiveId)
      ?? await db.directAgentChatArchive.findFirst({
        where: { id: activeBaseArchiveId, agentSlug: slug, deletedAt: null },
        select: {
          id: true,
          summary: true,
          startedAt: true,
          endedAt: true,
          parentArchiveId: true,
          messageCount: true,
        },
      })
    : null;
  const messages = selectedArchive?.messages ?? activeMessages;
  const latest = messages.at(-1) ?? null;
  const agentIsProcessing = !viewingArchive && Boolean(latest && latest.sender.kind !== "agent");
  const directRun = agentIsProcessing && latest
    ? await getPmChannelRunSnapshot({
        kind: "direct",
        agentSlug: slug,
        messageId: latest.id,
      })
    : null;
  const showAgentProcessing = agentIsProcessing
    && (!directRun || directRun.status !== "complete");
  const avatarSrc = agent.avatar ? avatarUrl(agent.name) : null;
  const activeChildAlreadyOpen = viewingArchive
    && selectedArchive
    && activeBaseArchiveId === selectedArchive.id
    && activeMessages.length > 0;
  const canStartChildFromArchive = viewingArchive && selectedArchive && activeMessages.length === 0;

  // Load parent archives and messages for prepending in the chat view
  const parentArchivesProp: Array<{
    id: string;
    summary: string;
    messages: Array<{
      id: string;
      body: string;
      createdAt: string;
      sender: ReturnType<typeof serializeSender>;
    }>;
  }> = [];

  if (viewingArchive && selectedArchive) {
    const parentArchiveIds = await getConversationFolderIds(slug, selectedArchive.parentArchiveId);
    for (const id of parentArchiveIds) {
      const arc = await db.directAgentChatArchive.findFirst({
        where: { id, agentSlug: slug, deletedAt: null },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
            include: { sender: { select: messageSenderSelect } },
          },
        },
      });
      if (arc) {
        parentArchivesProp.push({
          id: arc.id,
          summary: arc.summary,
          messages: arc.messages.map(m => ({
            id: m.id,
            body: m.body,
            createdAt: m.createdAt.toISOString(),
            sender: serializeSender(m.sender),
          }))
        });
      }
    }
  }

  // Load Context Files from Samba drive chats folders
  const baseArchiveIdForFiles = selectedArchive
    ? selectedArchive.parentArchiveId
    : activeBaseArchiveId;
  const parentFolders = await getConversationFolderIds(slug, baseArchiveIdForFiles);
  const activeAnchor = activeMessages[0];
  const currentFolderId = selectedArchive
    ? selectedArchive.id
    : (activeAnchor?.id ?? null);
  const folderIds = currentFolderId ? [currentFolderId, ...parentFolders] : parentFolders;

  const contextFiles: Array<{ name: string; folderId: string; size: number }> = [];
  for (const folderId of folderIds) {
    const dir = await getAgentChatUploadDir(slug, folderId);
    if (existsSync(dir)) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const stats = await stat(path.join(dir, entry.name));
            contextFiles.push({
              name: entry.name,
              folderId,
              size: stats.size,
            });
          }
        }
      } catch (e) {
        console.error(`Failed to read files in directory ${dir}`, e);
      }
    }
  }

  const allArchives = [...archives, ...binArchives];

  // Fetch character sizes of all archives to estimate memory sizes
  const archivedMessages = await db.directAgentChatMessage.findMany({
    where: {
      agentSlug: slug,
      archiveId: { in: allArchives.map((a) => a.id) },
    },
    select: {
      archiveId: true,
      body: true,
    },
  });

  const archiveTextSizes = new Map<string, number>();
  for (const msg of archivedMessages) {
    if (msg.archiveId) {
      const current = archiveTextSizes.get(msg.archiveId) ?? 0;
      archiveTextSizes.set(msg.archiveId, current + Buffer.byteLength(msg.body, "utf8"));
    }
  }

  // Fetch attachment counts and sizes from Samba folders for all archives
  const allArchivesWithMeta = await Promise.all(
    allArchives.map(async (arc) => {
      const uploadDir = await getAgentChatUploadDir(slug, arc.id);
      let fileCount = 0;
      let attachmentsSize = 0;
      if (existsSync(uploadDir)) {
        try {
          const files = await readdir(uploadDir, { withFileTypes: true });
          for (const f of files) {
            if (f.isFile()) {
              const fileStats = await stat(path.join(uploadDir, f.name));
              fileCount++;
              attachmentsSize += fileStats.size;
            }
          }
        } catch {}
      }
      const textSize = archiveTextSizes.get(arc.id) ?? 0;
      return {
        ...arc,
        fileCount,
        attachmentsSize,
        textSize,
      };
    })
  );

  const metaMap = new Map<string, typeof allArchivesWithMeta[0]>();
  for (const arc of allArchivesWithMeta) {
    metaMap.set(arc.id, arc);
  }

  // Helper to build cumulative metrics for a list of archives
  const buildFinalArchives = (list: any[]) => {
    return list.map((item: any) => {
      const arc = metaMap.get(item.id)!;
      let current: typeof arc | undefined = arc;
      let cumulativeMessageCount = 0;
      let cumulativeTextSize = 0;
      let cumulativeAttachmentsSize = 0;
      let hasAttachments = false;
      const seen = new Set<string>();

      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        cumulativeMessageCount += current.messageCount;
        cumulativeTextSize += current.textSize;
        cumulativeAttachmentsSize += current.attachmentsSize;
        if (current.fileCount > 0) {
          hasAttachments = true;
        }
        current = current.parentArchiveId ? metaMap.get(current.parentArchiveId) : undefined;
      }

      const totalMemorySizeBytes = cumulativeTextSize + cumulativeAttachmentsSize;
      const totalMemorySizeKB = Number((totalMemorySizeBytes / 1024).toFixed(1));

      return {
        id: item.id,
        summary: item.summary,
        startedAt: item.startedAt.toISOString(),
        endedAt: item.endedAt.toISOString(),
        parentArchiveId: item.parentArchiveId,
        messageCount: cumulativeMessageCount,
        hasAttachments,
        totalSizeKB: totalMemorySizeKB,
        deletedAt: 'deletedAt' in item && item.deletedAt ? (item.deletedAt as Date).toISOString() : null,
      };
    });
  };

  const finalArchives = buildFinalArchives(archives);
  const finalBinArchives = buildFinalArchives(binArchives);

  return (
    <div className="mx-auto flex h-[calc(100vh-2.5rem)] max-w-7xl flex-col gap-4 overflow-hidden">
      {/* Sticky Header Banner */}
      <header className="sticky top-[-1.25rem] z-10 -mx-6 bg-[var(--color-bg)] pt-[1.25rem] pb-3 px-6 lg:-mx-8 lg:px-8 border-b border-[var(--color-line)] flex items-center justify-between gap-4 shrink-0">
        <Link href={`/agents/${slug}`} className="flex items-center gap-3 hover:opacity-80 transition shrink-min min-w-0">
          <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-sm font-semibold">
            {avatarSrc ? (
              <img src={avatarSrc} alt={`${agent.name} avatar`} decoding="async" className="h-full w-full object-cover" />
            ) : (
              agent.name.slice(0, 1)
            )}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">
              {agent.name}
            </h1>
            <p className="font-mono text-[10px] text-[var(--color-text-muted)]">@{slug} · {agent.role}</p>
          </div>
        </Link>
        
        <div className="shrink-0">
          {viewingArchive ? (
            <Link
              href={`/agents/${slug}/chat`}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Current chat
            </Link>
          ) : (
            <NewChatButton
              agentSlug={slug}
              hasActiveHistory={activeMessages.length > 0}
            />
          )}
        </div>
      </header>

      <ChatLayoutClient
        chatSection={
          <section className="flex min-h-0 h-full flex-col rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-sm">
            <div className="border-b border-[var(--color-line)] px-4 py-3 shrink-0">
              <p className="text-sm font-medium">{viewingArchive ? "Archived chat" : "Current chat"}</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {viewingArchive && selectedArchive
                  ? `${formatArchivePeriod(selectedArchive.startedAt, selectedArchive.endedAt)} · ${selectedArchive.messageCount} messages`
                  : activeBaseArchive
                    ? `Continuation of "${activeBaseArchive.summary}" · ${activeMessages.length} active message${activeMessages.length === 1 ? "" : "s"}`
                    : `${activeMessages.length} active message${activeMessages.length === 1 ? "" : "s"}`}
              </p>
            </div>
            
            <ChatMessagesContainer
              messages={messages.map((m: any) => ({
                id: m.id,
                body: m.body,
                createdAt: m.createdAt.toISOString(),
                sender: serializeSender(m.sender),
              }))}
              parentArchives={parentArchivesProp}
              showAgentProcessing={showAgentProcessing}
              agentSlug={slug}
              agentUsername={agent.user.username}
              viewingArchive={viewingArchive}
              slug={slug}
              currentUserId={currentUserId}
            />

            {/* Attached Context Files List */}
            {contextFiles.length > 0 && (
              <div className="border-t border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-2 flex flex-wrap gap-2 items-center shrink-0">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] select-none">
                  Context Files ({contextFiles.length}):
                </span>
                {contextFiles.map((file) => (
                  <div
                    key={`${file.folderId}-${file.name}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-0.5 text-xs font-semibold text-[var(--color-text)] shadow-sm"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
                    <span className="truncate max-w-[150px]" title={file.name}>
                      {file.name}
                    </span>
                    <span className="text-[9px] text-[var(--color-text-muted)] font-normal">
                      ({(file.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                ))}
              </div>
            )}

            <ProposalReview
              agentSlug={slug}
              proposals={pendingProposals.map((p) => ({
                id: p.id,
                summary: p.summary,
                operations: p.operations,
                validation: p.validation,
                createdAt: p.createdAt.toISOString(),
                projectName: p.project.name,
                agentSlug: p.agentSlug,
              }))}
            />

            {viewingArchive && !canStartChildFromArchive ? (
              <div className="border-t border-[var(--color-line)] p-4 text-sm text-[var(--color-text-muted)] shrink-0 bg-[var(--color-panel)]">
                {activeChildAlreadyOpen
                  ? "A child continuation from this archive is already active."
                  : "Archive the current active chat before starting a child continuation from this archive."}{" "}
                <Link href={`/agents/${slug}/chat`} className="font-medium text-[var(--color-accent)] hover:underline">
                  Open current chat
                </Link>
              </div>
            ) : (
              <ChatInput
                agentSlug={slug}
                agentUsername={agent.user.username}
                viewingArchive={viewingArchive}
                selectedArchiveId={selectedArchive?.id}
                activeBaseArchiveId={activeBaseArchiveId}
                projects={projects}
                attachedProjectId={attachedProjectId}
              />
            )}
          </section>
        }
        asideSection={
          <ArchiveSidebarClient
            archives={finalArchives}
            binArchives={finalBinArchives}
            slug={slug}
            selectedArchiveId={selectedArchive?.id ?? null}
          />
        }
      />
    </div>
  );
}
