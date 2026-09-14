import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isOperationalRepositoryFailure,
  semanticCommitDescriptionWarning,
} from "@/lib/tasks/repository-validation";
import {
  activityPayloadUsesCheckpointAuthorization,
  validateCheckpointAuthorizationText,
} from "@/lib/deploy/checkpoint-authorization";
import { repositoryFinalizationOwnsTask } from "@/lib/tasks/repository-finalization";

assert.equal(
  repositoryFinalizationOwnsTask({
    phase: "operational_error",
    repoTouched: true,
    baseSha: "base",
    candidateSha: "candidate",
    reviewedSha: "candidate",
  }),
  true,
  "an accepted immutable candidate must retain its finalization fence across an operational cleanup error",
);
assert.equal(
  repositoryFinalizationOwnsTask({
    phase: "operational_error",
    repoTouched: true,
    baseSha: "base",
    candidateSha: "candidate",
    reviewedSha: null,
  }),
  false,
  "a validation error before acceptance must not acquire the finalization fence",
);
assert.equal(
  repositoryFinalizationOwnsTask({
    phase: "completed",
    repoTouched: false,
    baseSha: "base",
    candidateSha: null,
    reviewedSha: "base",
  }),
  true,
  "an accepted no-change candidate must retain the same finalization fence",
);

assert.equal(
  semanticCommitDescriptionWarning({
    taskTitle: "Fix Patricia Epic deployment",
    taskDescription: "Correct the local worktree publication workflow.",
    commitPrefix: "PATRICIA-42",
    commitSubject: "PATRICIA-42 Fix Patricia Epic deployment",
  }),
  null,
  "a task-specific commit description must pass semantic comparison",
);

assert.match(
  semanticCommitDescriptionWarning({
    taskTitle: "Fix Patricia Epic deployment",
    taskDescription: "Correct the local worktree publication workflow.",
    commitPrefix: "PATRICIA-42",
    commitSubject: "PATRICIA-42 Refresh unrelated avatars",
  }) ?? "",
  /advisory/i,
  "a semantic mismatch must become an advisory warning",
);

assert.equal(
  isOperationalRepositoryFailure("ssh: Could not resolve hostname bitbucket.org"),
  true,
  "network/provider failures must be operational",
);
assert.equal(
  isOperationalRepositoryFailure("git fetch origin failed because runner credentials are unavailable"),
  true,
  "runner credentials/fetch failures must remain operational instead of returning a task to To Do",
);
assert.equal(
  isOperationalRepositoryFailure("Epic-child branch exists on origin"),
  false,
  "repository-policy failures must not be classified as infrastructure",
);

assert.deepEqual(
  validateCheckpointAuthorizationText({
    body: "I authorize PM to create and publish a checkpoint from PH-115 to lambda-replacement for deployment.",
    taskKey: "PH-115",
    taskBranch: "ph-115",
    epicBranch: "lambda-replacement",
  }),
  { ok: true },
  "checkpoint authorization must explicitly bind the operation, task, and target Epic branch",
);
assert.equal(
  validateCheckpointAuthorizationText({
    body: "Looks good; continue testing.",
    taskKey: "PH-115",
    taskBranch: "ph-115",
    epicBranch: "lambda-replacement",
  }).ok,
  false,
  "an unrelated owner comment must never become a checkpoint publication capability",
);
assert.equal(
  validateCheckpointAuthorizationText({
    body: "I do not authorize PM to publish a checkpoint from PH-115 to lambda-replacement.",
    taskKey: "PH-115",
    taskBranch: "ph-115",
    epicBranch: "lambda-replacement",
  }).ok,
  false,
  "an explicitly negated owner statement must never become a checkpoint publication capability",
);
assert.equal(
  validateCheckpointAuthorizationText({
    body: "We need authorization before PM can publish a checkpoint from PH-115 to lambda-replacement.",
    taskKey: "PH-115",
    taskBranch: "ph-115",
    epicBranch: "lambda-replacement",
  }).ok,
  false,
  "discussion about needing authorization must never become a checkpoint publication capability",
);
assert.equal(
  activityPayloadUsesCheckpointAuthorization(
    JSON.stringify({ authorizationCommentId: "comment-1" }),
    "comment-1",
  ),
  true,
  "checkpoint authorization consumption must be detectable from durable activity",
);

const root = process.cwd();
const handoff = readFileSync(join(root, "lib/tasks/review-handoff.ts"), "utf8");
const verifier = readFileSync(join(root, "scripts/pm-verify-branch-pushed.ts"), "utf8");
const finalization = readFileSync(join(root, "lib/tasks/review-automation.ts"), "utf8");
const submissionHandler = readFileSync(join(root, "lib/tasks/orchestrator/handlers/submit-candidate-for-review.ts"), "utf8");
const reviewHandler = readFileSync(join(root, "lib/tasks/orchestrator/handlers/review-decisions.ts"), "utf8");
const completionHandler = readFileSync(join(root, "lib/tasks/orchestrator/intents/index.ts"), "utf8");
const repositoryRunner = readFileSync(join(root, "lib/deploy/epic-merge.ts"), "utf8");
const workflowRoute = readFileSync(join(root, "app/api/agent/tasks/[taskId]/workflow/route.ts"), "utf8");
const epicWorkflowRoute = readFileSync(join(root, "app/api/agent/epics/[epicId]/workflow/route.ts"), "utf8");
const epicNotifications = readFileSync(join(root, "lib/agents/workflow/notifications/epic.ts"), "utf8");
const workflowOutbox = readFileSync(join(root, "lib/tasks/workflow-outbox-drain.ts"), "utf8");
const workflowNudge = readFileSync(join(root, "scripts/pm-workflow-nudge.ts"), "utf8");

