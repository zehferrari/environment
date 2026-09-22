import { revalidatePath } from "next/cache";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import { normalizePublicAction } from "@/lib/tasks/orchestrator/normalize";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";
import { loadTaskAggregate } from "@/lib/tasks/orchestrator/state";
import {
  DOMAIN_ERROR_HTTP_STATUS,
  RESULT_HTTP_STATUS,
  WORKFLOW_PUBLIC_ACTIONS,
  type OrchestratorResult,
  type WorkflowActorRole,
  type WorkflowPublicAction,
  type WorkflowSubtaskKind,
} from "@/lib/tasks/orchestrator/types";
import {
  ENGINE_ORCHESTRATOR_V2,
} from "@/lib/tasks/orchestrator/ownership";
import {
  blockerDiagnosticsFingerprint,
  blockerFailureSignature,
  classifyBlockerFailure,
  formalBlockerReportFromValue,
} from "@/lib/tasks/formal-blocker";
import { recordWorkflowActionExecutionState } from "@/lib/agents/watchdog/transitions";
import { canonicalize } from "@/lib/tasks/orchestrator/receipts";

/** Public actions accepted by the agent transport. Human-only override_status
 * remains in the shared public vocabulary for browser/operator transports. */
export const AGENT_WORKFLOW_PUBLIC_ACTIONS = WORKFLOW_PUBLIC_ACTIONS.filter(
  (action): action is Exclude<WorkflowPublicAction, "override_status"> => action !== "override_status",
);

export type AgentWorkflowPublicAction = (typeof AGENT_WORKFLOW_PUBLIC_ACTIONS)[number];

export function isAgentWorkflowPublicAction(value: unknown): value is AgentWorkflowPublicAction {
  return typeof value === "string" && AGENT_WORKFLOW_PUBLIC_ACTIONS.includes(value as AgentWorkflowPublicAction);
}

export type AgentWorkflowHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

export function mapOrchestratorResultToAgentHttp(args: {
  taskId: string;
  action: AgentWorkflowPublicAction;
  taskStatus: string;
  result: OrchestratorResult;
}): AgentWorkflowHttpResult {
  const { result } = args;
  const domainCode = "domainCode" in result ? result.domainCode : undefined;
  const status = domainCode
    ? (DOMAIN_ERROR_HTTP_STATUS.get(domainCode) ?? RESULT_HTTP_STATUS.get(result.status) ?? 500)
    : (RESULT_HTTP_STATUS.get(result.status) ?? 500);

  if (result.status !== "accepted" && result.status !== "replayed") {
    return {
      status,
      body: {
        error: result.reason,
        code: domainCode ?? "operational_error",
        orchestratorStatus: result.status,
        ...(result.status === "invalid" && result.details ? { details: result.details } : {}),
      },
    };
  }

  return {
    status,
    body: {
      ok: true,
      taskId: args.taskId,
      status: result.taskState ?? args.taskStatus,
      taskState: result.taskState ?? args.taskStatus,
      orchestratorStatus: result.status,
      workflowVersion: result.workflowVersion,
      transitionId: result.transitionId,
      procedureId: result.procedureId ?? null,
      cycleId: result.cycleId ?? null,
      ...(result.actionEffect ? { actionEffect: result.actionEffect } : {}),
      ...(result.episode !== undefined ? { episode: result.episode } : {}),
      ...(result.episode
        ? {
            episodeNo: result.episode.episodeNo,
            episodeBudgetExhausted: result.episode.cyclesRemaining === 0 || result.episode.rolledOver,
            episodeClosed: result.episode.rolledOver,
          }
        : {}),
      ...(result.checkpoint !== undefined ? { checkpoint: result.checkpoint } : {}),
      ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
      ...(result.disposition !== undefined ? { disposition: result.disposition } : {}),
      ...(result.turnComplete !== undefined ? { turnComplete: result.turnComplete } : {}),
      ...(result.successorScheduled !== undefined ? { successorScheduled: result.successorScheduled } : {}),
      publicAction: args.action,
    },
  };
}

type CacheDecoratorDependencies = {
  revalidateTaskReplyScope: typeof revalidateTaskReplyScope;
  revalidateTaskShell: typeof revalidateTaskShell;
  revalidatePath: typeof revalidatePath;
};

