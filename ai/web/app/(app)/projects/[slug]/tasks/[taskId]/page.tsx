import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { renderCommentBody, extractMentions } from "@/lib/markdown";
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

async function createComment(formData: FormData) {
  "use server";
  const actorId = await requireActorId();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!taskId || !slug || !body) return;
  // Mild guardrail against accidental novel-length comments. The Next
  // server-action body limit also caps the total request at 1 MiB.
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

  // Mentions are parsed for the activity payload so future slices
  // (notifications, agent wake) can consume the list without re-parsing
  // the body. Storage is the raw markdown — render-time parsing remains
  // the source of truth for what users see.
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

  // Persistence is committed; dispatch is downstream of HOMELAB-44
  // rules. notifyDispatch logs and returns ok=false on transport
  // failure — comment creation is never rolled back as a result.
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
  const mentionedUsers = users.filter((u) =>
    mentions.includes(u.username),
  );
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

// Server-side assignment. checkAssignment is the rule layer (see
// HOMELAB-44 description: assignee + acting-manager pulled from
// agents/users table). Rule rejection (agent self-assign) throws
// because the UI only exposes the picker to authed users and the
// rejection path is a true policy fault, not an optimistic UI rollback
// like moveTask. Missing assignee row also throws — that means a stale
// option in the dropdown.
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

  // Dispatch is downstream of persistence — HOMELAB-44 enforcement
  // already returned by this point. Transport failure is logged by
  // notifyDispatch and does not roll the assignment back.
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