assert(
  submissionHandler.includes('intent: "repository_validation_failed"') &&
    submissionHandler.includes('validationOutcome: "invalid"'),
  "invalid validation is handled by the authoritative procedure command",
);
assert(
  verifier.includes('"valid_with_warning"') &&
    verifier.includes("completeTaskReviewHandoffAfterValidation"),
  "advisory warnings must still release the task to Review",
);
assert(
  reviewHandler.includes('phase: "finalizing"') &&
    repositoryRunner.includes('kind: "finalize"') &&
    reviewHandler.includes('phase: "completed"'),
  "review acceptance must remain in Review until repository finalization completes",
);
assert(
  completionHandler.includes('type: "epic_completion_review"') &&
    completionHandler.includes("enqueueWorkflowEffects") &&
    !completionHandler.includes("enqueueEpicDoneCleanup"),
  "the final child must atomically outbox whole-Epic review without completing or cleaning the Epic",
);
assert(
  repositoryRunner.includes('kind: "review"') &&
    repositoryRunner.includes('kind: "review-approval"') &&
    repositoryRunner.includes("validateCompletionReviewCandidate") &&
    repositoryRunner.includes("inspectEpicWorktree") &&
    repositoryRunner.includes('action: "epic_review_done"'),
  "the repository runner must freeze and re-verify the combined candidate before Epic Done",
);
assert(
  epicWorkflowRoute.includes('"completion_review_approve"') &&
    epicWorkflowRoute.includes("parseCompletionReviewReport") &&
    epicWorkflowRoute.includes("completionReviewReportCanApprove") &&
    epicWorkflowRoute.includes('type: "epic_completion_review_approval"') &&
    epicWorkflowRoute.includes("applyPmChannelRunWorkflowAction") &&
    workflowOutbox.includes("enqueueEpicCompletionReviewApproval"),
  "whole-Epic approval must atomically outbox an all-Pass report and privileged final verification",
);
assert(
  repositoryRunner.includes("child merge(s) still pending before whole-Epic acceptance") &&
    repositoryRunner.includes('outcome: "deferred"') &&
    repositoryRunner.includes('type: "epic_cleanup"'),
  "whole-Epic preparation must wait for child integrations and Done must durably outbox cleanup",
);
assert(
  epicNotifications.includes("linkedTasks") &&
    epicNotifications.includes("createContextGrantUrl") &&
    epicNotifications.includes("WHOLE-EPIC CHILD TASK CONTEXT GRANTS"),
  "the reviewer turn must expose bounded per-child context grants instead of injecting every Task thread",
);
assert(
  reviewHandler.includes("task.repositoryRun?.reviewedSha ?? task.repositoryRun?.candidateSha") &&
    reviewHandler.includes('type: "review_finalize"') &&
    repositoryRunner.includes("const repoTouched = task.repositoryRun?.repoTouched === true") &&
    repositoryRunner.includes("const finalizedWorktreePath = task.repositoryRun?.worktreePath"),
  "no-change repository tasks must still finalize and clean up their worktree before Done",
);
assert(
  repositoryRunner.split('repositoryRun: { is: { repoTouched: true } }').length - 1 >= 3 &&
    repositoryRunner.includes('task.repositoryRun?.repoTouched !== true'),
  "Epic merge enqueue, execution, and cleanup defer must exclude legacy/no-change Done tasks",
);
assert(
  repositoryRunner.includes("allowWhileRunning: true"),
  "an operational finalization failure must enqueue its bounded retry while the current job is running",
);
assert(
  repositoryRunner.includes('kind: "checkpoint"') &&
    repositoryRunner.includes("publishTaskCheckpointToEpic") &&
    repositoryRunner.includes("baseSha: epicBranch ? checkpoint.epicSha : task.repositoryRun?.baseSha ?? null") &&
    repositoryRunner.includes('phase: "active"'),
  "owner-authorized Epic checkpoints must publish through the runner, reset the active base, and keep the task In Progress",
);
assert(
  verifier.includes("recordedCheckpointReviewBaseline") &&
    verifier.includes("job.baseSha") &&
    verifier.includes("subjectHasCommitPrefix(checkpointBaseline.checkpoint.subject") &&
    verifier.includes("repoTouched: !noChangeCandidate && !checkpointBaseline"),
  "an already-published checkpoint baseline must satisfy prefix review and use the no-change cleanup path",
);
assert(
  workflowRoute.includes("submitAuthoritativeAgentWorkflowAction") &&
    reviewHandler.includes("finalize_accepted_review") &&
    workflowNudge.includes('args.kind?.startsWith("pm-review-")') &&
    workflowNudge.includes("repositoryFinalizationOwnsTask(task.repositoryRun)"),
  "review feedback must stay fenced after acceptance, and review_done must retry an operational finalization without revalidating the branch",
);
assert(
  handoff.includes("Exact schema-v2") && !handoff.includes("runTaskReviewHandoff"),
  "the callback boundary uses exact identity and has no named-agent fallback",
);

console.log("repository-workflow-test passed");
