import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { renderFullMarkdown } from "@/lib/markdown";
import {
  archiveDirectAgentChat,
  deleteDirectAgentArchive,
  deleteDirectAgentMessage,
  sendDirectAgentMessage,
} from "@/lib/agents/direct-chat-actions";
import ChatRefresh from "./chat-refresh";
import StreamingAgentReply from "@/components/streaming-agent-reply";

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

type DirectStatus = {
  pending: boolean;
};

type DirectActivityRow = {
  kind: string;
  payload: string | null;
};

function payloadFor(row: DirectActivityRow) {
  if (!row.payload) return null;
  try {
    return JSON.parse(row.payload) as {
      messageId?: unknown;
      inReplyToMessageId?: unknown;
      error?: unknown;
    };
  } catch {
    return null;
  }
}

function directStatusFor(messageId: string, rows: DirectActivityRow[]): DirectStatus {
  for (const row of rows) {
    const payload = payloadFor(row);
    if (payload?.messageId !== messageId && payload?.inReplyToMessageId !== messageId) continue;
    if (row.kind === "agent.direct_chat.wake_failed") {
      return { pending: false };
    }
    if (row.kind === "agent.direct_chat.wake") {
      return { pending: true };
    }
  }
  return { pending: true };
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
    <div className={depth === 0 ? "space-y-2" : "ml-3 mt-2 space-y-2 border-l border-[var(--color-line)] pl-3"}>
      {nodes.map((archive) => {
        const period = formatArchivePeriod(archive.startedAt, archive.endedAt);
        const selected = selectedArchiveId === archive.id;
        return (
          <div key={archive.id} className="relative">
            {depth > 0 ? (
              <span className="absolute -left-3 top-5 h-px w-3 bg-[var(--color-line)]" aria-hidden="true" />
            ) : null}
            <div
              className={`rounded-lg border p-2 ${
                selected
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-line)] bg-[var(--color-panel-soft)]"
              }`}
              title={`${period} - ${archive.summary}`}
            >
              <Link href={`/agents/${slug}/chat?archive=${archive.id}`} className="block">
                <p className="text-xs font-medium text-[var(--color-text-muted)]">{period}</p>
                <p className="mt-1 line-clamp-2 text-sm font-medium">{archive.summary}</p>
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  {archive.parentArchiveId ? "Child continuation / " : ""}
                  {archive.messageCount} message{archive.messageCount === 1 ? "" : "s"}
                  {archive.children.length > 0
                    ? ` / ${archive.children.length} child${archive.children.length === 1 ? "" : "ren"}`
                    : ""}
                </p>
              </Link>
              <form action={deleteDirectAgentArchive} className="mt-2 flex justify-end">
                <input type="hidden" name="agentSlug" value={slug} />
                <input type="hidden" name="archiveId" value={archive.id} />
                <button
                  type="submit"
                  aria-label="Remove archived chat"
                  title="Remove archived chat"
                  className="rounded-md border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-crit)] hover:text-[var(--color-crit)]"
                >
                  Delete
                </button>
              </form>
            </div>
            {archive.children.length > 0 ? (
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
  const agent = await db.agent.findUnique({
    where: { slug },
    include: { user: { select: { username: true, status: true } } },
  });
  if (!agent || agent.deactivatedAt || agent.user?.status !== "active") notFound();

  const [activeMessages, archives, selectedArchive] = await Promise.all([
    db.directAgentChatMessage.findMany({
      where: { agentSlug: slug, archiveId: null },
      orderBy: { createdAt: "asc" },
      take: 120,
      include: { sender: { select: { username: true, kind: true } } },
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
    selectedArchiveId
      ? db.directAgentChatArchive.findFirst({
        where: { id: selectedArchiveId, agentSlug: slug, deletedAt: null },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
            include: { sender: { select: { username: true, kind: true } } },
          },
        },
      })
      : Promise.resolve(null),
  ]);
  const viewingArchive = Boolean(selectedArchive);
  const archiveTree = buildArchiveTree(archives);
  const activeBaseArchiveId = activeMessages.find((m) => m.baseArchiveId)?.baseArchiveId ?? null;
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
  const directActivity = agentIsProcessing && latest
    ? await db.activityLog.findMany({
        where: {
          targetAgent: slug,
          kind: {
            in: [
              "agent.direct_chat.wake",
              "agent.direct_chat.wake_failed",
              "agent.direct_chat.reply",
            ],
          },
          createdAt: { gte: latest.createdAt },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { kind: true, payload: true },
      })
    : [];
  const agentStatus = agentIsProcessing && latest
    ? directStatusFor(latest.id, directActivity)
    : null;
  const showAgentProcessing = agentStatus?.pending ?? agentIsProcessing;
  const avatarSrc = agent.avatar ? avatarUrl(agent.name) : null;
  const activeChildAlreadyOpen = viewingArchive
    && selectedArchive
    && activeBaseArchiveId === selectedArchive.id
    && activeMessages.length > 0;
  const canStartChildFromArchive = viewingArchive && selectedArchive && activeMessages.length === 0;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-7xl flex-col gap-4">
      <ChatRefresh active={showAgentProcessing} />
      <nav className="flex items-center justify-between gap-3 text-sm">
        <Link
          href="/agents"
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
        >
          ← Agents
        </Link>
        <Link
          href={`/agents/${slug}`}
          className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Profile
        </Link>
      </nav>

      <header className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-2xl font-semibold">
            {avatarSrc ? (
              <img src={avatarSrc} alt={`${agent.name} avatar`} decoding="async" className="h-full w-full object-cover" />
            ) : (
              agent.name.slice(0, 1)
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-[var(--color-text-muted)]">@{slug}</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{agent.name}</h1>
              {showAgentProcessing ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]">
                  typing<TypingDots />
                </span>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">
                {agent.role}
              </span>
              <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">
                {agent.user.username}
              </span>
            </div>
          </div>
          {viewingArchive ? (
            <Link
              href={`/agents/${slug}/chat`}
              className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Current chat
            </Link>
          ) : (
            <form action={archiveDirectAgentChat}>
              <input type="hidden" name="agentSlug" value={slug} />
              <button
                type="submit"
                disabled={activeMessages.length === 0}
                className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Archive + New Chat
              </button>
            </form>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-sm">
          <div className="border-b border-[var(--color-line)] px-4 py-3">
            <p className="text-sm font-medium">{viewingArchive ? "Archived chat" : "Current chat"}</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {viewingArchive && selectedArchive
                ? `${formatArchivePeriod(selectedArchive.startedAt, selectedArchive.endedAt)} · ${selectedArchive.messageCount} messages`
                : activeBaseArchive
                  ? `Continuation of "${activeBaseArchive.summary}" · ${activeMessages.length} active message${activeMessages.length === 1 ? "" : "s"}`
                  : `${activeMessages.length} active message${activeMessages.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="min-h-[420px] flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">No messages yet.</p>
            ) : (
              messages.map((m) => {
                const fromAgent = m.sender.kind === "agent";
                return (
                  <div
                    key={m.id}
                    className={`group max-w-3xl rounded-xl border px-3 py-2 ${
                      fromAgent
                        ? "ml-auto border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10"
                        : "border-[var(--color-line)] bg-[var(--color-panel-soft)]"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      <span>
                        {m.sender.username}
                        {fromAgent ? " · agent" : ""}
                      </span>
                      <div className="flex items-center gap-2">
                        <time dateTime={m.createdAt.toISOString()} title={m.createdAt.toISOString()}>
                          {timeAgo(m.createdAt)}
                        </time>
                        {!viewingArchive ? (
                          <form action={deleteDirectAgentMessage}>
                            <input type="hidden" name="agentSlug" value={slug} />
                            <input type="hidden" name="messageId" value={m.id} />
                            <button
                              type="submit"
                              aria-label="Delete message"
                              title="Delete message"
                              className="text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--color-crit)]"
                            >
                              ×
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                    <div className="md md-compact" dangerouslySetInnerHTML={renderFullMarkdown(m.body)} />
                  </div>
                );
              })
            )}
            {showAgentProcessing ? (
              latest ? (
                <StreamingAgentReply
                  targetKind="direct"
                  agentSlug={slug}
                  messageId={latest.id}
                  label={agent.user.username}
                />
              ) : null
            ) : null}
          </div>

          {viewingArchive && !canStartChildFromArchive ? (
            <div className="border-t border-[var(--color-line)] p-4 text-sm text-[var(--color-text-muted)]">
              {activeChildAlreadyOpen
                ? "A child continuation from this archive is already active."
                : "Archive the current active chat before starting a child continuation from this archive."}{" "}
              <Link href={`/agents/${slug}/chat`} className="font-medium text-[var(--color-accent)] hover:underline">
                Open current chat
              </Link>
            </div>
          ) : (
            <form action={sendDirectAgentMessage} className="border-t border-[var(--color-line)] p-4">
              <input type="hidden" name="agentSlug" value={slug} />
              {selectedArchive ? (
                <>
                  <input type="hidden" name="baseArchiveId" value={selectedArchive.id} />
                  <input type="hidden" name="continueFromArchive" value="1" />
                </>
              ) : activeBaseArchiveId ? (
                <input type="hidden" name="baseArchiveId" value={activeBaseArchiveId} />
              ) : null}
              <textarea
                name="body"
                required
                rows={4}
                maxLength={8000}
                placeholder={viewingArchive ? `Start a child chat from this archive with @${agent.user.username}...` : `Message @${agent.user.username}...`}
                className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="submit"
                  className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  {viewingArchive ? "Start Child Chat" : "Send"}
                </button>
              </div>
            </form>
          )}
        </section>

        <aside className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">Archived chats</p>
              <p className="text-xs text-[var(--color-text-muted)]">Latest conversations</p>
            </div>
            <Link
              href={`/agents/${slug}/chat`}
              className={`rounded-md border px-2 py-1 text-xs ${
                viewingArchive
                  ? "border-[var(--color-line)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  : "border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
              }`}
            >
              Active
            </Link>
          </div>
          {archives.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">No archived chats yet.</p>
          ) : (
            <ArchiveTree
              nodes={archiveTree}
              slug={slug}
              selectedArchiveId={selectedArchive?.id ?? null}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
