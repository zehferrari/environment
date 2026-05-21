import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import Board from "./board-client";
import { COLUMNS, COLUMN_IDS } from "./columns";

async function createTask(formData: FormData) {
  "use server";
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!projectId || !title) return;
  const projectSlug = String(formData.get("projectSlug") ?? "");
  const maxRank = await db.task.aggregate({
    where: { projectId, status: "Backlog" },
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

async function moveTask(taskId: string, status: string, slug: string) {
  "use server";
  if (!COLUMN_IDS.includes(status)) return;
  const maxRank = await db.task.aggregate({
    where: { status },
    _max: { rank: true },
  });
  await db.task.update({
    where: { id: taskId },
    data: { status, rank: (maxRank._max.rank ?? 0) + 1 },
  });
  await db.activityLog.create({
    data: {
      taskId,
      kind: "task.move",
      payload: JSON.stringify({ status }),
    },
  });
  revalidatePath(`/projects/${slug}`);
}

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug },
    include: {
      tasks: { orderBy: [{ status: "asc" }, { rank: "asc" }] },
    },
  });
  if (!project) notFound();

  return (
    <div>
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <div className="text-xs text-[var(--color-text-muted)]">/{project.slug}</div>
        </div>
        <form action={createTask} className="flex gap-2">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="projectSlug" value={project.slug} />
          <input
            name="title"
            required
            placeholder="New task title"
            className="rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] w-72"
          />
          <button
            type="submit"
            className="rounded bg-[var(--color-accent)] text-[var(--color-bg)] text-sm font-medium px-3 hover:opacity-90"
          >
            Add task
          </button>
        </form>
      </header>

      <Board
        projectSlug={project.slug}
        columns={COLUMNS}
        tasks={project.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          rank: t.rank,
        }))}
        moveTaskAction={moveTask}
      />
    </div>
  );
}
