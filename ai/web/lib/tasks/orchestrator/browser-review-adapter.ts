import type { Viewer } from "@/lib/auth/permissions";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";

export type BrowserReviewChangesResult =
  | { ok: true }
  | { ok: false; message: string; stale: boolean };

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

  if (result.status === "accepted" || result.status === "replayed") {
    return { ok: true };
  }
  return {
    ok: false,
    stale: result.status === "stale",
    message: result.status === "stale"
      ? "The review changed while this request was pending. Refresh and try again."
      : result.reason,
  };
}
