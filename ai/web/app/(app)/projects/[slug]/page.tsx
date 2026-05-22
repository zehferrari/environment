import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  checkStatusTransition,
  type ActorKind,
  type WorkflowErrorCode,
} from "@/lib/workflow";
import { describeActivity } from "@/lib/activity";
import Link from "next/link";
import Board from "./board-client";
import { COLUMNS, COLUMN_IDS } from "./columns";

async function requireActor(): Promise<{ id: string; kind: ActorKind }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, kind };
}

async function createTask(formData: FormData) {
  "use server";
  await requireActor();
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!projectId || !title) return;
  const projectSlug = String(formData.get("projectSlug") ?? "");
  const maxRank = await db.task.aggregate({
    where: { projectId, status: "Backlog", deletedAt: null },
    _max: { rank: true },
  });
  await db.task.create({
    data: {
      projectId,
      title,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
    },
  });
  revalidatePath(`/projects/${projectSlug}`);
}

// Workflow rejections (invalid edge, agent-touches-Review/Done, unknown
// column) are returned as data so the client can roll the optimistic
// move back instead of swallowing a generic thrown Error. Authentication
// failure still throws — that is a true server fault, not a rule
// rejection.
export type MoveTaskResult =
  | { ok: true }
  | { ok: false; code: WorkflowErrorCode | "UNKNOWN_COLUMN"; message: string };

async function moveTask(
  taskId: string,
  status: string,
  slug: string,
): Promise<MoveTaskResult> {
  "use server";
  const actor = await requireActor();
  if (!COLUMN_IDS.includes(status)) {
    return {
      ok: false,
      code: "UNKNOWN_COLUMN",
      message: `Unknown column: ${status}`,
    };
  }
  const current = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, projectId: true, deletedAt: true },
  });
  if (!current || current.deletedAt) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  }
  if (current.status === status) return { ok: true };

  const check = checkStatusTransition({
    from: current.status,
    to: status,
    actor,
  });
  if (!check.ok) {
    return { ok: false, code: check.code, message: check.message };
  }

  const maxRank = await db.task.aggregate({
    where: { status, deletedAt: null },
    _max: { rank: true },
  });
  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { status, rank: (maxRank._max.rank ?? 0) + 1 },
    }),
    db.activityLog.create({
      data: {
        projectId: current.projectId,
        taskId,
        userId: actor.id,
        kind: "task.move",
        payload: JSON.stringify({ from: current.status, to: status }),
      },
    }),
  ]);
  revalidatePath(`/projects/${slug}`);
  return { ok: true };
}

const ACTIVITY_FEED_LIMIT = 20;

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug },
    include: {
      tasks: {
        where: { deletedAt: null },
        orderBy: [{ status: "asc" }, { rank: "asc" }],
        include: { assignee: { select: { username: true } } },
      },
      _count: {
        select: {
          epics: { where: { status: "open", deletedAt: null } },
          tasks: { where: { deletedAt: { not: null } } },
        },
      },
    },
  });
  if (!project) notFound();

  const activity = await db.activityLog.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: ACTIVITY_FEED_LIMIT,
    include: {
      user: { select: { username: true } },
      task: { select: { title: true } },
    },
  });

  const feed = activity.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    label: describeActivity({
      kind: row.kind,
      payload: row.payload,
      actorName: row.user?.username ?? null,
      taskTitle: row.task?.title ?? null,
    }),
  }));

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <div className="text-xs text-[var(--color-text-muted)]">/{project.slug}</div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/projects/${project.slug}/epics`}
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Epics{project._count.epics > 0 ? ` (${project._count.epics})` : ""}
          </Link>
          <Link
            href={`/projects/${project.slug}/bin`}
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Bin{project._count.tasks > 0 ? ` (${project._count.tasks})` : ""}
          </Link>
          <form action={createTask} className="flex gap-2">
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="projectSlug" value={project.slug} />
            <input
              name="title"
              required
              placeholder="New task title (no epic)"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] w-72"
            />
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium px-3 shadow-sm hover:opacity-95"
            >
              Add task
            </button>
          </form>
        </div>
      </header>

      <Board
        projectSlug={project.slug}
        columns={COLUMNS}
        tasks={project.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          rank: t.rank,
          updatedAt: t.updatedAt.toISOString(),
          assigneeName: t.assignee?.username ?? null,
        }))}
        moveTaskAction={moveTask}
      />

      <section className="mt-6">
        <h2 className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
          Recent activity
        </h2>
        {feed.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--color-line)] px-3 py-4 text-xs text-[var(--color-text-muted)]">
            No activity yet. Move a task between columns to log the first row.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
            {feed.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span>{row.label}</span>
                <time
                  dateTime={row.createdAt}
                  className="shrink-0 text-xs text-[var(--color-text-muted)] tabular-nums"
                >
                  {row.createdAt.slice(0, 19).replace("T", " ")}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