const DEFAULT_CACHE_DEPENDENCIES: CacheDecoratorDependencies = {
  revalidateTaskReplyScope,
  revalidateTaskShell,
  revalidatePath,
};

/** Cache projection only. It deliberately has no Prisma, watcher, outbox or
 * board-event dependency, and failures cannot change the stored command result. */
export function decorateAuthoritativeAgentResponseCache(
  args: { taskId: string; projectSlug: string },
  dependencies: CacheDecoratorDependencies = DEFAULT_CACHE_DEPENDENCIES,
): void {
  try {
    dependencies.revalidateTaskReplyScope(args.taskId, "comment");
    dependencies.revalidateTaskReplyScope(args.taskId, "chat");
    dependencies.revalidateTaskShell(args.taskId);
    dependencies.revalidatePath(`/projects/${args.projectSlug}/tasks/${args.taskId}`);
    dependencies.revalidatePath(`/projects/${args.projectSlug}`);
  } catch (error) {
    console.error("[pm] authoritative workflow cache decoration failed:", error);
  }
}

function actorRole(args: {
  registryRole: string;
  actorId: string;
  assigneeId: string | null;
  reviewOwnerId: string | null;
  reporterId: string | null;
}): WorkflowActorRole {
  if (args.registryRole === "monitor") return "monitor";
  if (args.actorId === args.assigneeId) return "assignee";
  if (args.actorId === args.reviewOwnerId) return "reviewer";
  if (args.actorId === args.reporterId) return "reporter";
  return null;
}

async function resolveExpectedEpisodeId(args: {
  taskId: string;
  agentSlug: string;
  messageId: string;
}): Promise<string | null> {
  const sourceEpisode = await db.taskExecutionEpisode.findFirst({
    where: {
      taskId: args.taskId,
      agentSlug: args.agentSlug,
      exhaustedByMessageId: args.messageId,
    },
    orderBy: { episodeNo: "desc" },
    select: { id: true },
  });
  if (sourceEpisode) return sourceEpisode.id;
  const openEpisode = await db.taskExecutionEpisode.findFirst({
    where: { taskId: args.taskId, agentSlug: args.agentSlug, status: "open" },
    orderBy: { episodeNo: "desc" },
    select: { id: true },
  });
  return openEpisode?.id ?? null;
}

