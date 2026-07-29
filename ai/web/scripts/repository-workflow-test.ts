import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isOperationalRepositoryFailure,
  semanticCommitDescriptionWarning,
} from "@/lib/tasks/repository-validation";

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

const root = process.cwd();
const handoff = readFileSync(join(root, "lib/tasks/review-handoff.ts"), "utf8");
const verifier = readFileSync(join(root, "scripts/pm-verify-branch-pushed.ts"), "utf8");
const finalization = readFileSync(join(root, "lib/tasks/review-automation.ts"), "utf8");
const repositoryRunner = readFileSync(join(root, "lib/deploy/epic-merge.ts"), "utf8");
const workflowRoute = readFileSync(join(root, "app/api/agent/tasks/[taskId]/workflow/route.ts"), "utf8");

assert(
  handoff.includes('status: "To Do"') &&
    handoff.includes('validationOutcome: "invalid"') &&
    handoff.includes("The reviewer was not notified"),
  "invalid validation must return the task to To Do without a reviewer wake",
);
assert(
  verifier.includes('"valid_with_warning"') &&
    verifier.includes("completeTaskReviewHandoffAfterValidation"),
  "advisory warnings must still release the task to Review",
);
assert(
  finalization.includes('phase: "finalizing"') &&
    repositoryRunner.includes('kind: "finalize"') &&
    repositoryRunner.includes('phase: "completed"'),
  "review acceptance must remain in Review until repository finalization completes",
);
assert(
  finalization.includes("task.repositoryRun && !args.repositoryFinalized") &&
    repositoryRunner.includes('task.repositoryRun?.repoTouched === true') &&
    repositoryRunner.includes("declared no repository changes"),
  "no-change repository tasks must still finalize and clean up their worktree before Done",
);
assert(
  repositoryRunner.includes("allowWhileRunning: true"),
  "an operational finalization failure must enqueue its bounded retry while the current job is running",
);
assert(
  workflowRoute.includes('task.repositoryRun?.phase === "finalizing"'),
  "review feedback must not race an accepted repository submission that is already finalizing",
);
assert(
  handoff.includes("resolveActiveMonitorAgent") &&
    !handoff.toLowerCase().includes("karen"),
  "validation authority must be resolved from the monitor role, not an agent name",
);

console.log("repository-workflow-test passed");
