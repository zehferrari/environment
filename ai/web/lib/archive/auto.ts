import { db } from "@/lib/db";
import { resolveDoneTtlDays } from "@/lib/settings/system";

export interface AutoArchiveDoneTasksResult {
  archivedTasks: number;
  projectsChecked: number;
  errors: string[];
}

export async function autoArchiveDoneTasks(): Promise<AutoArchiveDoneTasksResult> {
  const result: AutoArchiveDoneTasksResult = {
    archivedTasks: 0,
    projectsChecked: 0,
    errors: [],
  };

  const projects = await db.project.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, doneTtlDays: true },
  });

  for (const project of projects) {
    result.projectsChecked += 1;
    const days = await resolveDoneTtlDays(project.doneTtlDays);
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const tasks = await db.task.findMany({
      where: {
        projectId: project.id,
        status: "Done",
        archivedAt: null,
        deletedAt: null,
        OR: [
          { statusChangedAt: { lt: cutoff } },
          { statusChangedAt: null, updatedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, title: true, statusChangedAt: true, updatedAt: true },
    });
    if (tasks.length === 0) continue;

    const archivedAt = new Date();
    try {
      await db.$transaction([
        db.task.updateMany({
          where: { id: { in: tasks.map((task) => task.id) } },
          data: { archivedAt, archivedById: null },
        }),
        ...tasks.map((task) =>
          db.activityLog.create({
            data: {
              projectId: project.id,
              taskId: task.id,
              userId: null,
              kind: "task.auto_archive",
              payload: JSON.stringify({
                taskId: task.id,
                title: task.title,
                projectSlug: project.slug,
                days,
                cutoff: cutoff.toISOString(),
                doneAt: (task.statusChangedAt ?? task.updatedAt).toISOString(),
                archivedAt: archivedAt.toISOString(),
              }),
            },
          }),
        ),
      ]);
      result.archivedTasks += tasks.length;
    } catch (err) {
      result.errors.push(`${project.slug}: ${(err as Error).message}`);
    }
  }

  if (result.archivedTasks > 0 || result.errors.length > 0) {
    await db.activityLog
      .create({
        data: {
          userId: null,
          kind: "task.auto_archive.summary",
          payload: JSON.stringify(result),
        },
      })
      .catch((err) => result.errors.push(`audit: ${(err as Error).message}`));
  }

  return result;
}
