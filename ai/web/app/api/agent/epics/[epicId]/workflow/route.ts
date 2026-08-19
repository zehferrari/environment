import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  applyPmChannelRunWorkflowAction,
  recordPmChannelRunWorkflowAction,
} from "@/lib/agents/pm-channel/runs";
import { verifyEpicWorkflowToken } from "@/lib/agents/workflow/token/epic";
import { assignOpenEpicTasks, promoteEpicBacklogTasks } from "@/lib/epics/assignment";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { hasAuthorizedEpicAgentOrigin } from "@/lib/agents/owner-origin";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { publishBoardTouch } from "@/lib/pm/board-events";
import {
  completionReviewReportCanApprove,
  parseCompletionReviewReport,
  renderCompletionReviewReport,
} from "@/lib/epics/completion-review";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import { validateTaskDependency } from "@/lib/tasks/blocking";
import { submitEpicChildUpdateInTransaction } from "@/lib/epics/task-workflow-adapter";
import {
  enqueueWorkflowEffects,
  isTaskWorkflowStatus,
} from "@/lib/tasks/transition-kernel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = [
  "advance_queue",
  "assign_next",
  "create_tasks",
  "completion_review_approve",
  "completion_review_reject",
  "completion_review_retry",
  // Deploy-review actions — authorized for the epic's Deploy Reviewer (or the
  // monitor agent when none is set), NOT the acting manager.
  "deploy_review_approve",
  "deploy_review_reject",
] as const;

type EpicWorkflowAction = (typeof ACTIONS)[number];

function isWorkflowAction(value: unknown): value is EpicWorkflowAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

type RequestedCreateTask = {
  ref: string;
  title: string;
  description: string | null;
  execution: "parallel" | "dependent";
  dependsOn: string[];
};

class CreateTaskValidationError extends Error {}

function parseCreateTasks(value: unknown): RequestedCreateTask[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > 20) return null;
  const tasks = value.flatMap<RequestedCreateTask>((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const ref = cleanText(record.ref, 80);
    const title = cleanText(record.title, 220);
    const execution: RequestedCreateTask["execution"] | null = record.execution === "parallel" || record.execution === "dependent"
      ? record.execution
      : null;
    const rawDependsOn = Array.isArray(record.dependsOn) ? record.dependsOn : null;
    const dependsOn = rawDependsOn && rawDependsOn.length <= 20
      ? rawDependsOn.flatMap((entry) => {
          const dependencyRef = cleanText(entry, 160);
          return dependencyRef ? [dependencyRef] : [];
        })
      : null;
    if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref) || !title || !execution || !dependsOn || !rawDependsOn || dependsOn.length !== rawDependsOn.length) return [];
    if (new Set(dependsOn).size !== dependsOn.length) return [];
    if (execution === "parallel" && dependsOn.length !== 0) return [];
    if (execution === "dependent" && dependsOn.length === 0) return [];
    if (dependsOn.includes(ref)) return [];
    const description = typeof record.description === "string" && record.description.trim()
      ? record.description.trim().slice(0, 8000)
      : null;
    return [{ ref, title, description, execution, dependsOn }];
  });
  if (tasks.length !== value.length || new Set(tasks.map((task) => task.ref)).size !== tasks.length) return null;

  // Detect cycles among forward/local refs before any database work. Existing
  // Task refs cannot point back to not-yet-created rows, so only this local
  // graph can form a cycle during create_tasks.
  const localRefs = new Set(tasks.map((task) => task.ref));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byRef = new Map(tasks.map((task) => [task.ref, task]));
  const visit = (ref: string): boolean => {
    if (visiting.has(ref)) return false;
    if (visited.has(ref)) return true;
    visiting.add(ref);
    for (const dependencyRef of byRef.get(ref)?.dependsOn ?? []) {
      if (localRefs.has(dependencyRef) && !visit(dependencyRef)) return false;
    }
    visiting.delete(ref);
    visited.add(ref);
    return true;
  };
  return tasks.every((task) => visit(task.ref)) ? tasks : null;
}