export async function submitAuthoritativeAgentWorkflowAction(args: {
  taskId: string;
  action: AgentWorkflowPublicAction;
  rawBody: Record<string, unknown>;
  messageId: string;
  pmChannelRunId: string | null;
  agent: {
    id: string;
    username: string;
    slug: string;
    registryRole: string;
  };
}): Promise<AgentWorkflowHttpResult> {
  const aggregate = await loadTaskAggregate(args.taskId);
  if (!aggregate) {
    return { status: 404, body: { error: "Task not found", code: "invalid_payload" } };
  }
  if (!args.pmChannelRunId) {
    return {
      status: 409,
      body: {
        error: "Authenticated PM-channel run identity is required for an authoritative workflow action.",
        code: "cycle_mismatch",
      },
    };
  }

  let rawBody = args.rawBody;
  if (args.action === "flag_blocker" && !args.rawBody.permissionKind) {
    const candidate = formalBlockerReportFromValue(args.rawBody.blockerReport);
    let priorDistinctDiagnostics = 0;
    if (candidate) {
      const signature = blockerFailureSignature(candidate);
      const fingerprint = blockerDiagnosticsFingerprint(candidate);
      const incidents = await db.activityLog.findMany({
        where: { taskId: args.taskId, kind: "task.blocker.incident", targetAgent: args.agent.slug },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { payload: true },
      });
      const distinct = new Set<string>();
      for (const row of incidents) {
        if (!row.payload) continue;
        try {
          const parsed = JSON.parse(row.payload) as Record<string, unknown>;
          const prior = formalBlockerReportFromValue(parsed.report);
          const priorSignature = prior ? blockerFailureSignature(prior) : parsed.signature;
          if (priorSignature !== signature || parsed.diagnosticsFingerprint === fingerprint) continue;
          if (typeof parsed.diagnosticsFingerprint === "string") distinct.add(parsed.diagnosticsFingerprint);
        } catch { /* malformed history earns no escalation */ }
      }
      priorDistinctDiagnostics = distinct.size;
    }
    const classification = classifyBlockerFailure(args.rawBody.blockerReport, {
      assigneeIdentifiers: [args.agent.slug, args.agent.username, args.agent.id],
      priorDistinctDiagnostics,
    });
    if (classification.outcome === "reject") {
      return {
        status: 422,
        body: {
          error: classification.message,
          rejectedRule: classification.rule,
          requiredFields: {
            blockedOn: "person | permission | external_service | decision | dependency",
            requestedActor: "who must act (never you)",
            requestedAction: "the exact action they must perform",
            evidence: "the observed failure: exact error text, endpoint or identifier",
            diagnosticsAttempted: ["what you already tried"],
            resumeCondition: "the observable condition that lets work resume",
            reporterCanResolve: "true | false",
          },
        },
      };
    }
    if (classification.outcome === "incident") {
      await db.activityLog.create({
        data: {
          projectId: aggregate.projectId,
          taskId: args.taskId,
          userId: args.agent.id,
          kind: "task.blocker.incident",
          targetAgent: args.agent.slug,
          payload: JSON.stringify({
            action: args.action,
            rule: classification.rule,
            signature: candidate ? blockerFailureSignature(candidate) : null,
            diagnosticsFingerprint: candidate ? blockerDiagnosticsFingerprint(candidate) : null,
            priorDistinctDiagnostics,
            report: candidate,
          }),
        },
      });
      return {
        status: 422,
        body: {
          error: classification.message,
          incident: true,
          rejectedRule: classification.rule,
          guidance: classification.guidance,
          priorDistinctDiagnostics,
        },
      };
    }
    rawBody = { ...args.rawBody, blockerReport: classification.report };
  }

  let subtaskKind: WorkflowSubtaskKind | null = null;
  if (args.action === "complete_subtask" || args.action === "remove_subtask") {
    const subtaskId = typeof args.rawBody.subtaskId === "string" ? args.rawBody.subtaskId : "";
    const subtask = subtaskId
      ? await db.subTask.findFirst({
          where: { id: subtaskId, taskId: args.taskId },
          select: { kind: true },
        })
      : null;
    if (subtask?.kind === "implementation" || subtask?.kind === "review") {
      subtaskKind = subtask.kind;
    }
  } else if (args.action === "add_subtask") {
    subtaskKind = args.rawBody.subtaskKind === "review" ? "review" : "implementation";
  }

  const expectedEpisodeId = await resolveExpectedEpisodeId({
    taskId: args.taskId,
    agentSlug: args.agent.slug,
    messageId: args.messageId,
  });
  const idempotencyKey = `${args.action}:${args.messageId}:${createHash("sha256").update(canonicalize(rawBody)).digest("hex").slice(0, 16)}`;
  // The browser/agent request has no workflow version: this adapter supplies it.
  // An exact approval retry must reuse the original server snapshot rather than
  // fingerprinting the version advanced by that same successful approval.
  // The orchestrator still verifies the complete fingerprint and actor.
  const priorPlanReceipt = ["approve_plan", "accept_plan_review", "request_plan_changes"].includes(args.action)
    ? await db.taskWorkflowCommandReceipt.findUnique({ where: { taskId_idempotencyKey: { taskId: args.taskId, idempotencyKey } }, select: { actorUserId: true, expectedWorkflowVersion: true, workflowCycleId: true } })
    : null;
  const replaySnapshot = priorPlanReceipt?.actorUserId === args.agent.id ? priorPlanReceipt : null;
  const normalized = normalizePublicAction(args.action, rawBody, {
    taskId: args.taskId,
    actorId: args.agent.id,
    actorKind: "agent",
    actorUsername: args.agent.username,
    actorRole: actorRole({
      registryRole: args.agent.registryRole,
      actorId: args.agent.id,
      assigneeId: aggregate.assigneeId,
      reviewOwnerId: aggregate.resolvedReviewOwnerId,
      reporterId: aggregate.reporterId,
    }),
    actorCodingCapability: args.agent.registryRole === "coding",
    expectedWorkflowVersion: replaySnapshot?.expectedWorkflowVersion ?? aggregate.workflowVersion,
    workflowCycleId: replaySnapshot ? replaySnapshot.workflowCycleId : aggregate.activeWorkflowCycleId,
    idempotencyKey,
    messageId: args.messageId,
    source: "agent",
    // Native tools bind the revision actually shown to the reviewer. The
    // transactional plan executor rejects a newer revision; exact replay
    // still resolves through the existing receipt before current-state guards.
    actionPlanId: "actionPlanId" in rawBody
      ? typeof rawBody.actionPlanId === "string" ? rawBody.actionPlanId : null
      : aggregate.actionPlan?.id ?? null,
    actionPlanVersion: "actionPlanVersion" in rawBody
      ? typeof rawBody.actionPlanVersion === "number" ? rawBody.actionPlanVersion : null
      : aggregate.actionPlan?.version ?? null,
    reviewRunId: aggregate.activeReviewRun?.id ?? null,
    candidateSha: aggregate.activeReviewRun?.candidateSha
      ?? aggregate.repositoryRun?.candidateSha
      ?? aggregate.activeCycle?.candidateSha
      ?? null,
    baseSha: aggregate.repositoryRun?.baseSha ?? aggregate.activeCycle?.baseSha ?? null,
    worktreePath: aggregate.repositoryRun?.worktreePath ?? null,
    branchName: aggregate.repositoryRun?.branchName ?? aggregate.branchName,
    blockerId: aggregate.activeBlocker?.commentId ?? null,
    subtaskKind,
    executionContext: {
      agentSlug: args.agent.slug,
      pmChannelRunId: args.pmChannelRunId,
      sourceMessageId: args.messageId,
      publicAction: args.action,
      expectedEpisodeId,
    },
  });
  if (!normalized.ok) {
    return {
      status: DOMAIN_ERROR_HTTP_STATUS.get(normalized.code) ?? 422,
      body: { error: normalized.message, code: normalized.code, orchestratorStatus: "invalid" },
    };
  }

  const result = await submitWorkflowCommand(normalized.command);
  const current = await db.task.findUnique({
    where: { id: args.taskId },
    select: { status: true, projectId: true },
  });
  const response = mapOrchestratorResultToAgentHttp({
    taskId: args.taskId,
    action: args.action,
    taskStatus: current?.status ?? aggregate.status,
    result,
  });
  // Preserve the small action-specific response projection agents need for a
  // follow-up command. The mutation itself remains wholly owned by the one
  // authoritative command above.
  if ((result.status === "accepted" || result.status === "replayed") && args.action === "add_subtask") {
    const text = typeof args.rawBody.subtaskText === "string" ? args.rawBody.subtaskText.trim() : "";
    const subtask = text
      ? await db.subTask.findFirst({
          where: { taskId: args.taskId, text },
          orderBy: { createdAt: "desc" },
          select: { id: true, kind: true },
        })
      : null;
    if (subtask) {
      response.body.subtaskId = subtask.id;
      response.body.subtaskKind = subtask.kind;
    }
  }
  if ((result.status === "accepted" || result.status === "replayed") && args.action === "approve_plan") {
    response.body.approved = true;
    response.body.alreadyApproved = result.status === "replayed";
  }
  if ((result.status === "accepted" || result.status === "replayed") && args.action === "flag_blocker") {
    const requestedKind = typeof args.rawBody.permissionKind === "string" ? args.rawBody.permissionKind : null;
    const requestedScope = typeof args.rawBody.permissionScope === "string" ? args.rawBody.permissionScope.trim() : null;
    const alreadyFlagged = Boolean(
      aggregate.activeBlocker &&
      requestedKind &&
      aggregate.activeBlocker.permissionRequest?.kind === requestedKind &&
      aggregate.activeBlocker.permissionRequest.scope === requestedScope &&
      !aggregate.activeBlocker.permissionGrant?.authorizationCommentId,
    );
    const blocker = alreadyFlagged
      ? aggregate.activeBlocker
      : (await loadTaskAggregate(args.taskId))?.activeBlocker;
    response.body.alreadyFlagged = alreadyFlagged;
    response.body.blockerId = blocker?.commentId ?? null;
    response.body.commentId = blocker?.commentId ?? null;
    response.body.flagged = "blocker";
  }
  if (result.status === "accepted" || result.status === "replayed") {
    await recordWorkflowActionExecutionState({
      taskId: args.taskId,
      projectId: current?.projectId ?? aggregate.projectId,
      action: args.action,
      status: current?.status ?? aggregate.status,
      blockedExternally: args.action === "flag_blocker",
    }).catch((error) => console.error("[pm] execution-state projection failed:", error));
  }
  return response;
}

export { ENGINE_ORCHESTRATOR_V2 };
