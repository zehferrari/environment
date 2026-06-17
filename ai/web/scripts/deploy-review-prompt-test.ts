import assert from "node:assert/strict";
import {
  DEFAULT_DEPLOY_REVIEW_PROMPT,
  cleanDeployReviewPrompt,
  normalizeDeployReviewPrompt,
  resolveDeployReviewPromptValue,
  selectDeployReviewerSlug,
} from "../lib/epics/deploy-review";

assert.equal(cleanDeployReviewPrompt("  project prompt  "), "project prompt");
assert.equal(cleanDeployReviewPrompt("   "), null);
assert.equal(normalizeDeployReviewPrompt(""), DEFAULT_DEPLOY_REVIEW_PROMPT);

assert.equal(resolveDeployReviewPromptValue("project", "system"), "project");
assert.equal(resolveDeployReviewPromptValue("", "system"), "system");
assert.equal(resolveDeployReviewPromptValue(null, ""), DEFAULT_DEPLOY_REVIEW_PROMPT);

assert.equal(selectDeployReviewerSlug("reviewer", "monitor"), "reviewer");
assert.equal(selectDeployReviewerSlug(null, "monitor"), "monitor");
assert.equal(selectDeployReviewerSlug(null, null), null);

console.log("deploy-review-prompt-test passed");
