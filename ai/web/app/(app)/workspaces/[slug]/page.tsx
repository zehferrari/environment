import { activeChecklistProgress, checklistProgressSelect } from "@/lib/tasks/checklist-progress";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { binTask } from "@/lib/bin/actions";
import { activeFormalBlockersByTask } from "@/lib/tasks/formal-blocker";
import { normalizeWorkspaceSlug } from "@/lib/workspaces/service";
import Board from "../../projects/[slug]/board-client";
import { COLUMNS } from "../../projects/[slug]/columns";
import {
  accessibleProjectWhere,
  accessibleCommentWhere,
  accessibleTaskWhere,
  requireViewer,
  workspaceAccessWhere,
  viewerExperienceForRole,
} from "@/lib/auth/permissions";
import { visibleActivityRecordWhere } from "@/lib/users/agent-content-policy";
import {
  getActorVisibility,
  serializeVisibleActor,
  serializeVisibleActorAs,
  type ActorVisibility,
} from "@/lib/users/actor-visibility";

type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
};

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

async function readBusyAgentSlugs(): Promise<Set<string>> {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return new Set();
    const snapshot = (await res.json()) as {
      agents?: Record<string, { busy_state?: { is_busy?: boolean } | null }>;
    };
    const busy = new Set<string>();
    for (const [slug, agent] of Object.entries(snapshot.agents ?? {})) {
      if (agent?.busy_state?.is_busy) busy.add(slug);
    }
    return busy;
  } catch {
    return new Set();
  }
}

function serializeActor(actor: ActorRow | null, visibility: ActorVisibility) {
  return serializeVisibleActor(actor, visibility);
}

type SerializedActor = NonNullable<ReturnType<typeof serializeActor>>;
type TaskActivityActorRow = {
  taskId: string | null;
  kind: string;
  user: ActorRow | null;
};

function buildTaskActivityActorMaps(rows: TaskActivityActorRow[], visibility: ActorVisibility) {
  const createdBy = new Map<string, SerializedActor>();
  const updatedBy = new Map<string, SerializedActor>();

  for (const row of rows) {
    if (!row.taskId || !row.user) continue;
    const actor = serializeActor(row.user, visibility);
    if (!actor) continue;
    if (!updatedBy.has(row.taskId)) updatedBy.set(row.taskId, actor);
    if (row.kind === "task.create" && !createdBy.has(row.taskId)) {
      createdBy.set(row.taskId, actor);
    }
  }

  return { createdBy, updatedBy };
}

export const dynamic = "force-dynamic";

