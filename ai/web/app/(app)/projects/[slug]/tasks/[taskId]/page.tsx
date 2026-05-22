import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  renderCommentBody,
  renderFullMarkdown,
  extractMentions,
} from "@/lib/markdown";
import {
  checkAssignment,
  checkActingManager,
  checkHierarchy,
  type ActorKind,
} from "@/lib/workflow";
import {
  buildTaskAssigned,
  buildTaskCommented,
  buildTaskMentioned,
  type EventTaskRef,
} from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import {
  listAssignablePrincipals,
  type AssignablePrincipal,
} from "@/lib/principals";
import { uploadAttachment, deleteAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { deleteTask } from "@/lib/bin/actions";
import AgentChatSidebar from "@/components/agent-chat";

async function requireActor(): Promise<{ id: string; kind: ActorKind }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, kind };
}

async function requireActorId(): Promise<string> {
  return (await requireActor()).id;
}

// ---- Server actions -------------------------------------------------

async function updateTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const titleRaw = String(formData.get("title") ?? "").trim();
  const descriptionRaw = String(formData.get("description") ?? "");
  if (!taskId || !slug || !titleRaw) return;
  if (titleRaw.length > 200) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;

  const newDescription = descriptionRaw.trim() === "" ? null : descriptionRaw;
  const titleChanged = task.title !== titleRaw;
  const descChanged = (task.description ?? null) !== newDescription;
  if (!titleChanged && !descChanged) return;

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { title: titleRaw, description: newDescription },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.update",
        payload: JSON.stringify({
          titleChanged,
          descChanged,
          from: { title: task.title, hasDescription: task.description !== null },
          to: { title: titleRaw, hasDescription: newDescription !== null },
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function setTaskEpic(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const raw = String(formData.get("epicId") ?? "");
  const newEpicId = raw === "" ? null : raw;
  if (!taskId || !slug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      epicId: true,
      project: { select: { slug: true } },
      epic: { select: { id: true, title: true, projectId: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if (task.epicId === newEpicId) return;

  // Scope-check: target epic must belong to the same project.
  let newEpicTitle: string | null = null;
  if (newEpicId !== null) {
    const target = await db.epic.findUnique({
      where: { id: newEpicId },
      select: { title: true, projectId: true },
    });
    if (!target || target.projectId !== task.projectId) {
      throw new Error("Epic not found in this project");
    }
    newEpicTitle = target.title;
  }

  await db.$transaction([
    db.task.update({ where: { id: taskId }, data: { epicId: newEpicId } }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.epic",
        payload: JSON.stringify({
          from: task.epic?.title ?? null,
          to: newEpicTitle,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function createComment(formData: FormData) {
  "use server";
  const actorId = await requireActorId();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!taskId || !slug || !body) return;
  if (body.length > 8000) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;

  const users = await db.user.findMany({
    select: { id: true, username: true, kind: true },
  });
  const mentions = extractMentions(
    body,
    users.map((u) => ({ username: u.username })),
  );

  const created = await db.$transaction([
    db.comment.create({
      data: { taskId, userId: actorId, body },
      select: { id: true },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actorId,
        kind: "task.comment",
        payload: mentions.length > 0 ? JSON.stringify({ mentions }) : null,
      },
    }),
  ]);
  const commentId = created[0].id;

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);

  const taskRef: EventTaskRef = {
    id: task.id,
    key: task.id,
    projectKey: task.project.slug,
    title: task.title,
  };
  const actor = {
    id: actorId,
    kind: (users.find((u) => u.id === actorId)?.kind === "agent"
      ? "agent"
      : "human") as "human" | "agent",
  };
  const occurredAt = new Date().toISOString();
  const mentionedUsers = users.filter((u) => mentions.includes(u.username));
  await notifyDispatch(
    buildTaskCommented(
      { id: randomUUID(), occurredAt, actor, task: taskRef },
      {
        commentId,
        bodyMarkdown: body,
        mentions: mentionedUsers.map((u) => ({
          id: u.id,
          kind: u.kind === "agent" ? "agent" : "human",
        })),
      },
    ),
  );
  for (const u of mentionedUsers) {
    await notifyDispatch(
      buildTaskMentioned(
        { id: randomUUID(), occurredAt, actor, task: taskRef },
        {
          commentId,
          mentioned: { id: u.id, kind: u.kind === "agent" ? "agent" : "human" },
          bodyMarkdown: body,
        },
      ),
    );
  }
}

async function assignTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const raw = String(formData.get("assigneeId") ?? "");
  const newAssigneeId = raw === "" ? null : raw;
  if (!taskId || !slug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      assigneeId: true,
      title: true,
      project: { select: { slug: true } },
      assignee: { select: { id: true, username: true, kind: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if (task.assigneeId === newAssigneeId) return;

  const check = checkAssignment({ actor, newAssigneeId });
  if (!check.ok) throw new Error(check.message);

  let toUsername: string | null = null;
  let target: { id: string; username: string; kind: string } | null = null;
  if (newAssigneeId !== null) {
    const row = await db.user.findUnique({
      where: { id: newAssigneeId },
      select: { id: true, username: true, kind: true, status: true },
    });
    if (!row || row.status !== "active") {
      throw new Error("Assignee not found or inactive");
    }
    target = { id: row.id, username: row.username, kind: row.kind };
    toUsername = row.username;
  }

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { assigneeId: newAssigneeId },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.assign",
        payload: JSON.stringify({
          from: task.assignee?.username ?? null,
          to: toUsername,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);

  await notifyDispatch(
    buildTaskAssigned(
      {
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        actor,
        task: {
          id: task.id,
          key: task.id,
          projectKey: task.project.slug,
          title: task.title,
        },
      },
      {
        assignee: target
          ? {
              id: target.id,
              kind: target.kind === "agent" ? "agent" : "human",
              name: target.username,
            }
          : null,
        previousAssignee: task.assignee
          ? {
              id: task.assignee.id,
              kind: task.assignee.kind === "agent" ? "agent" : "human",
              name: task.assignee.username,
            }
          : null,
      },
    ),
  );
}

async function setReviewer(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const raw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = raw === "" ? null : raw;
  if (!taskId || !slug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      actingManagerId: true,
      project: { select: { slug: true } },
      actingManager: { select: { username: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if (task.actingManagerId === newActingManagerId) return;

  const check = checkActingManager({ actor, newActingManagerId });
  if (!check.ok) throw new Error(check.message);

  let toUsername: string | null = null;
  if (newActingManagerId !== null) {
    const target = await db.user.findUnique({
      where: { id: newActingManagerId },
      select: { username: true, status: true },
    });
    if (!target || target.status !== "active") {
      throw new Error("Reviewer not found or inactive");
    }
    toUsername = target.username;
  }

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { actingManagerId: newActingManagerId },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        // Activity kind stays "task.acting_manager" so the historical
        // feed renders unchanged; UI labels it "Reviewer" only.
        kind: "task.acting_manager",
        payload: JSON.stringify({
          from: task.actingManager?.username ?? null,
          to: toUsername,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function createSubtask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const parentTaskId = String(formData.get("parentTaskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!parentTaskId || !slug || !title) return;
  if (title.length > 200) return;

  const parent = await db.task.findUnique({
    where: { id: parentTaskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      epicId: true,
      parentTaskId: true,
      project: { select: { slug: true } },
    },
  });
  if (!parent || parent.project.slug !== slug) return;

  if (parent.parentTaskId !== null) {
    throw new Error("Cannot create sub-task under another sub-task");
  }

  const check = checkHierarchy({ level: "subtask", parentTaskId });
  if (!check.ok) throw new Error(check.message);

  const maxRank = await db.task.aggregate({
    where: { projectId: parent.projectId, status: "Backlog", deletedAt: null },
    _max: { rank: true },
  });

  const child = await db.task.create({
    data: {
      projectId: parent.projectId,
      epicId: parent.epicId,
      parentTaskId,
      title,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
    },
    select: { id: true, title: true },
  });

  await db.activityLog.create({
    data: {
      projectId: parent.projectId,
      taskId: child.id,
      userId: actor.id,
      kind: "task.create",
      payload: JSON.stringify({
        title: child.title,
        parentTaskId,
        parentTitle: parent.title,
      }),
    },
  });

  revalidatePath(`/projects/${slug}/tasks/${parentTaskId}`);
  revalidatePath(`/projects/${slug}/tasks/${child.id}`);
  revalidatePath(`/projects/${slug}`);
}

// ---- Helpers --------------------------------------------------------

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

function PrincipalOption({ p }: { p: AssignablePrincipal }) {
  return (
    <option value={p.id}>
      {p.username}
      {p.kind === "agent" ? " (agent)" : ""}
    </option>
  );
}

// ---- Page -----------------------------------------------------------

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; taskId: string }>;
  searchParams: Promise<{ chat?: string }>;
}) {
  const { slug, taskId } = await params;
  const { chat } = await searchParams;
  const chatAgentSlug = typeof chat === "string" && chat !== "" ? chat : null;

  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      project: { select: { id: true, slug: true, name: true } },
      assignee: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
      epic: { select: { id: true, title: true } },
      parent: { select: { id: true, title: true } },
      subtasks: {
        where: { deletedAt: null },
        orderBy: { rank: "asc" },
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
          assignee: { select: { username: true } },
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { user: { select: { username: true } } },
      },
      attachments: {
        orderBy: { createdAt: "desc" },
        include: { uploader: { select: { username: true } } },
      },
    },
  });
  if (!task || task.project.slug !== slug || task.deletedAt) notFound();

  const [principals, projectEpics, mentionableUsers] = await Promise.all([
    listAssignablePrincipals(),
    db.epic.findMany({
      where: {
        projectId: task.project.id,
        status: { not: "archived" },
        deletedAt: null,
      },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      select: { id: true, title: true, status: true },
    }),
    db.user.findMany({ select: { username: true } }),
  ]);
  const mentionables = mentionableUsers.map((u) => ({ username: u.username }));

  return (
    <div className="mx-auto grid max-w-[1600px] grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[320px_minmax(0,1fr)_320px]">
      {/* ----- Chat sidebar (left) ----------------------------------- */}
      <aside className="order-3 xl:order-1">
        <AgentChatSidebar
          projectSlug={slug}
          taskId={task.id}
          selectedAgentSlug={chatAgentSlug}
          parentPath={`/projects/${slug}/tasks/${task.id}`}
        />
      </aside>

      {/* ----- Main column ------------------------------------------- */}
      <div className="order-1 min-w-0 space-y-6 xl:order-2">
        <nav className="text-sm">
          <Link
            href={`/projects/${slug}`}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
          >
            ← {task.project.name}
          </Link>
        </nav>

        {/* Title + description editor */}
        <form
          action={updateTask}
          className="space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <input
            name="title"
            defaultValue={task.title}
            required
            maxLength={200}
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight outline-none transition focus:border-[var(--color-line)] focus:bg-[var(--color-bg)]"
            aria-label="Task title"
          />
          {task.description ? (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Preview
              </div>
              <div
                className="md"
                dangerouslySetInnerHTML={renderFullMarkdown(task.description)}
              />
            </div>
          ) : null}
          <textarea
            name="description"
            defaultValue={task.description ?? ""}
            // Sub-tasks (parentTaskId !== null) get a taller editor —
            // they're where most of the day-to-day work detail lands,
            // so the larger box matches actual use (HOMELAB-48).
            rows={task.parentTaskId !== null ? 24 : 12}
            placeholder="Add a description — markdown supported (headings, lists, code fences, tables)"
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>
              Last updated <time dateTime={task.updatedAt.toISOString()} title={task.updatedAt.toISOString()}>{timeAgo(task.updatedAt)}</time>
            </span>
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              Save changes
            </button>
          </div>
        </form>

        {/* Sub-tasks */}
        <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-text)]">
              Sub-tasks
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">
              {task.subtasks.length} total
            </span>
          </div>
          {task.subtasks.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No sub-tasks yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {task.subtasks.map((st) => (
                <li
                  key={st.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <Link
                    href={`/projects/${slug}/tasks/${st.id}`}
                    className="truncate hover:underline"
                  >
                    {st.title}
                  </Link>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--color-text-muted)]">
                    {st.assignee ? <span>@{st.assignee.username}</span> : null}
                    <span className="rounded border border-[var(--color-line)] px-1.5 py-0.5">
                      {st.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {task.parentTaskId === null ? (
            <form action={createSubtask} className="mt-4 flex gap-2">
              <input type="hidden" name="parentTaskId" value={task.id} />
              <input type="hidden" name="projectSlug" value={slug} />
              <input
                name="title"
                required
                maxLength={200}
                placeholder="New sub-task title"
                className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="submit"
                className="rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Add
              </button>
            </form>
          ) : (
            <p className="mt-4 text-xs text-[var(--color-text-muted)]">
              Sub-tasks of sub-tasks are not allowed. Add sub-tasks on the
              parent task.
            </p>
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
          {task.attachments.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No attachments yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {task.attachments.map((a) => (
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
            <input type="hidden" name="taskId" value={task.id} />
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

        {/* Comments */}
        <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-[var(--color-text)]">
            Comments
          </h2>
          {task.comments.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No comments yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {task.comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm"
                >
                  <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <strong className="font-medium text-[var(--color-text)]">
                      {c.user.username}
                    </strong>
                    <time
                      dateTime={c.createdAt.toISOString()}
                      title={c.createdAt.toISOString()}
                      className="tabular-nums"
                    >
                      {timeAgo(c.createdAt)}
                    </time>
                  </div>
                  <div>{renderCommentBody(c.body, mentionables)}</div>
                </li>
              ))}
            </ul>
          )}

          <form action={createComment} className="mt-4 space-y-2">
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="projectSlug" value={slug} />
            <textarea
              name="body"
              required
              rows={3}
              placeholder="Write a comment — **markdown** and @mentions supported"
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
        </section>
      </div>

      {/* ----- Sidebar (right) --------------------------------------- */}
      <aside className="order-2 space-y-4 xl:order-3">
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Status
          </div>
          <div className="mt-2 inline-block rounded-full border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2.5 py-1 text-xs font-medium">
            {task.status}
          </div>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Move on the board to change status.
          </p>
        </div>

        <SidebarPicker
          title="Assignee"
          name="assigneeId"
          formAction={assignTask}
          slug={slug}
          taskId={task.id}
          selectedId={task.assigneeId}
          selectedLabel={task.assignee?.username ?? null}
          principals={principals}
          emptyOption="Unassigned"
        />

        <SidebarPicker
          title="Reviewer"
          name="actingManagerId"
          formAction={setReviewer}
          slug={slug}
          taskId={task.id}
          selectedId={task.actingManagerId}
          selectedLabel={task.actingManager?.username ?? null}
          principals={principals}
          emptyOption="No reviewer"
        />

        {/* Epic picker — independent of any Epic.assignee. Tasks may
            live without an Epic, and switching epics is reversible. */}
        <form
          action={setTaskEpic}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Epic
          </div>
          <select
            name="epicId"
            defaultValue={task.epicId ?? ""}
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">No epic</option>
            {projectEpics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
                {e.status !== "open" ? ` · ${e.status}` : ""}
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
          {task.epic ? (
            <Link
              href={`/projects/${slug}/epics/${task.epic.id}`}
              className="block text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
            >
              Open epic →
            </Link>
          ) : null}
        </form>

        {task.parent ? (
          <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Parent task
            </div>
            <Link
              href={`/projects/${slug}/tasks/${task.parent.id}`}
              className="mt-2 block text-sm hover:underline"
            >
              {task.parent.title}
            </Link>
          </div>
        ) : null}

        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Dates
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Created</dt>
              <dd>
                <time
                  dateTime={task.createdAt.toISOString()}
                  title={task.createdAt.toISOString()}
                  className="tabular-nums"
                >
                  {timeAgo(task.createdAt)}
                </time>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Updated</dt>
              <dd>
                <time
                  dateTime={task.updatedAt.toISOString()}
                  title={task.updatedAt.toISOString()}
                  className="tabular-nums"
                >
                  {timeAgo(task.updatedAt)}
                </time>
              </dd>
            </div>
          </dl>
        </div>

        {/* Soft delete — moves the task (and any sub-tasks) to the bin
            for 7 days, then hard-deletes. Restore from /projects/<slug>/bin. */}
        <form
          action={deleteTask}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-crit)]">
            Danger zone
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Move this task to the bin. Sub-tasks ({task.subtasks.length}) go
            with it. Auto-purged after 7 days.
          </p>
          <button
            type="submit"
            className="w-full rounded-lg border border-[var(--color-crit)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-crit)] hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
          >
            Delete task
          </button>
        </form>
      </aside>
    </div>
  );
}

// Sidebar picker shell — used for Assignee + Reviewer so both look
// identical and pull from the same principal pool. Server action
// references stay in the page so Next can pick them up as server
// actions (vs. importing from a client module).
function SidebarPicker({
  title,
  name,
  formAction,
  slug,
  taskId,
  selectedId,
  selectedLabel,
  principals,
  emptyOption,
}: {
  title: string;
  name: "assigneeId" | "actingManagerId";
  formAction: (formData: FormData) => Promise<void>;
  slug: string;
  taskId: string;
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
      <input type="hidden" name="taskId" value={taskId} />
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
          <PrincipalOption key={p.id} p={p} />
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
