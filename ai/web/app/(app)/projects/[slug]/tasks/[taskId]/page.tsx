import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { renderCommentBody, extractMentions } from "@/lib/markdown";
import { checkAssignment, type ActorKind } from "@/lib/workflow";

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
    select: { id: true, projectId: true, project: { select: { slug: true } } },
  });
  if (!task || task.project.slug !== slug) return;

  // Mentions are parsed for the activity payload so future slices
  // (notifications, agent wake) can consume the list without re-parsing
  // the body. Storage is the raw markdown — render-time parsing remains
  // the source of truth for what users see.
  const users = await db.user.findMany({ select: { username: true } });
  const mentions = extractMentions(
    body,
    users.map((u) => ({ username: u.username })),
  );

  await db.$transaction([
    db.comment.create({
      data: { taskId, userId: actorId, body },
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

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
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
      project: { select: { slug: true } },
      assignee: { select: { username: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if (task.assigneeId === newAssigneeId) return;

  const check = checkAssignment({ actor, newAssigneeId });
  if (!check.ok) throw new Error(check.message);

  let toUsername: string | null = null;
  if (newAssigneeId !== null) {
    const target = await db.user.findUnique({
      where: { id: newAssigneeId },
      select: { username: true, status: true },
    });
    if (!target || target.status !== "active") {
      throw new Error("Assignee not found or inactive");
    }
    toUsername = target.username;
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

      {task.description ? (
        <section className="mb-6 whitespace-pre-wrap rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm">
          {task.description}
        </section>
      ) : null}

      {task.subtasks.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            Sub-tasks
          </h2>
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
        </section>
      ) : null}

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