export default async function WorkspaceBoardPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = await requireViewer();
  const experience = viewerExperienceForRole(viewer.role);
  const { slug: rawSlug } = await params;
  let slug: string;
  try {
    slug = normalizeWorkspaceSlug(rawSlug);
  } catch {
    notFound();
  }

  const workspace = await db.workspace.findFirst({
    where: { AND: [{ slug }, workspaceAccessWhere(viewer)] },
    include: {
      projects: {
        where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
        include: { project: { select: { id: true, slug: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!workspace) notFound();
  const projectIds = workspace.projects.map(({ project }) => project.id);
  const tasks = projectIds.length > 0
    ? await db.task.findMany({
        where: accessibleTaskWhere(viewer, { projectId: { in: projectIds }, deletedAt: null, archivedAt: null, parentTaskId: null }),
        orderBy: [{ status: "asc" }, { rank: "asc" }],
        include: {
          project: { select: { slug: true, name: true } },
          reporter: { select: actorSelect },
          assignee: { select: actorSelect },
          actingManager: { select: actorSelect },
          epic: {
            select: {
              title: true,
              deploymentStatus: true,
              actingManager: { select: actorSelect },
            },
          },
          ...checklistProgressSelect,
          // ENV-123 — drives the board's execution badge. Only the state word
          // is needed here; the full four-line strip lives on the task page.
          executionState: { select: { state: true, reasonDetail: true } },
          blockedBy: { select: { status: true } },
          dependencies: {
            select: { prerequisite: { select: { id: true, status: true } } },
          },
        },
      })
    : [];

  const taskIds = tasks.map((task) => task.id);
  const blockerIds = tasks
    .flatMap((task) => [task.blockedById, ...task.dependencies.map((edge) => edge.prerequisite.id)])
    .filter((id): id is string => Boolean(id));
  const [taskActivityRows, busyAgentSlugs, actorVisibility, visibleBlockers, legacyBlockerComments] = await Promise.all([
    taskIds.length > 0
      ? db.activityLog.findMany({
          where: { AND: [{ taskId: { in: taskIds } }, visibleActivityRecordWhere(viewer)] },
          orderBy: { createdAt: "desc" },
          select: { taskId: true, kind: true, payload: true, createdAt: true, user: { select: actorSelect } },
        })
      : Promise.resolve([]),
    viewer.canAccessOwnerFeatures ? readBusyAgentSlugs() : Promise.resolve(new Set<string>()),
    getActorVisibility(viewer),
    blockerIds.length > 0
      ? db.task.findMany({
          where: accessibleTaskWhere(viewer, { id: { in: blockerIds } }),
          select: { id: true, workItemKey: true, status: true },
        })
      : Promise.resolve([]),
    taskIds.length > 0
      ? db.comment.findMany({
          where: accessibleCommentWhere(viewer, {
            taskId: { in: taskIds },
            deletedAt: null,
            body: { startsWith: "**Blocker raised**" },
          }),
          select: { id: true, taskId: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);
  const taskActivityActors = buildTaskActivityActorMaps(taskActivityRows, actorVisibility);
  const activeFormalBlockers = activeFormalBlockersByTask(taskActivityRows, legacyBlockerComments);
  const visibleBlockerById = new Map(visibleBlockers.map((task) => [task.id, task]));

  const boardChromeScope = `workspace-${workspace.slug}`;

  return (
    <div>
      <Board
        projectSlug={workspace.slug}
        chromeSlotScope={boardChromeScope}
        boardStreamUrl={`/api/workspaces/${workspace.slug}/board/stream`}
        columns={COLUMNS}
        tasks={tasks.map((t) => {
          const unresolvedIds = [...new Set([
            ...(t.blockedById && t.blockedBy?.status !== "Done" ? [t.blockedById] : []),
            ...t.dependencies.filter((edge) => edge.prerequisite.status !== "Done").map((edge) => edge.prerequisite.id),
          ])];
          const blockedByKeys = experience.customerSafe ? [] : unresolvedIds.map((id) => visibleBlockerById.get(id)?.workItemKey ?? "another task");
          return {
            id: t.id,
            workItemKey: t.workItemKey ?? null,
            title: t.title,
            status: t.status,
            rank: t.rank,
            createdAt: t.createdAt.toISOString(),
            updatedAt: (actorVisibility.excludeAgentRecords ? t.createdAt : t.updatedAt).toISOString(),
            statusChangedAt: actorVisibility.excludeAgentRecords ? null : t.statusChangedAt?.toISOString() ?? null,
            approvedOn: actorVisibility.excludeAgentRecords ? null : t.approvedOn?.toISOString() ?? null,
            deploymentStatus: t.epic?.deploymentStatus ?? t.deploymentStatus,
            epicId: t.epicId,
            reporter: serializeActor(t.reporter, actorVisibility),
            // Role-driven non-owner board identity (see project board page).
            assignee: actorVisibility.excludeAgentRecords ? null : serializeVisibleActorAs(t.assignee, "assignee", actorVisibility),
            reviewer: actorVisibility.excludeAgentRecords ? null : serializeVisibleActorAs(t.actingManager, "reviewer", actorVisibility),
            manager: actorVisibility.excludeAgentRecords ? null : serializeVisibleActorAs(t.epic?.actingManager ?? null, "reviewer", actorVisibility),
            createdBy: taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter, actorVisibility),
            updatedBy: taskActivityActors.updatedBy.get(t.id) ?? taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter, actorVisibility),
            epicTitle: t.epic?.title ?? null,
            ...activeChecklistProgress(t, actorVisibility.excludeAgentRecords),
            subtaskMinutes: actorVisibility.excludeAgentRecords ? 0 : t.checklist.reduce((sum, c) => sum + (c.minutesSpent ?? 0), 0),
            blockedByKeys,
            hasActiveBlocker: actorVisibility.excludeAgentRecords ? false : activeFormalBlockers.has(t.id),
            executionState: actorVisibility.excludeAgentRecords ? null : t.executionState?.state ?? null,
            executionReason: actorVisibility.excludeAgentRecords ? null : t.executionState?.reasonDetail ?? null,
            activeBlockerCommentId: actorVisibility.excludeAgentRecords ? null : activeFormalBlockers.get(t.id)?.commentId ?? null,
            activeWorking: actorVisibility.excludeAgentRecords ? false : (
              (t.status === "In Progress" && Boolean(t.assignee?.agent?.slug && busyAgentSlugs.has(t.assignee.agent.slug))) ||
              (t.status === "Review" && Boolean(t.actingManager?.agent?.slug && busyAgentSlugs.has(t.actingManager.agent.slug)))),
            project: { slug: t.project.slug, name: t.project.name },
            hideInternalActors: actorVisibility.excludeAgentRecords,
          };
        })}
        customerSafe={experience.customerSafe}
        deleteTaskAction={binTask}
      />
    </div>
  );
}
