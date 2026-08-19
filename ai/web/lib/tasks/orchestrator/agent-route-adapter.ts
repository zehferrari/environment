import { revalidatePath } from "next/cache";
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
  ENGINE_LEGACY,
  ENGINE_ORCHESTRATOR_V2,
  type WorkflowEngine,
} from "@/lib/tasks/orchestrator/ownership";

/** Public actions accepted by the agent transport. Human-only override_status
 * remains in the shared public vocabulary for browser/operator transports. */
export const AGENT_WORKFLOW_PUBLIC_ACTIONS = WORKFLOW_PUBLIC_ACTIONS.filter(
  (action): action is Exclude<WorkflowPublicAction, "override_status"> => action !== "override_status",
);

export type AgentWorkflowPublicAction = (typeof AGENT_WORKFLOW_PUBLIC_ACTIONS)[number];

export function isAgentWorkflowPublicAction(value: unknown): value is AgentWorkflowPublicAction {
  return typeof value === "string" && AGENT_WORKFLOW_PUBLIC_ACTIONS.includes(value as AgentWorkflowPublicAction);
}

/**
 * One durable-owner branch and no catch/retry path. In particular, a V2
 * rejection or operational exception can never enter runLegacy.
 */
export function dispatchByDurableEngine<T>(args: {
  engine: WorkflowEngine;
  runAuthoritative: () => Promise<T>;
  runLegacy: () => Promise<T>;
}): Promise<T> {
  return args.engine === ENGINE_ORCHESTRATOR_V2
    ? args.runAuthoritative()
    : args.runLegacy();
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
      orchestratorStatus: result.status,
      workflowVersion: result.workflowVersion,
      transitionId: result.transitionId,
      procedureId: result.procedureId ?? null,
      cycleId: result.cycleId ?? null,
      ...(result.actionEffect ? { actionEffect: result.actionEffect } : {}),
      ...(result.episode !== undefined ? { episode: result.episode } : {}),
      ...(result.checkpoint !== undefined ? { checkpoint: result.checkpoint } : {}),
      ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
      ...(result.disposition !== undefined ? { disposition: result.disposition } : {}),
      ...(result.turnComplete !== undefined ? { turnComplete: result.turnComplete } : {}),
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
  const normalized = normalizePublicAction(args.action, args.rawBody, {
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
    expectedWorkflowVersion: aggregate.workflowVersion,
    workflowCycleId: aggregate.activeWorkflowCycleId,
    idempotencyKey: `${args.action}:${args.messageId}`,
    messageId: args.messageId,
    source: "agent",
    actionPlanId: aggregate.actionPlan?.id ?? null,
    actionPlanVersion: aggregate.actionPlan?.version ?? null,
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
    select: { status: true },
  });
  return mapOrchestratorResultToAgentHttp({
    taskId: args.taskId,
    action: args.action,
    taskStatus: current?.status ?? aggregate.status,
    result,
  });
}

export { ENGINE_LEGACY, ENGINE_ORCHESTRATOR_V2 };