// Server-side acting-manager change. Mirrors assignTask: scope by URL
// slug, no-op on same-target, call the rule layer (checkActingManager),
// then verify the target user is active. Workflow rejection throws —
// the only failure mode (agent self-set) is a true policy fault. The
// activity row stores usernames so the feed remains stable even if
// the manager row is later deleted.
async function setActingManager(formData: FormData) {
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
      throw new Error("Acting manager not found or inactive");
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

// Sub-task creation. Mirrors the project-level createTask shape but
// always sets parentTaskId and inherits projectId + epicId from the
// parent task so the hierarchy stays consistent (epic > task > subtask
// per HOMELAB-44 description). checkHierarchy from lib/workflow is
// called server-side so the UI is not the only enforcement layer —
// matches the assignment/acting-manager pattern. Parent task is
// re-scoped by URL slug to avoid creating sub-tasks against a task in
// another project. New sub-tasks land in Backlog with the next rank
// after the parent's existing Backlog tasks, same as createTask.
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

  // A sub-task of a sub-task would violate the two-deep hierarchy
  // (epic > task > subtask). Reject at the action layer so it never
  // hits the DB; checkHierarchy itself only validates this row, not
  // the parent's depth.
  if (parent.parentTaskId !== null) {
    throw new Error("Cannot create sub-task under another sub-task");
  }

  const check = checkHierarchy({ level: "subtask", parentTaskId });
  if (!check.ok) throw new Error(check.message);

  const maxRank = await db.task.aggregate({
    where: { projectId: parent.projectId, status: "Backlog" },
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

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ slug: string; taskId: string }>;
}) {
  const { slug, taskId } = await params;

  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      project: { select: { id: true, slug: true, name: true } },
      assignee: { select: { username: true } },
      actingManager: { select: { username: true } },
      epic: { select: { id: true, title: true } },
      parent: { select: { id: true, title: true } },
      subtasks: {
        orderBy: { rank: "asc" },
        select: { id: true, title: true, status: true },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { user: { select: { username: true } } },
      },
    },
  });
  if (!task || task.project.slug !== slug) notFound();

  // For v1, anyone known to the system is mentionable / assignable.
  // Future slice may narrow this to project members. Inactive users are
  // excluded from the assignee picker so a deactivated account cannot
  // become the new owner of a task, but they remain mentionable so
  // historical comments still render their @ as a known mention.
  const users = await db.user.findMany({
    select: { id: true, username: true, kind: true, status: true },
    orderBy: { username: "asc" },
  });
  const mentionables = users.map((u) => ({ username: u.username }));
  const assignableUsers = users.filter((u) => u.status === "active");

  return (
    <div className="max-w-3xl">
      <nav className="mb-4 text-sm">
        <Link
          href={`/projects/${slug}`}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
        >
          ← {task.project.name}
        </Link>
      </nav>

      <header className="mb-4">
        <h1 className="text-xl font-semibold">{task.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <span className="inline-block rounded border border-[var(--color-line)] px-1.5 py-0.5">
            {task.status}
          </span>
          <span>
            {task.assignee
              ? `Assigned to ${task.assignee.username}`
              : "Unassigned"}
          </span>
          <span>
            {task.actingManager
              ? `Acting manager: ${task.actingManager.username}`
              : "No acting manager"}
          </span>
          {task.epic ? <span>Epic: {task.epic.title}</span> : null}
          {task.parent ? (
            <span>
              Parent:{" "}
              <Link
                href={`/projects/${slug}/tasks/${task.parent.id}`}
                className="hover:underline"
              >
                {task.parent.title}
              </Link>
            </span>
          ) : null}
        </div>
      </header>

      <form
        action={assignTask}
        className="mb-6 flex flex-wrap items-center gap-2 text-xs"
      >
        <input type="hidden" name="taskId" value={task.id} />
        <input type="hidden" name="projectSlug" value={slug} />
        <label
          htmlFor="assigneeId"
          className="text-[var(--color-text-muted)]"
        >
          Assignee
        </label>
        <select
          id="assigneeId"
          name="assigneeId"
          defaultValue={task.assigneeId ?? ""}
          className="rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">Unassigned</option>
          {assignableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
              {u.kind === "agent" ? " (agent)" : ""}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
        >
          Save
        </button>
      </form>

      <form
        action={setActingManager}
        className="mb-6 flex flex-wrap items-center gap-2 text-xs"
      >
        <input type="hidden" name="taskId" value={task.id} />
        <input type="hidden" name="projectSlug" value={slug} />
        <label
          htmlFor="actingManagerId"
          className="text-[var(--color-text-muted)]"
        >
          Acting manager
        </label>
        <select
          id="actingManagerId"
          name="actingManagerId"
          defaultValue={task.actingManagerId ?? ""}
          className="rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">No acting manager</option>
          {assignableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
              {u.kind === "agent" ? " (agent)" : ""}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
        >
          Save
        </button>
      </form>

      {task.description ? (
        <section className="mb-6 whitespace-pre-wrap rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm">
          {task.description}
        </section>
      ) : null}

      <section className="mb-6">
        <h2 className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Sub-tasks
        </h2>
        {task.subtasks.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--color-line)] px-3 py-4 text-xs text-[var(--color-text-muted)]">
            No sub-tasks yet.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded border border-[var(--color-line)] bg-[var(--color-panel)]">
            {task.subtasks.map((st) => (
              <li
                key={st.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <Link
                  href={`/projects/${slug}/tasks/${st.id}`}
                  className="truncate hover:underline"
                >
                  {st.title}
                </Link>
                <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                  {st.status}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/*
          Sub-task creation is hidden when the current task is itself a
          sub-task (parentTaskId !== null). The server action enforces
          the same two-deep limit so this is a UI-only convenience —
          createSubtask throws if asked to nest a sub-task under another
          sub-task. Top-level tasks (parentTaskId === null) get the form.
        */}
        {task.parentTaskId === null ? (
          <form action={createSubtask} className="mt-3 flex gap-2">
            <input type="hidden" name="parentTaskId" value={task.id} />
            <input type="hidden" name="projectSlug" value={slug} />
            <input
              name="title"
              required
              maxLength={200}
              placeholder="New sub-task title"
              className="flex-1 rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <button
              type="submit"
              className="rounded bg-[var(--color-accent)] text-[var(--color-bg)] text-sm font-medium px-3 hover:opacity-90"
            >
              Add sub-task
            </button>
          </form>
        ) : (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            Sub-tasks of sub-tasks are not allowed. Add sub-tasks on the
            parent task instead.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Comments
        </h2>
        {task.comments.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--color-line)] px-3 py-4 text-xs text-[var(--color-text-muted)]">
            No comments yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {task.comments.map((c) => (
              <li
                key={c.id}
                className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm"
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <strong className="text-[var(--color-text)] font-medium">
                    {c.user.username}
                  </strong>
                  <time
                    dateTime={c.createdAt.toISOString()}
                    className="tabular-nums"
                  >
                    {c.createdAt.toISOString().slice(0, 19).replace("T", " ")}
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
            className="w-full rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded bg-[var(--color-accent)] text-[var(--color-bg)] text-sm font-medium px-3 py-1.5 hover:opacity-90"
            >
              Add comment
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
