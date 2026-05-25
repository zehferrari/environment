import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  updateEpic,
  createTaskInEpic,
  createEpicComment,
  deleteEpicComment,
} from "@/lib/epics/actions";
import { auth } from "@/lib/auth";
import {
  uploadAttachment,
  deleteAttachment,
} from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { deleteEpic } from "@/lib/bin/actions";
import { reorderTasks } from "@/lib/tasks/reorder";
import SortableTaskList from "@/components/sortable-task-list";
import { renderFullMarkdown, extractMentions } from "@/lib/markdown";
import { listAssignablePrincipals } from "@/lib/principals";
import ChatRoom from "@/components/chat-room";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
} from "@/components/message-avatar";
import DescriptionField from "@/components/description-field";
import { TabsProvider, TabsNav, TabPanel } from "@/components/task-tabs";

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
  searchParams: Promise<{ chat?: string }>;
}) {
  const [{ slug, epicId }, { chat = "" }] = await Promise.all([
    params,
    searchParams,
  ]);

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    include: {
      project: { select: { id: true, slug: true, name: true } },
      actingManager: {
        select: {
          username: true,
          kind: true,
          status: true,
          agent: { select: { slug: true, deactivatedAt: true, name: true } },
        },
      },
      tasks: {
        where: { deletedAt: null },
        orderBy: [{ status: "asc" }, { rank: "asc" }],
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
          assignee: { select: { username: true } },
        },
      },
      attachments: {
        orderBy: { createdAt: "desc" },
        include: { uploader: { select: { username: true } } },
      },
      comments: {
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
        },
      },
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) notFound();

  // Comment delete is a human-only control (mirrors the task editor).
  const session = await auth();
  const canDeleteComments = session?.user?.kind !== "agent";
  const principals = await listAssignablePrincipals();
  const selectedAgentSlug = chat || epic.actingManager?.agent?.slug || null;

  const chatMessages = await db.agentChatMessage.findMany({
    where: {
      epicId: epic.id,
      agentSlug: "room",
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
    },
  });

  const latestMessage = chatMessages.at(-1) ?? null;
  const pendingAgents: Array<{ slug: string; username: string }> = [];

  if (latestMessage && latestMessage.sender.kind !== "agent") {
    const users = await db.user.findMany({
      select: {
        id: true,
        username: true,
        kind: true,
        status: true,
        agent: { select: { slug: true, deactivatedAt: true, name: true } },
      },
    });
    const mentions = extractMentions(
      latestMessage.body,
      users.map((u) => ({ username: u.username })),
    );

    const targetAgents = new Map<string, { slug: string; username: string }>();
    if (mentions.length > 0) {
      for (const u of users) {
        if (
          mentions.includes(u.username) &&
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
      }
    } else {
      const candidates = [
        epic.actingManager,
      ];
      for (const cand of candidates) {
        if (
          cand &&
          cand.kind === "agent" &&
          cand.status === "active" &&
          cand.agent &&
          !cand.agent.deactivatedAt
        ) {
          targetAgents.set(cand.agent.slug, {
            slug: cand.agent.slug,
            username: cand.agent.name || cand.username,
          });
        }
      }
    }
    pendingAgents.push(...targetAgents.values());
  }

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
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* ----- Main -------------------------------------------------- */}
      <div className="min-w-0">
        <section className="space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          {/* Sticky header bar — single Save (top-right), tab-independent. */}
          <div className="sticky top-0 z-10 -mx-5 -mt-5 flex items-center justify-between gap-3 rounded-t-2xl border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-3">
            <span className="text-xs text-[var(--color-text-muted)]">
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
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              Save changes
            </button>
          </div>
          {/* One edit form for the whole card: controls carry form="epicMain"
              so the single Save persists status, title, description and
              acting manager together. Empty form so the panels' own forms
              (add-task / upload / comment) are never nested inside it. */}
          <form id="epicMain" action={updateEpic} />
          <input form="epicMain" type="hidden" name="epicId" value={epic.id} />
          <input form="epicMain" type="hidden" name="projectSlug" value={slug} />

          {/* Title + Status on the same row */}
          <div className="flex items-end gap-3">
            <input
              form="epicMain"
              name="title"
              defaultValue={epic.title}
              required
              maxLength={200}
              className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight outline-none transition focus:border-[var(--color-line)] focus:bg-[var(--color-bg)]"
              aria-label="Epic title"
            />
            <label className="w-28 shrink-0">
              <span className="mb-1 block text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Status
              </span>
              <select
                form="epicMain"
                name="status"
                defaultValue={epic.status}
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                aria-label="Status"
              >
                <option value="open">open</option>
                <option value="done">done</option>
                <option value="archived">archived</option>
              </select>
            </label>
          </div>

          {/* Tabbed content */}
          <TabsProvider defaultTab="Description">
            <TabsNav
              tabs={["Description", "Tasks", "Attachments", "Comments", "Chat"]}
            />
            <div className="pt-4">
              <TabPanel name="Description">
                <DescriptionField
                  formId="epicMain"
                  previewHtml={renderFullMarkdown(epic.description ?? "").__html}
                  defaultValue={epic.description ?? ""}
                  rows={12}
                />
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
            <p className="text-xs text-[var(--color-text-muted)]">
              No tasks linked to this epic yet. Add one below.
            </p>
          ) : (
            <div className="space-y-3">
              {TASK_STATUS_ORDER.map((s) => {
                const list = tasksByStatus.get(s) ?? [];
                if (list.length === 0) return null;
                return (
                  <div key={s}>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      {s} ({list.length})
                    </div>
                    <SortableTaskList
                      ariaLabel={`Tasks in ${s}`}
                      reorderAction={reorderEpicTasks}
                      showAssignee
                      showUpdated
                      items={list.map((t) => ({
                        id: t.id,
                        title: t.title,
                        href: `/projects/${slug}/tasks/${t.id}`,
                        assigneeName: t.assignee?.username ?? null,
                        updatedAt: t.updatedAt.toISOString(),
                      }))}
                    />
                  </div>
                );
              })}
            </div>
          )}

          <form action={createTaskInEpic} className="mt-4 flex gap-2">
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="epicId" value={epic.id} />
            <input
              name="title"
              required
              maxLength={200}
              placeholder="New task title"
              className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              Add
            </button>
          </form>
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
          {epic.attachments.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No attachments yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {epic.attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/api/attachments/${a.id}`}
                      className="truncate font-medium hover:underline"
                    >
                      {a.filename}
                    </a>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {formatBytes(a.sizeBytes)} · {a.mimeType} · uploaded by{" "}
                      @{a.uploader.username} ·{" "}
                      <time
                        dateTime={a.createdAt.toISOString()}
                        title={a.createdAt.toISOString()}
                      >
                        {timeAgo(a.createdAt)}
                      </time>
                    </div>
                  </div>
                  <form action={deleteAttachment}>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="attachmentId" value={a.id} />
                    <button
                      type="submit"
                      className="rounded border border-transparent px-2 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-line)] hover:text-[var(--color-crit)]"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <form
            action={uploadAttachment}
            encType="multipart/form-data"
            className="mt-4 flex flex-wrap items-center gap-2"
          >
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="epicId" value={epic.id} />
            <input
              type="file"
              name="file"
              required
              className="text-xs file:mr-2 file:rounded file:border-0 file:bg-[var(--color-accent)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--color-bg)] hover:file:opacity-90"
            />
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-accent)]"
            >
              Upload
            </button>
          </form>
                </div>
              </TabPanel>

              <TabPanel name="Comments">
                <div>
                  {epic.comments.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-muted)]">
                      No comments yet.
                    </p>
                  ) : (
                    <ul className="space-y-3">
                      {epic.comments.map((c) => (
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
                                <form action={deleteEpicComment}>
                                  <input
                                    type="hidden"
                                    name="commentId"
                                    value={c.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="epicId"
                                    value={epic.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="projectSlug"
                                    value={slug}
                                  />
                                  <button
                                    type="submit"
                                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
                                    title="Delete comment"
                                    aria-label="Delete comment"
                                  >
                                    Delete
                                  </button>
                                </form>
                              ) : null}
                            </div>
                            <div
                              className="md"
                              dangerouslySetInnerHTML={renderFullMarkdown(c.body)}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <form
                    action={createEpicComment}
                    className="mt-4 space-y-2"
                  >
                    <input type="hidden" name="epicId" value={epic.id} />
                    <input type="hidden" name="projectSlug" value={slug} />
                    <textarea
                      name="body"
                      required
                      rows={3}
                      placeholder="Write a comment — **markdown** supported"
                      className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
                      >
                        Add comment
                      </button>
                    </div>
                  </form>
                </div>
              </TabPanel>

              <TabPanel name="Chat">
                <div className="pt-2">
                  <ChatRoom
                    projectSlug={slug}
                    epicId={epic.id}
                    messages={chatMessages}
                    pendingAgents={pendingAgents}
                    latestMessageId={latestMessage?.id ?? null}
                    currentUserId={session?.user?.id ?? null}
                  />
                </div>
              </TabPanel>
            </div>
          </TabsProvider>
        </section>
      </div>

      {/* ----- Sidebar (right) --------------------------------------- */}
      <aside className="space-y-4">
        {/* Dates */}
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Dates
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Created</dt>
              <dd>
                <time
                  dateTime={epic.createdAt.toISOString()}
                  title={epic.createdAt.toISOString()}
                  className="tabular-nums"
                >
                  {timeAgo(epic.createdAt)}
                </time>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Updated</dt>
              <dd>
                <time
                  dateTime={epic.updatedAt.toISOString()}
                  title={epic.updatedAt.toISOString()}
                  className="tabular-nums"
                >
                  {timeAgo(epic.updatedAt)}
                </time>
              </dd>
            </div>
          </dl>
        </div>

        {/* Acting manager — epics have no assignee, only an acting manager.
            Persisted by the card's single Save (form="epicMain"). */}
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Acting manager
            </span>
            <select
              form="epicMain"
              name="actingManagerId"
              defaultValue={epic.actingManagerId ?? ""}
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
              aria-label="Acting manager"
            >
              <option value="">No acting manager</option>
              {principals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Danger zone — soft delete moves the Epic and all its non-deleted
            tasks (plus sub-tasks) to the bin. Its own form. Auto-purged after
            7 days. */}
        <form
          action={deleteEpic}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
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
  );
}
