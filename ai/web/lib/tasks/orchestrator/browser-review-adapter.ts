import type { Viewer } from "@/lib/auth/permissions";
import {
  authorizeCommand,
  loadTaskStateSnapshot,
  runGuards,
  submitWorkflowCommand,
} from "@/lib/tasks/orchestrator";

export type BrowserReviewChangesResult =
  | { ok: true }
  | { ok: false; message: string; stale: boolean };

export type BrowserTaskWorkflowActions = {
  taskId: string;
  status: string;
  workflowVersion: number;
  workflowCycleId: string | null;
  reviewRunId: string | null;
  reviewStatus: string | null;
  candidateSha: string | null;
  canReset: boolean;
  canCancel: boolean;
  canRequestChanges: boolean;
  canAccept: boolean;
};

function workflowActor(actor: Viewer) {
  return {
    id: actor.id,
    kind: actor.kind === "human" ? "human" as const : "agent" as const,
    username: actor.username,
    role: actor.isOwner ? "admin" as const : undefined,
  };
}

export async function getBrowserTaskWorkflowActions(args: {
  actor: Viewer;
  taskId: string;
}): Promise<BrowserTaskWorkflowActions> {
  const state = await loadTaskStateSnapshot(args.taskId);
  if (!state) throw new Error("Task not found.");
  const actor = workflowActor(args.actor);
  const available = (intent: "cancel_task" | "request_review_changes" | "accept_review") => {
    const authorization = authorizeCommand(state, { intent, actor });
    if (!authorization.allowed) return false;
    return runGuards(state, {
      intent,
      expectedWorkflowVersion: state.workflowVersion,
      workflowCycleId: state.activeWorkflowCycleId,
    }).ok;
  };

  return {
    taskId: state.id,
    status: state.status,
    workflowVersion: state.workflowVersion,
    workflowCycleId: state.activeWorkflowCycleId,
    reviewRunId: state.activeReviewRun?.id ?? null,
    reviewStatus: state.activeReviewRun?.status ?? null,
    candidateSha: state.activeReviewRun?.candidateSha ?? null,
    canReset: args.actor.kind === "human" && args.actor.isOwner,
    canCancel: state.status !== "Backlog" && available("cancel_task"),
    canRequestChanges: available("request_review_changes"),
    canAccept: available("accept_review"),
  };
}

function browserResult(result: Awaited<ReturnType<typeof submitWorkflowCommand>>, staleMessage: string): BrowserReviewChangesResult {
  if (result.status === "accepted" || result.status === "replayed") return { ok: true };
  return {
    ok: false,
    stale: result.status === "stale",
    message: result.status === "stale" ? staleMessage : result.reason,
  };
}

/**
 * Submit an explicit human review decision through the canonical workflow.
 * Authorization, immutable candidate correlation, cycle closure, worktree
 * preservation, and assignee notification remain owned by the orchestrator.
 */
export async function submitBrowserReviewChanges(args: {
  actor: Viewer;
  taskId: string;
  expectedWorkflowVersion: number;
  workflowCycleId: string;
  reviewRunId: string;
  candidateSha: string;
  reviewerComment: string;
}): Promise<BrowserReviewChangesResult> {
  if (args.actor.kind !== "human") {
    return {
      ok: false,
      stale: false,
      message: "Only the human reviewer can return a task from Review to To Do.",
    };
  }
  const reviewerComment = args.reviewerComment.trim();
  if (!reviewerComment) {
    return { ok: false, stale: false, message: "Reviewer feedback is required." };
  }

  const result = await submitWorkflowCommand({
    taskId: args.taskId,
    intent: "request_review_changes",
    actor: {
      id: args.actor.id,
      kind: "human",
      username: args.actor.username,
      role: "reviewer",
    },
    expectedWorkflowVersion: args.expectedWorkflowVersion,
    workflowCycleId: args.workflowCycleId,
    source: "browser",
    idempotencyKey: [
      "browser-review-changes",
      args.actor.id,
      args.taskId,
      args.reviewRunId,
      `v${args.expectedWorkflowVersion}`,
    ].join(":"),
    payload: {
      reviewRunId: args.reviewRunId,
      candidateSha: args.candidateSha,
      reviewerComment,
    },
  });

  return browserResult(result, "The review changed while this request was pending. Refresh and try again.");
}

export async function submitBrowserAcceptReview(args: {
  actor: Viewer;
  taskId: string;
  expectedWorkflowVersion: number;
  workflowCycleId: string;
  reviewRunId: string;
  candidateSha: string;
  reviewerComment: string;
}): Promise<BrowserReviewChangesResult> {
  if (args.actor.kind !== "human") {
    return { ok: false, stale: false, message: "Only the human reviewer can complete a review." };
  }
  const reviewerComment = args.reviewerComment.trim();
  if (!reviewerComment) {
    return { ok: false, stale: false, message: "A review comment is required." };
  }
  const result = await submitWorkflowCommand({
    taskId: args.taskId,
    intent: "accept_review",
    actor: { ...workflowActor(args.actor), role: "reviewer" },
    expectedWorkflowVersion: args.expectedWorkflowVersion,
    workflowCycleId: args.workflowCycleId,
    source: "browser",
    idempotencyKey: [
      "browser-accept-review",
      args.actor.id,
      args.taskId,
      args.reviewRunId,
      `v${args.expectedWorkflowVersion}`,
    ].join(":"),
    payload: {
      reviewRunId: args.reviewRunId,
      candidateSha: args.candidateSha,
    },
    evidence: { reviewerComment },
  });
  return browserResult(result, "The review changed while acceptance was pending. Refresh and try again.");
}

export async function submitBrowserCancelTask(args: {
  actor: Viewer;
  taskId: string;
  expectedWorkflowVersion: number;
  workflowCycleId: string | null;
  reason: string;
}): Promise<BrowserReviewChangesResult> {
  if (args.actor.kind !== "human") {
    return { ok: false, stale: false, message: "Only an authorized human can suspend work." };
  }
  const reason = args.reason.trim();
  if (!reason) return { ok: false, stale: false, message: "A suspension reason is required." };
  const result = await submitWorkflowCommand({
    taskId: args.taskId,
    intent: "cancel_task",
    actor: workflowActor(args.actor),
    expectedWorkflowVersion: args.expectedWorkflowVersion,
    workflowCycleId: args.workflowCycleId,
    source: "browser",
    idempotencyKey: [
      "browser-cancel-task",
      args.actor.id,
      args.taskId,
      `v${args.expectedWorkflowVersion}`,
    ].join(":"),
    payload: { reason },
  });
  return browserResult(result, "The task changed while suspension was pending. Refresh and try again.");
}
