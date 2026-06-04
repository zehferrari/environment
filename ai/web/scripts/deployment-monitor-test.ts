import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { verifyDeploymentBranch, handleDeploymentApproved } from "@/lib/deploy/monitor";

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function branchVerificationPushesReporterAuthoredCommit() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deployment-monitor-"));
  try {
    const bare = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["init", repo]);
    git(repo, ["config", "user.name", "Zeh Ferrari"]);
    git(repo, ["config", "user.email", "e@zeh.me"]);
    git(repo, ["remote", "add", "origin", bare]);
    await import("node:fs/promises").then((fs) => fs.writeFile(path.join(repo, "README.md"), "base\n"));
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["push", "origin", "main"]);
    git(repo, ["checkout", "-b", "feature/deploy"]);
    await import("node:fs/promises").then((fs) => fs.appendFile(path.join(repo, "README.md"), "feature\n"));
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "ENV-18 implement deployment"]);

    const result = await verifyDeploymentBranch({
      repositoryPath: repo,
      branchName: "feature/deploy",
      commitPrefix: "ENV-18",
      reporter: { userId: "u1", name: "Zeh Ferrari", email: "e@zeh.me" },
      targetBranch: "main",
    });

    assert.equal(result.pushed, true);
    assert.equal(result.matchingCommitCount, 1);
    assert.equal(git(repo, ["ls-remote", "--heads", "origin", "feature/deploy"]).split(/\s+/)[0], result.localSha);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function missingReporterEmailReturnsPrompt() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deployment-plan-"));
  try {
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", repo]);
    git(repo, ["remote", "add", "origin", "git@bitbucket.org:workspace/repo.git"]);
    const mockDb = {
      task: {
        findUnique: async () => ({
          id: "task1",
          title: "Deploy me",
          workItemKey: "ENV-18",
          branchName: "feature/deploy",
          commitPrefix: "ENV-18",
          epicId: null,
          deletedAt: null,
          archivedAt: null,
          reporter: { id: "u1", username: "zeh", name: "Zeh Ferrari", email: null },
          project: {
            id: "p1",
            slug: "environment",
            repositoryPath: repo,
            deploymentProductionBranch: "main",
            deploymentBitbucketWorkspace: null,
            deploymentBitbucketRepoSlug: null,
          },
        }),
      },
      epic: { findUnique: async () => null },
      deploymentPullRequest: { create: async () => ({}) },
      activityLog: { findFirst: async () => null, create: async () => ({}) },
    };
    const result = await handleDeploymentApproved({ scope: "task", scopeId: "task1", db: mockDb as never });
    assert.equal(result.action, "reporter-email-required");
    assert.match(result.prompt?.question ?? "", /email/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  await branchVerificationPushesReporterAuthoredCommit();
  await missingReporterEmailReturnsPrompt();
  console.log("deployment-monitor tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
