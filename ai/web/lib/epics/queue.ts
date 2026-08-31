// Proactive epic queue refill: assign unassigned, unblocked To Do tasks to
// every free pool worker and wake each assignee. This is the single engine
// entry point fired by every "a worker may have just become free" or "the
// queue may have new work" event: task Done, ready_for_review, human
// unassign/pull-back, epic action-plan approval.
import { db } from "@/lib/db";
import { hasImmutableOwnerCapability } from "@/lib/auth/roles";
import { assignOpenEpicTasks, type PolicyEvidenceTrigger } from "@/lib/epics/assignment";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { unresolvedTaskPrerequisites } from "@/lib/tasks/blocking";
import { startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";

type Actor = {
  id: string;
  username?: string | null;
  kind: "human" | "agent";
};

export async function refillEpicQueue(args: {
  epicId: string;
  actor: Actor;
  via: string;
  // 2b: the worker that just freed itself (e.g. moved its task to Review) —
  // preferred for the Epic's next unblocked task so the same agent keeps going.
  preferUserId?: string | null;
  // Optional first line for the assignee notification, e.g. what event freed
  // the queue ("Previous epic task X was accepted...").
  contextLine?: string;
  trigger?: PolicyEvidenceTrigger;
}) {
  const epic = await db.epic.findFirst({
    where: { id: args.epicId, deletedAt: null, private: false },
    select: {
      id: true,
      status: true,
      approvedOn: true,
      projectId: true,
      actingManagerId: true,
      reporterId: true,
      project: { select: { slug: true } },
    },
  });
  // A To Do epic is approved and queued (its tasks can be assigned before any
  // has started); an In Progress epic already has work underway. Both feed the
  // queue. Backlog/Done epics do not.
  if (!epic || !(epic.status === "In Progress" || epic.status === "To Do") || !epic.approvedOn) {
    return { assignments: [], skipped: "epic_not_ready" as const, epic: null };
  }

  const assignment = await db.$transaction((tx) =>
    assignOpenEpicTasks(tx, {
      epicId: epic.id,
      projectId: epic.projectId,
      actorUserId: args.actor.id,
      excludeUserIds: [epic.actingManagerId, epic.reporterId],
      preferUserId: args.preferUserId,
      via: args.via,
      notificationContextLine: args.contextLine,
      trigger: args.trigger,
    }),
  );

  return { ...assignment, epic };
}

// A completed prerequisite can unlock tasks outside its own Epic (including a
// different project in the same Workspace). Refill every affected queue from a
// durable outbox effect instead of relying on whichever UI/API path marked the
// prerequisite Done.
export async function refillDependentEpicQueuesForDoneTask(args: {
  prerequisiteTaskId: string;
  actorUserId?: string | null;
  trigger?: PolicyEvidenceTrigger;
}) {
  const prerequisite = await db.task.findUnique({
    where: { id: args.prerequisiteTaskId },
    select: {
      status: true,
      workItemKey: true,
      blocking: {
        where: { deletedAt: null, archivedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          epicId: true,
          assigneeId: true,
          approvedOn: true,
          blockedById: true,
          blockedBy: { select: { id: true, status: true, workItemKey: true } },
          dependencies: { select: { prerequisite: { select: { id: true, status: true, workItemKey: true } } } },
        },
      },
      dependents: {
        where: { task: { deletedAt: null, archivedAt: null } },
        select: {
          task: {
            select: {
              id: true,
              title: true,
              status: true,
              epicId: true,
              assigneeId: true,
              approvedOn: true,
              blockedById: true,
              blockedBy: { select: { id: true, status: true, workItemKey: true } },
              dependencies: { select: { prerequisite: { select: { id: true, status: true, workItemKey: true } } } },
            },
          },
        },
      },
    },
  });
  if (!prerequisite || prerequisite.status !== "Done") {
    return { refilledEpicIds: [], skipped: "prerequisite_not_done" as const };
  }

  const dependentById = new Map([
    ...prerequisite.blocking.map((task) => [task.id, task] as const),
    ...prerequisite.dependents.map((edge) => [edge.task.id, edge.task] as const),
  ]);
  const newlyEligible = [...dependentById.values()].filter(
    (task) => task.status === "To Do" && unresolvedTaskPrerequisites(task).length === 0,
  );
  if (newlyEligible.length === 0) return { refilledEpicIds: [], skipped: "no_newly_eligible_tasks" as const };
  const epicIds = [...new Set(newlyEligible.map((task) => task.epicId).filter((id): id is string => Boolean(id)))];

  const requestedActor = args.actorUserId
    ? await db.user.findFirst({
        where: { id: args.actorUserId, status: "active" },
        select: { id: true, username: true, kind: true, isOwner: true },
      })
    : null;
  const requestedActorUsable = Boolean(
    requestedActor && (requestedActor.kind === "agent" || hasImmutableOwnerCapability(requestedActor)),
  );
  const fallbackActor = requestedActorUsable ? null : await db.user.findFirst({
    where: { status: "active", OR: [{ isOwner: true }, { agent: { role: "monitor", deactivatedAt: null } }] },
    orderBy: [{ isOwner: "desc" }, { createdAt: "asc" }],
    select: { id: true, username: true, kind: true, isOwner: true },
  });
  const usableActor = requestedActorUsable ? requestedActor : fallbackActor;
  if (!usableActor) throw new Error("No active workflow actor can refill dependent Epic queues.");
  const actor: Actor = {
    id: usableActor.id,
    username: usableActor.username,
    kind: usableActor.kind === "agent" ? "agent" : "human",
  };

  for (const epicId of epicIds) {
    await refillEpicQueue({
      epicId,
      actor,
      via: "dependency-completed",
      trigger: args.trigger ?? {
        kind: "policy_event",
        id: `dependency:${args.prerequisiteTaskId}`,
      },
      contextLine: `Prerequisite ${prerequisite.workItemKey ?? args.prerequisiteTaskId} is Done; this task is now eligible if all other prerequisites are also Done.`,
    });
  }

  // A human may have deliberately assigned a blocked Task before its
  // prerequisites cleared. It is not an open queue claim, so refill cannot
  // rediscover it. Approved tasks enter through the same PM-service start
  // command as plan auto-start; unapproved/busy tasks receive a deduplicated
  // wake only and remain in To Do.
  for (const task of newlyEligible.filter((candidate) => candidate.assigneeId)) {
    if (task.approvedOn) {
      const autoStart = await startApprovedTodoTaskIfIdle({
        taskId: task.id,
        actor,
        via: "dependency-completed",
        trigger: args.trigger ?? {
          kind: "policy_event",
          id: `dependency:${args.prerequisiteTaskId}:${task.id}`,
        },
        selectionReason: "all_prerequisites_done_for_preassigned_approved_task",
      });
      if (autoStart.started) continue;
      if (autoStart.reason === "command_rejected") {
        const rejection = autoStart.commandResult;
        const detail = rejection && "reason" in rejection ? rejection.reason : "unknown";
        throw new Error(
          `dependency_release_start_rejected:${task.id}:${rejection?.status ?? "unknown"}:${detail}`,
        );
      }
    }
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId!,
      actor,
      reason: "todo_start_required",
      dedupeKey: `dependency-unlocked:${args.prerequisiteTaskId}:${task.id}`,
      body: [
        `All prerequisites for "${task.title}" are now Done.`,
        task.approvedOn
          ? "Its Action Plan is approved: call action=start and continue now."
          : "Submit one structured technical Action Plan and wait for approval before starting.",
      ].join("\n"),
    });
  }
  return { refilledEpicIds: epicIds, skipped: null };
}