async function notifyAssignedTask(args: {
  taskId: string;
  taskTitle: string;
  targetUserId: string;
  actor: { id: string; username: string; kind: "agent" };
  approvedPlan: boolean;
}) {
  await sendTaskWorkflowNotification({
    taskId: args.taskId,
    targetUserId: args.targetUserId,
    actor: args.actor,
    reason: "todo_start_required",
    body: [
      `Epic manager @${args.actor.username} assigned "${args.taskTitle}" to you in To Do.`,
      args.approvedPlan
        ? "Its Action Plan is already approved: move the task to In Progress through the workflow endpoint and start immediately."
        : "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. A plain chat reply is discussion only.",
      "If you have unresolved review feedback on another Review-stage task, address that feedback first; otherwise begin this task now.",
    ].join("\n"),
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ epicId: string }> },
) {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "agent-epic-workflow-route",
    entryPoint: "POST",
  });
  const { epicId } = await ctx.params;
  let payload: {
    messageId?: unknown;
    token?: unknown;
    action?: unknown;
    summary?: unknown;
    tasks?: unknown;
    reason?: unknown;
    taskId?: unknown;
    report?: unknown;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const action = payload.action;
  if (!messageId || !token || !isWorkflowAction(action)) {
    return NextResponse.json(
      { error: "messageId, token, and valid action are required" },
      { status: 400 },
    );
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      epicId: true,
      agentSlug: true,
      targetType: true,
      targetValue: true,
      senderUserId: true,
      sender: { select: { kind: true, status: true } },
    },
  });
  if (!original || original.epicId !== epicId) {
    return NextResponse.json({ error: "Workflow grant message not found" }, { status: 404 });
  }
  const grantAgentSlug =
    original.agentSlug === "room" &&
    original.targetType === "agent" &&
    original.targetValue?.startsWith("agent:")
      ? original.targetValue.slice("agent:".length)
      : original.agentSlug;
  if (!verifyEpicWorkflowToken(messageId, epicId, grantAgentSlug, token)) {
    return NextResponse.json({ error: "Invalid workflow token" }, { status: 403 });
  }
  if (!(await hasAuthorizedEpicAgentOrigin({
    epicId,
    messageId,
    targetAgentSlug: grantAgentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  }))) {
    return NextResponse.json({ error: "Workflow grant is no longer authorized" }, { status: 403 });
  }

  const [agent, epic] = await Promise.all([
    db.agent.findUnique({
      where: { slug: grantAgentSlug },
      select: {
        slug: true,
        role: true,
        deactivatedAt: true,
        user: { select: { id: true, username: true, status: true } },
      },
    }),
    db.epic.findFirst({
      where: { id: epicId, private: false },
      select: {
        id: true,
        title: true,
        status: true,
        projectId: true,
        actingManagerId: true,
        reporterId: true,
        deployReviewerId: true,
        deployReviewer: {
          select: { status: true, agent: { select: { deactivatedAt: true } } },
        },
        deploymentStatus: true,
        completionReviewStatus: true,
        completionReviewCandidateSha: true,
        approvedOn: true,
        branchName: true,
        commitPrefix: true,
        deletedAt: true,
        project: { select: { slug: true, repositoryPath: true } },
      },
    }),
  ]);

  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  if (!epic || epic.deletedAt) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const actor = {
    id: agent.user.id,
    kind: "agent" as const,
    username: agent.user.username,
  };

  // Whole-Epic acceptance is the mandatory gate between the last accepted
  // child Task and Done. It deliberately reuses the selected Deploy Reviewer
  // identity (Monitor fallback) without coupling acceptance to deployment.
  if (
    action === "completion_review_approve" ||
    action === "completion_review_reject" ||
    action === "completion_review_retry"
  ) {
    const hasActiveExplicitReviewer = Boolean(
      epic.deployReviewerId && epic.deployReviewer?.status === "active" && epic.deployReviewer.agent && !epic.deployReviewer.agent.deactivatedAt,
    );
    const isCompletionReviewer = hasActiveExplicitReviewer
      ? epic.deployReviewerId === agent.user.id
      : agent.role === "monitor";
    if (!isCompletionReviewer) {
      return NextResponse.json({ error: "Only the Epic's Deploy Reviewer (or Monitor fallback) can resolve whole-Epic acceptance" }, { status: 403 });
    }
    if (epic.status !== "Review") {
      return NextResponse.json({ error: "Epic must be in Review for whole-Epic acceptance", epicStatus: epic.status }, { status: 409 });
    }

    // WorkflowOutbox is Task-anchored. A whole-Epic acceptance turn always
    // follows at least one child Task, so use the latest live top-level child
    // as the durable aggregate for repository preparation/approval effects.
    // The effect key includes this grant's messageId, keeping retries
    // idempotent without colliding with a later acceptance cycle.
    const acceptanceAnchor = await db.task.findFirst({
      where: { epicId: epic.id, parentTaskId: null, deletedAt: null },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, workflowVersion: true },
    });
    if (!acceptanceAnchor) {
      return NextResponse.json({ error: "Whole-Epic acceptance requires at least one live child Task" }, { status: 409 });
    }

    if (action === "completion_review_retry") {
      if (epic.completionReviewStatus !== "Operational Error") {
        return NextResponse.json({ error: "Only an operationally failed acceptance preparation can be retried" }, { status: 409 });
      }
      const effectCount = await db.$transaction(async (tx) => {
        await tx.epic.update({
          where: { id: epic.id },
          data: {
            completionReviewStatus: "Preparing",
            completionReviewCandidateSha: null,
            completionReviewRequestedAt: null,
            completionReviewCompletedAt: null,
            completionReviewLastError: null,
          },
        });
        await enqueueWorkflowEffects(tx, {
          taskId: acceptanceAnchor.id,
          projectId: epic.projectId,
          aggregateVersion: acceptanceAnchor.workflowVersion,
          effects: [
            {
              type: "epic_completion_review",
              key: `completion-review-retry:${epic.id}:${messageId}`,
              payload: { epicId: epic.id },
            },
            { type: "board_touch", key: `completion-review-retry-board:${messageId}`, payload: {} },
          ],
        });
        await tx.activityLog.create({
          data: {
            projectId: epic.projectId,
            userId: agent.user!.id,
            kind: "epic.completion_review.retry",
            targetAgent: agent.slug,
            payload: JSON.stringify({ epicId: epic.id, outboxArmed: true }),
          },
        });
        await applyPmChannelRunWorkflowAction(tx, {
          epicId: epic.id,
          agentSlug: agent.slug,
          messageId,
          action,
        });
        return 2;
      });
      await drainWorkflowOutbox({ limit: effectCount }).catch((error) =>
        console.error("[pm] completion-review retry outbox drain deferred:", epic.id, error),
      );
      revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
      publishBoardTouch(epic.projectId);
      return NextResponse.json({ ok: true, epicId: epic.id, completionReviewStatus: "Preparing" });
    }

    if (epic.completionReviewStatus !== "Pending") {
      return NextResponse.json({
        error: "Epic is not awaiting a whole-Epic acceptance decision",
        completionReviewStatus: epic.completionReviewStatus,
      }, { status: 409 });
    }
    const report = parseCompletionReviewReport(payload.report);
    if (!report) {
      return NextResponse.json({
        error: "report requires summary, 1-50 requirement rows, 1-30 validation rows, and residualRisks; every row requires evidence and Pass/Partial/Fail status",
      }, { status: 400 });
    }

    if (action === "completion_review_approve") {
      if (!completionReviewReportCanApprove(report)) {
        return NextResponse.json({ error: "Approval requires every requirement and combined validation check to be Pass; use completion_review_reject" }, { status: 400 });
      }
      const reportBody = renderCompletionReviewReport(report, "APPROVED");
      const effectCount = await db.$transaction(async (tx) => {
        await tx.epic.update({
          where: { id: epic.id },
          data: { completionReviewStatus: "Approval Pending", completionReviewLastError: null },
        });
        await tx.agentChatMessage.create({
          data: {
            projectId: epic.projectId,
            taskId: null,
            epicId: epic.id,
            agentSlug: "room",
            senderUserId: agent.user!.id,
            body: reportBody,
            allowDescriptionEdit: false,
            originChannel: "chat",
          },
        });
        await tx.activityLog.create({
          data: {
            projectId: epic.projectId,
            userId: agent.user!.id,
            kind: "epic.completion_review.approval_requested",
            targetAgent: agent.slug,
            payload: JSON.stringify({
              epicId: epic.id,
              candidateSha: epic.completionReviewCandidateSha,
              report,
            }),
          },
        });
        await enqueueWorkflowEffects(tx, {
          taskId: acceptanceAnchor.id,
          projectId: epic.projectId,
          aggregateVersion: acceptanceAnchor.workflowVersion,
          effects: [
            {
              type: "epic_completion_review_approval",
              key: `completion-review-approval:${epic.id}:${messageId}`,
              payload: {
                epicId: epic.id,
                requestedByUserId: agent.user!.id,
                requestedByUsername: agent.slug,
                expectedCandidateSha: epic.completionReviewCandidateSha,
              },
            },
            { type: "board_touch", key: `completion-review-approval-board:${messageId}`, payload: {} },
          ],
        });
        await applyPmChannelRunWorkflowAction(tx, {
          epicId: epic.id,
          agentSlug: agent.slug,
          messageId,
          action,
        });
        return 2;
      });
      await drainWorkflowOutbox({ limit: effectCount }).catch((error) =>
        console.error("[pm] completion-review approval outbox drain deferred:", epic.id, error),
      );
      revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
      publishBoardTouch(epic.projectId);
      return NextResponse.json({
        ok: true,
        epicId: epic.id,
        epicStatus: "Review",
        completionReviewStatus: "Approval Pending",
        candidateSha: epic.completionReviewCandidateSha,
      });
    }

    // completion_review_reject: reopen one implicated task, or create one
    // narrowly-scoped repair task when the issue belongs to the combined Epic.
    const requestedTaskId = cleanText(payload.taskId, 100);
    const flaggedTask = requestedTaskId
      ? await db.task.findFirst({
          where: { id: requestedTaskId, epicId: epic.id, parentTaskId: null, deletedAt: null },
          select: { id: true, title: true, status: true, assigneeId: true, workflowVersion: true },
        })
      : null;
    if (requestedTaskId && !flaggedTask) {
      return NextResponse.json({ error: "taskId must reference a live top-level child task of this Epic" }, { status: 400 });
    }
    if (flaggedTask && !isTaskWorkflowStatus(flaggedTask.status)) {
      return NextResponse.json({ error: "Flagged task has an unsupported workflow status" }, { status: 409 });
    }
    const reportBody = renderCompletionReviewReport(report, "CHANGES REQUESTED");
    const now = new Date();
    const repair = await db.$transaction(async (tx) => {
      await tx.epic.update({
        where: { id: epic.id },
        data: {
          status: "In Progress",
          statusChangedAt: now,
          completionReviewStatus: "Changes Requested",
          completionReviewCompletedAt: now,
          completionReviewLastError: null,
        },
      });
      const minRank = await tx.task.aggregate({
        where: { projectId: epic.projectId, status: "To Do", deletedAt: null },
        _min: { rank: true },
      });
      let task: {
        id: string;
        title: string;
        assigneeId: string | null;
        workflowVersion: number;
        created: boolean;
      };
      if (flaggedTask) {
        const notification = flaggedTask.assigneeId
          ? {
              targetUserId: flaggedTask.assigneeId,
              reason: "review_feedback",
              body: [
                `Whole-Epic acceptance returned "${flaggedTask.title}" to To Do at the front of the queue.`,
                "Read the structured acceptance report on the task, add checklist items for every finding, and address it before other work.",
                "Call action=submit_plan with a revised structured Action Plan and move the task through its normal start/review lifecycle. A new combined candidate review will run after every Epic task is Done again.",
                "Do not post an acknowledgement-only response.",
              ].join("\n"),
            }
          : null;
        const childUpdate = await submitEpicChildUpdateInTransaction(tx, {
          taskId: flaggedTask.id,
          workflowVersion: flaggedTask.workflowVersion,
          actor: { ...actor, role: "operator" },
          source: "agent",
          idempotencyKey: `completion-review-reject:${messageId}:v${flaggedTask.workflowVersion}`,
          payload: {
            epicId: epic.id,
            targetStatus: "To Do",
            reason: "completion_review_reject",
            rank: "front",
            clearAssignee: false,
            clearArchive: true,
            archive: false,
            resetPlanApproval: true,
            comment: `Whole-Epic acceptance review returned this task for repair:\n\n${reportBody}`,
            notification,
          },
          evidence: { epicId: epic.id, candidateSha: epic.completionReviewCandidateSha },
        });
        task = {
          id: flaggedTask.id,
          title: flaggedTask.title,
          assigneeId: flaggedTask.assigneeId,
          workflowVersion: childUpdate.workflowVersion,
          created: false,
        };
      } else {
        const created = await tx.task.create({
          data: {
            projectId: epic.projectId,
            epicId: epic.id,
            parentTaskId: null,
            workItemKey: await allocateWorkItemKey(epic.projectId, tx),
            title: "Address whole-Epic acceptance review findings",
            description: reportBody.slice(0, 8000),
            status: "To Do",
            statusChangedAt: now,
            rank: (minRank._min.rank ?? 0) - 1,
            reporterId: epic.reporterId,
            actingManagerId: null,
            branchName: null,
            commitPrefix: null,
          },
          select: { id: true, title: true, assigneeId: true, workflowVersion: true },
        });
        await tx.activityLog.create({
          data: {
            projectId: epic.projectId,
            taskId: created.id,
            userId: agent.user!.id,
            kind: "task.create",
            targetAgent: agent.slug,
            payload: JSON.stringify({ epicId: epic.id, via: "completion_review_reject" }),
          },
        });
        task = { ...created, created: true };
        const assignment = await assignOpenEpicTasks(tx, {
          epicId: epic.id,
          projectId: epic.projectId,
          actorUserId: agent.user!.id,
          excludeUserIds: [agent.user!.id, epic.reporterId, epic.actingManagerId],
          via: "completion_review_reject",
        });
        const assignedRepair = assignment.assignments.find((row) => row.task.id === created.id);
        if (assignedRepair) task.assigneeId = assignedRepair.worker.id;
        const effects = [
          ...(task.assigneeId ? [{
            type: "task_notification" as const,
            key: `completion-review-repair-notify:${messageId}`,
            payload: {
              taskId: task.id,
              targetUserId: task.assigneeId,
              actor,
              reason: "review_feedback",
              body: [
                `Whole-Epic acceptance created and assigned repair task "${task.title}" in To Do.`,
                "Read the structured acceptance report in the task, call action=submit_plan with one structured technical Action Plan, and wait for reviewer approval before starting.",
                "Completing the repair will produce a new frozen combined candidate and a fresh whole-Epic review.",
                "Do not post an acknowledgement-only response.",
              ].join("\n"),
            },
          }] : []),
          { type: "board_touch" as const, key: `completion-review-repair-board:${messageId}`, payload: {} },
        ];
        await enqueueWorkflowEffects(tx, {
          taskId: task.id,
          projectId: epic.projectId,
          aggregateVersion: task.workflowVersion,
          effects,
        });
      }
      await tx.agentChatMessage.create({
        data: {
          projectId: epic.projectId,
          taskId: null,
          epicId: epic.id,
          agentSlug: "room",
          senderUserId: agent.user!.id,
          body: `${reportBody}\n\nRepair task: ${task.title} (${task.id})`,
          allowDescriptionEdit: false,
          originChannel: "chat",
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.completion_review.reject",
          targetAgent: agent.slug,
          payload: JSON.stringify({ epicId: epic.id, taskId: task.id, candidateSha: epic.completionReviewCandidateSha, report }),
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.status",
          targetAgent: agent.slug,
          payload: JSON.stringify({ epicId: epic.id, from: "Review", to: "In Progress", via: "completion_review_reject" }),
        },
      });
      await applyPmChannelRunWorkflowAction(tx, {
        epicId: epic.id,
        agentSlug: agent.slug,
        messageId,
        action,
      });
      return { ...task, effectCount: task.assigneeId ? 2 : 1 };
    });
    await drainWorkflowOutbox({ limit: repair.effectCount }).catch((error) =>
      console.error("[pm] completion-review rejection outbox drain deferred:", epic.id, error),
    );
    revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
    revalidatePath(`/projects/${epic.project.slug}/tasks/${repair.id}`);
    publishBoardTouch(epic.projectId);
    return NextResponse.json({
      ok: true,
      epicId: epic.id,
      epicStatus: "In Progress",
      completionReviewStatus: "Changes Requested",
      repairTaskId: repair.id,
      repairTaskCreated: repair.created,
    });
  }

  // Deploy-review actions belong to the epic's Deploy Reviewer (or the monitor
  // agent when none is set) — a distinct role from the acting manager who runs
  // the queue actions below.
  if (action === "deploy_review_approve" || action === "deploy_review_reject") {
    const hasActiveExplicitReviewer = Boolean(
      epic.deployReviewerId && epic.deployReviewer?.status === "active" && epic.deployReviewer.agent && !epic.deployReviewer.agent.deactivatedAt,
    );
    const isDeployReviewer = hasActiveExplicitReviewer
      ? epic.deployReviewerId === agent.user.id
      : agent.role === "monitor";
    if (!isDeployReviewer) {
      return NextResponse.json({ error: "Only the Epic's deploy reviewer (or the monitor agent) can review the deployment" }, { status: 403 });
    }
    if (epic.deploymentStatus !== "Ready to Deploy") {
      return NextResponse.json({
        error: "Epic is not awaiting deploy review",
        deploymentStatus: epic.deploymentStatus,
      }, { status: 409 });
    }

    if (action === "deploy_review_approve") {
      await db.$transaction(async (tx) => {
        await tx.epic.update({
          where: { id: epic.id },
          data: { deploymentStatus: "Deployment Approved" },
        });
        await tx.agentChatMessage.create({
          data: {
            projectId: epic.projectId,
            taskId: null,
            epicId: epic.id,
            agentSlug: "room",
            senderUserId: agent.user!.id,
            body: [
              `Deploy reviewer @${agent.slug} APPROVED this Epic's contribution for merge.`,
              "The post-acceptance deployment review found no unresolved rollout, migration, configuration, security, or data-integrity risk.",
              "Awaiting the merge to the production branch; the deployment will resolve automatically once the work lands there.",
            ].join("\n"),
            allowDescriptionEdit: false,
            originChannel: "chat",
          },
        });
        await tx.activityLog.create({
          data: {
            projectId: epic.projectId,
            userId: agent.user!.id,
            kind: "epic.deploy_review.approve",
            targetAgent: agent.slug,
            payload: JSON.stringify({ epicId: epic.id, from: "Ready to Deploy", to: "Deployment Approved" }),
          },
        });
        await applyPmChannelRunWorkflowAction(tx, {
          epicId: epic.id,
          agentSlug: agent.slug,
          messageId,
          action,
        });
      });
      revalidatePath(`/projects/${epic.project.slug}`);
      revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
      publishBoardTouch(epic.projectId);
      return NextResponse.json({ ok: true, epicId: epic.id, deploymentStatus: "Deployment Approved" });
    }

    // deploy_review_reject
    const reason = cleanText(payload.reason, 8000);
    const flaggedTaskId = cleanText(payload.taskId, 100);
    if (!reason) {
      return NextResponse.json({ error: "reason is required for deploy_review_reject" }, { status: 400 });
    }
    let flaggedTask: {
      id: string;
      title: string;
      status: string;
      assigneeId: string | null;
      workflowVersion: number;
    } | null = null;
    if (flaggedTaskId) {
      flaggedTask = await db.task.findFirst({
        where: { id: flaggedTaskId, epicId: epic.id, deletedAt: null },
        select: { id: true, title: true, status: true, assigneeId: true, workflowVersion: true },
      });
      if (!flaggedTask) {
        return NextResponse.json({ error: "taskId must reference a task of this Epic" }, { status: 400 });
      }
    }

    const now = new Date();
    if (flaggedTask && !isTaskWorkflowStatus(flaggedTask.status)) {
      return NextResponse.json({ error: "Flagged task has an unsupported workflow status" }, { status: 409 });
    }
    await db.$transaction(async (tx) => {
      // The Epic drops out of the deploy gate and re-opens for work.
      await tx.epic.update({
        where: { id: epic.id },
        data: { status: "To Do", statusChangedAt: now, deploymentStatus: "Not Required" },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.status",
          payload: JSON.stringify({ epicId: epic.id, from: epic.status, to: "To Do", via: "deploy_review_reject" }),
        },
      });
      if (flaggedTask) {
        const notification = flaggedTask.assigneeId
          ? {
              targetUserId: flaggedTask.assigneeId,
              reason: "review_feedback",
              body: [
                `Deploy review flagged "${flaggedTask.title}" and moved it back to To Do (front of the queue).`,
                "The whole-contribution deploy review found an issue with this task before merge. Read the reviewer's comment on the task for the technical reason.",
                "Address it before starting or resuming any other task, then move it back through Review through the workflow endpoint.",
                "Do not post an acknowledgement-only response.",
              ].join("\n"),
            }
          : null;
        await submitEpicChildUpdateInTransaction(tx, {
          taskId: flaggedTask.id,
          workflowVersion: flaggedTask.workflowVersion,
          actor: { ...actor, role: "operator" },
          source: "agent",
          idempotencyKey: `deploy-review-reject:${messageId}:v${flaggedTask.workflowVersion}`,
          payload: {
            epicId: epic.id,
            targetStatus: "To Do",
            reason: "deploy_review_reject",
            rank: "front",
            clearAssignee: false,
            clearArchive: true,
            archive: false,
            resetPlanApproval: false,
            comment: `Deploy review flagged this task and returned it to To Do:\n\n${reason}`,
            notification,
          },
          evidence: { epicId: epic.id, candidateSha: epic.completionReviewCandidateSha },
        });
      }
      await tx.agentChatMessage.create({
        data: {
          projectId: epic.projectId,
          taskId: null,
          epicId: epic.id,
          agentSlug: "room",
          senderUserId: agent.user!.id,
          body: [
            `Deploy reviewer @${agent.slug} REJECTED this Epic's contribution.`,
            flaggedTask ? `Flagged task returned to To Do: ${flaggedTask.title}` : "No single task was flagged; the Epic returns to To Do for rework.",
            "",
            "Reason:",
            reason,
          ].join("\n"),
          allowDescriptionEdit: false,
          originChannel: "chat",
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.deploy_review.reject",
          targetAgent: agent.slug,
          payload: JSON.stringify({ epicId: epic.id, taskId: flaggedTask?.id ?? null, reason }),
        },
      });
      await applyPmChannelRunWorkflowAction(tx, {
        epicId: epic.id,
        agentSlug: agent.slug,
        messageId,
        action,
      });
    });
    revalidatePath(`/projects/${epic.project.slug}`);
    revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
    if (flaggedTask) revalidatePath(`/projects/${epic.project.slug}/tasks/${flaggedTask.id}`);
    publishBoardTouch(epic.projectId);
    return NextResponse.json({
      ok: true,
      epicId: epic.id,
      epicStatus: "To Do",
      deploymentStatus: "Not Required",
      bouncedTaskId: flaggedTask?.id ?? null,
    });
  }

  // All remaining actions are Epic-manager actions.
  if (epic.actingManagerId !== agent.user.id) {
    return NextResponse.json({ error: "Only the Epic acting manager can use this workflow" }, { status: 403 });
  }

  if (action === "create_tasks") {
    const summary = cleanText(payload.summary, 4000);
    const requestedTasks = parseCreateTasks(payload.tasks);
    if (!summary || !requestedTasks) {
      return NextResponse.json({
        error: "summary and 1-20 valid tasks are required. Every task needs a unique ref, title, execution=parallel|dependent, and dependsOn (empty for parallel; non-empty for dependent).",
      }, { status: 400 });
    }

    let created: Array<{ id: string; ref: string; title: string; workItemKey: string | null }>;
    try {
      created = await db.$transaction(async (tx) => {
        const localRefs = new Set(requestedTasks.map((task) => task.ref));
        const externalRefs = [...new Set(requestedTasks.flatMap((task) => task.dependsOn))]
          .filter((ref) => !localRefs.has(ref));
        const resolvedExternal = new Map<string, string>();
        for (const ref of externalRefs) {
          const prerequisite = await tx.task.findFirst({
            where: {
              deletedAt: null,
              OR: [{ id: ref }, { workItemKey: ref }],
            },
            select: { id: true },
          });
          if (!prerequisite) {
            throw new CreateTaskValidationError(`Prerequisite ${ref} is unavailable.`);
          }
          resolvedExternal.set(ref, prerequisite.id);
        }

        const maxRank = await tx.task.aggregate({
          where: { projectId: epic.projectId, status: "Backlog", archivedAt: null, deletedAt: null },
          _max: { rank: true },
        });
        let nextRank = (maxRank._max.rank ?? 0) + 1;
        const now = new Date();
        const rows: Array<{ id: string; ref: string; title: string; workItemKey: string | null }> = [];
        const rowByRef = new Map<string, { id: string; ref: string; title: string; workItemKey: string | null }>();
        for (const task of requestedTasks) {
          const title = await nextEpicTaskTitle(epic.id, task.title, tx);
          const row = await tx.task.create({
            data: {
              projectId: epic.projectId,
              epicId: epic.id,
              parentTaskId: null,
              workItemKey: await allocateWorkItemKey(epic.projectId, tx),
              title,
              description: task.description,
              status: "Backlog",
              rank: nextRank++,
              statusChangedAt: now,
              // Leave the task reviewer unstamped: resolveReviewOwnerId falls
              // back to the epic's CURRENT acting manager while the epic is In
              // Progress. Stamping the manager here froze a stale reference when
              // the human later swapped or deactivated the manager.
              actingManagerId: null,
              reporterId: epic.reporterId ?? null,
              branchName: null,
              commitPrefix: null,
            },
            select: { id: true, title: true, workItemKey: true },
          });
          const referencedRow = { ...row, ref: task.ref };
          rows.push(referencedRow);
          rowByRef.set(task.ref, referencedRow);
          await tx.activityLog.create({
            data: {
              projectId: epic.projectId,
              taskId: row.id,
              userId: agent.user!.id,
              kind: "task.create",
              payload: JSON.stringify({
                title: row.title,
                epicId: epic.id,
                via: "epic-manager-workflow",
                action,
                ref: task.ref,
                execution: task.execution,
                dependsOn: task.dependsOn,
              }),
            },
          });
        }

        const edges: Array<{ taskId: string; prerequisiteTaskId: string }> = [];
        for (const task of requestedTasks) {
          const dependent = rowByRef.get(task.ref)!;
          for (const dependencyRef of task.dependsOn) {
            const prerequisiteTaskId = rowByRef.get(dependencyRef)?.id ?? resolvedExternal.get(dependencyRef);
            if (!prerequisiteTaskId) {
              throw new CreateTaskValidationError(`Prerequisite ${dependencyRef} is unavailable.`);
            }
            const validation = await validateTaskDependency({
              taskId: dependent.id,
              projectId: epic.projectId,
              prerequisiteTaskId,
              allowSharedWorkspace: true,
              client: tx,
            });
            if (!validation.ok) throw new CreateTaskValidationError(`${dependencyRef}: ${validation.message}`);
            edges.push({ taskId: dependent.id, prerequisiteTaskId });
          }
        }
        if (edges.length > 0) {
          await tx.taskDependency.createMany({ data: edges });
        }

        await tx.agentChatMessage.create({
        data: {
          projectId: epic.projectId,
          taskId: null,
          epicId: epic.id,
          agentSlug: "room",
          senderUserId: agent.user!.id,
          body: [
            `Epic manager @${agent.slug} created ${rows.length} new Backlog task${rows.length === 1 ? "" : "s"}.`,
            "A human must still approve/open the Epic before the manager can advance the queue or assign workers.",
            "",
            summary,
            "",
            ...rows.map((row) => {
              const request = requestedTasks.find((task) => task.ref === row.ref)!;
              const dependencyText = request.dependsOn.length > 0
                ? ` — waits for ${request.dependsOn.join(", ")}`
                : " — parallel-ready";
              return `- ${row.workItemKey ?? row.id} [${row.ref}]: ${row.title}${dependencyText}`;
            }),
          ].join("\n"),
          allowDescriptionEdit: false,
          originChannel: "chat",
        },
      });
        await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.manager.create_tasks",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            epicId: epic.id,
            summary,
            taskIds: rows.map((row) => row.id),
            dependencies: requestedTasks.map((task) => ({ ref: task.ref, dependsOn: task.dependsOn })),
            status: epic.status,
            approvalCleared: false,
            epicStatusChanged: false,
          }),
        },
      });
        return rows;
      }, { timeout: 20_000 });
    } catch (error) {
      if (error instanceof CreateTaskValidationError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }

    await recordPmChannelRunWorkflowAction({
      epicId: epic.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    revalidatePath(`/projects/${epic.project.slug}`);
    revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
    publishBoardTouch(epic.projectId);
    return NextResponse.json({ ok: true, epicId: epic.id, status: epic.status, tasks: created });
  }

  if (!epic.approvedOn || !(epic.status === "In Progress" || epic.status === "To Do")) {
    return NextResponse.json({
      error: "Epic must be To Do or In Progress and human-approved before the manager can advance the queue",
      currentStatus: epic.status,
      approved: Boolean(epic.approvedOn),
    }, { status: 409 });
  }

  const promoted = action === "advance_queue"
    ? await db.$transaction((tx) =>
        promoteEpicBacklogTasks(tx, {
          epicId: epic.id,
          projectId: epic.projectId,
          actorUserId: agent.user!.id,
          via: "epic-manager-workflow",
        }),
      )
    : [];

  const assignment = await db.$transaction((tx) =>
    assignOpenEpicTasks(tx, {
      epicId: epic.id,
      projectId: epic.projectId,
      actorUserId: agent.user!.id,
      excludeUserIds: [epic.actingManagerId, epic.reporterId],
      via: "epic-manager-workflow",
    }),
  );

  await recordPmChannelRunWorkflowAction({
    epicId: epic.id,
    agentSlug: agent.slug,
    messageId,
    action,
  });

  for (const assigned of assignment.assignments) {
    await notifyAssignedTask({
      taskId: assigned.task.id,
      taskTitle: assigned.task.title,
      targetUserId: assigned.worker.id,
      actor,
      approvedPlan: assigned.approvedPlan,
    });
  }

  revalidatePath(`/projects/${epic.project.slug}`);
  revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
  for (const assigned of assignment.assignments) {
    revalidatePath(`/projects/${epic.project.slug}/tasks/${assigned.task.id}`);
  }
  publishBoardTouch(epic.projectId);

  const first = assignment.assignments[0] ?? null;
  return NextResponse.json({
    ok: true,
    epicId: epic.id,
    promotedTaskIds: promoted.map((task) => task.id),
    assignments: assignment.assignments.map((assigned) => ({
      task: { id: assigned.task.id, title: assigned.task.title },
      assignedTo: { id: assigned.worker.id, username: assigned.worker.username },
    })),
    nextTask: first ? { id: first.task.id, title: first.task.title } : null,
    assignedTo: first
      ? { id: first.worker.id, username: first.worker.username }
      : null,
    skipped: assignment.skipped,
  });
}
