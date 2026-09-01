"use server";

import { db } from "@/lib/db";
import {
  accessibleEpicWhere,
  accessibleProjectWhere,
  accessibleTaskWhere,
  getViewer,
} from "@/lib/auth/permissions";

// Server-side search backing the create FAB's scalable Epic / Task pickers.
// Access-filtered and capped so the pickers stay fast no matter how large a
// project grows. SQLite `contains` compiles to a case-insensitive ASCII LIKE.

export type PickerOption = { value: string; label: string; hint?: string };

const SEARCH_LIMIT = 20;

function epicLabel(epic: { title: string; workItemKey: string | null }) {
  return epic.workItemKey ? `${epic.workItemKey} · ${epic.title}` : epic.title;
}

function taskLabel(task: { title: string; workItemKey: string | null }) {
  return task.workItemKey ? `${task.workItemKey} · ${task.title}` : task.title;
}

async function resolveProject(projectSlug: string) {
  const viewer = await getViewer();
  if (!viewer) return null;
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug: projectSlug, archivedAt: null, deletedAt: null }),
    select: { id: true, slug: true },
  });
  return project ? { viewer, project } : null;
}

export async function searchProjectEpics(projectSlug: string, query: string): Promise<PickerOption[]> {
  const ctx = await resolveProject(projectSlug);
  if (!ctx) return [];
  const q = query.trim();
  const epics = await db.epic.findMany({
    where: accessibleEpicWhere(ctx.viewer, {
      projectId: ctx.project.id,
      archivedAt: null,
      deletedAt: null,
      ...(q ? { OR: [{ title: { contains: q } }, { workItemKey: { contains: q } }] } : {}),
    }),
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: SEARCH_LIMIT,
    select: { id: true, title: true, workItemKey: true },
  });
  return epics.map((epic) => ({ value: epic.id, label: epicLabel(epic) }));
}

// Attachment "attach to" picker: project-level + epics + tasks, value-prefixed
// so the FAB can route the choice to the right target on submit.
export async function searchProjectAttachTargets(projectSlug: string, query: string): Promise<PickerOption[]> {
  const ctx = await resolveProject(projectSlug);
  if (!ctx) return [];
  const q = query.trim();
  const [epics, tasks] = await Promise.all([
    db.epic.findMany({
      where: accessibleEpicWhere(ctx.viewer, {
        projectId: ctx.project.id,
        archivedAt: null,
        deletedAt: null,
        ...(q ? { OR: [{ title: { contains: q } }, { workItemKey: { contains: q } }] } : {}),
      }),
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: 10,
      select: { id: true, title: true, workItemKey: true },
    }),
    db.task.findMany({
      where: accessibleTaskWhere(ctx.viewer, {
        projectId: ctx.project.id,
        archivedAt: null,
        deletedAt: null,
        ...(q ? { OR: [{ title: { contains: q } }, { workItemKey: { contains: q } }] } : {}),
      }),
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, title: true, workItemKey: true },
    }),
  ]);
  const projectOption: PickerOption[] =
    q === "" || "project-level".includes(q.toLowerCase())
      ? [{ value: "project", label: "Project-level (whole project)", hint: "Project" }]
      : [];
  return [
    ...projectOption,
    ...epics.map((epic) => ({ value: `epic:${epic.id}`, label: epicLabel(epic), hint: "Epic" })),
    ...tasks.map((task) => ({ value: `task:${task.id}`, label: taskLabel(task), hint: "Task" })),
  ];
}

// Resolve a single item to a picker option for pre-selection from route context
// (e.g. pre-fill the Epic picker when the user is on that epic's page).
export async function resolvePickerOption(
  projectSlug: string,
  kind: "epic" | "task",
  id: string,
): Promise<PickerOption | null> {
  const ctx = await resolveProject(projectSlug);
  if (!ctx) return null;
  if (kind === "epic") {
    const epic = await db.epic.findFirst({
      where: accessibleEpicWhere(ctx.viewer, { id, projectId: ctx.project.id }),
      select: { id: true, title: true, workItemKey: true },
    });
    return epic ? { value: epic.id, label: epicLabel(epic) } : null;
  }
  const task = await db.task.findFirst({
    where: accessibleTaskWhere(ctx.viewer, { id, projectId: ctx.project.id }),
    select: { id: true, title: true, workItemKey: true },
  });
  return task ? { value: task.id, label: taskLabel(task) } : null;
}

// Per-project defaults for the Task/Epic role pickers (loaded when a project is
// chosen in a form). Principals themselves are bounded and loaded once app-wide.
export async function loadProjectDefaults(projectSlug: string): Promise<{
  defaultAssigneeId: string | null;
  defaultReviewerId: string | null;
}> {
  const ctx = await resolveProject(projectSlug);
  if (!ctx?.viewer.canAccessOwnerFeatures) {
    return { defaultAssigneeId: null, defaultReviewerId: null };
  }
  const project = await db.project.findUnique({
    where: { id: ctx.project.id },
    select: { defaultAssigneeId: true, defaultReviewerId: true },
  });
  return {
    defaultAssigneeId: project?.defaultAssigneeId ?? null,
    defaultReviewerId: project?.defaultReviewerId ?? null,
  };
}
