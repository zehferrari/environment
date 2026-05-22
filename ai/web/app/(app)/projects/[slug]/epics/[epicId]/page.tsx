import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  renameEpic,
  setEpicAssignee,
  setEpicActingManager,
  setEpicStatus,
} from "@/lib/epics/actions";
import {
  uploadAttachment,
  deleteAttachment,
} from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { deleteEpic } from "@/lib/bin/actions";
import AgentChatSidebar from "@/components/agent-chat";
import { renderFullMarkdown } from "@/lib/markdown";
import {
  listAssignablePrincipals,
  type AssignablePrincipal,
} from "@/lib/principals";

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
  const { slug, epicId } = await params;
  const { chat } = await searchParams;
  const chatAgentSlug = typeof chat === "string" && chat !== "" ? chat : null;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    include: {
      project: { select: { id: true, slug: true, name: true } },
      assignee: { select: { username: true } },
      actingManager: { select: { username: true } },
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
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) notFound();

  const principals = await listAssignablePrincipals();

  const tasksByStatus = new Map<string, typeof epic.tasks>();
  for (const s of TASK_STATUS_ORDER) tasksByStatus.set(s, []);
  for (const t of epic.tasks) {
    const list = tasksByStatus.get(t.status) ?? [];
    list.push(t);
    tasksByStatus.set(t.status, list);
  }

  return (
    <div className="mx-auto grid max-w-[1600px] grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[320px_minmax(0,1fr)_320px]">
      {/* ----- Chat sidebar (left) ----------------------------------- */}
      <aside className="order-3 xl:order-1">
        <AgentChatSidebar
          projectSlug={slug}
          epicId={epic.id}
          selectedAgentSlug={chatAgentSlug}
          parentPath={`/projects/${slug}/epics/${epic.id}`}
        />
      </aside>

      {/* ----- Main -------------------------------------------------- */}
      <div className="order-1 min-w-0 space-y-6 xl:order-2">
        <nav className="text-sm">
          <Link
            href={`/projects/${slug}/epics`}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
          >
            ← Epics
          </Link>
        </nav>

        <form
          action={renameEpic}
          className="space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm"
        >
          <input type="hidden" name="epicId" value={epic.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <input
            name="title"
            defaultValue={epic.title}
            required
            maxLength={200}
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight outline-none transition focus:border-[var(--color-line)] focus:bg-[var(--color-bg)]"
            aria-label="Epic title"
          />
          {epic.description ? (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Preview
              </div>
              <div
                className="md"
                dangerouslySetInnerHTML={renderFullMarkdown(epic.description)}
              />
            </div>
          ) : null}
          <textarea
            name="description"
            defaultValue={epic.description ?? ""}
            rows={12}
            placeholder="Description — markdown supported (headings, lists, code fences, tables)"
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>
              Last updated{" "}
              <time
                dateTime={epic.updatedAt.toISOString()}
                title={epic.updatedAt.toISOString()}
              >
                {timeAgo(epic.updatedAt)}
              </time>
            </span>
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              Save changes
            </button>
          </div>
        </form>

        {/* Tasks under this epic — grouped by status. Tasks keep their
            own status independent of the epic's status (HOMELAB-47). */}
        <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
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
              No tasks linked to this epic yet. Link an existing task from its
              detail page, or create a new task on the board.
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
                    <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)]">
                      {list.map((t) => (
                        <li
                          key={t.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                        >
                          <Link
                            href={`/projects/${slug}/tasks/${t.id}`}
                            className="truncate hover:underline"
                          >
                            {t.title}
                          </Link>
                          <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--color-text-muted)]">
                            {t.assignee ? <span>@{t.assignee.username}</span> : null}
                            <time
                              dateTime={t.updatedAt.toISOString()}
                              title={t.updatedAt.toISOString()}
                            >
                              {timeAgo(t.updatedAt)}
                            </time>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Attachments */}
        <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
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
        </section>
      </div>

      {/* ----- Sidebar (right) --------------------------------------- */}
      <aside className="order-2 space-y-4 xl:order-3">
        <form
          action={setEpicStatus}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="epicId" value={epic.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Status
          </div>
          <select
            name="status"
            defaultValue={epic.status}
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
          >
            <option value="open">open</option>
            <option value="done">done</option>
            <option value="archived">archived</option>
          </select>
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
            >
              Save
            </button>
          </div>
        </form>

        <EpicSidebarPicker
          title="Assignee"
          name="assigneeId"
          formAction={setEpicAssignee}
          slug={slug}
          epicId={epic.id}
          selectedId={epic.assigneeId}
          selectedLabel={epic.assignee?.username ?? null}
          principals={principals}
          emptyOption="Unassigned"
        />

        <EpicSidebarPicker
          title="Acting manager"
          name="actingManagerId"
          formAction={setEpicActingManager}
          slug={slug}
          epicId={epic.id}
          selectedId={epic.actingManagerId}
          selectedLabel={epic.actingManager?.username ?? null}
          principals={principals}
          emptyOption="No acting manager"
        />

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

        {/* Soft delete — moves the Epic and all its non-deleted tasks
            (plus sub-tasks) to the bin. Auto-purged after 7 days. */}
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

function EpicSidebarPicker({
  title,
  name,
  formAction,
  slug,
  epicId,
  selectedId,
  selectedLabel,
  principals,
  emptyOption,
}: {
  title: string;
  name: "assigneeId" | "actingManagerId";
  formAction: (formData: FormData) => Promise<void>;
  slug: string;
  epicId: string;
  selectedId: string | null;
  selectedLabel: string | null;
  principals: AssignablePrincipal[];
  emptyOption: string;
}) {
  return (
    <form
      action={formAction}
      className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
    >
      <input type="hidden" name="epicId" value={epicId} />
      <input type="hidden" name="projectSlug" value={slug} />
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {title}
      </div>
      <div className="text-sm">
        {selectedLabel ? (
          <span className="font-medium">@{selectedLabel}</span>
        ) : (
          <span className="text-[var(--color-text-muted)]">{emptyOption}</span>
        )}
      </div>
      <select
        name={name}
        defaultValue={selectedId ?? ""}
        className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
        aria-label={title}
      >
        <option value="">{emptyOption}</option>
        {principals.map((p) => (
          <option key={p.id} value={p.id}>
            {p.username}
            {p.kind === "agent" ? " (agent)" : ""}
          </option>
        ))}
      </select>
      <div className="flex justify-end">
        <button
          type="submit"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
        >
          Save
        </button>
      </div>
    </form>
  );
}
