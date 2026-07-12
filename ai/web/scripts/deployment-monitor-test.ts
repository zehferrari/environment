import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { approveLocalChangesAndOpenDeploymentPr, handleDeploymentApproved, pollDeploymentPullRequests, verifyDeploymentBranch } from "@/lib/deploy/monitor";

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
    git(repo, ["config", "user.name", "Example Owner"]);
    git(repo, ["config", "user.email", "owner@example.test"]);
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
      reporter: { userId: "u1", name: "Example Owner", email: "owner@example.test" },
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
          reporter: { id: "u1", username: "owner", name: "Example Owner", email: null },
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

async function dirtyDeploymentApprovalRecordsPendingLocalChanges() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deployment-dirty-"));
  try {
    const bare = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["init", repo]);
    git(repo, ["config", "user.name", "Example Owner"]);
    git(repo, ["config", "user.email", "owner@example.test"]);
    git(repo, ["remote", "add", "origin", bare]);
    await import("node:fs/promises").then((fs) => fs.writeFile(path.join(repo, "README.md"), "base\n"));
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["checkout", "-b", "feature/deploy"]);
    await import("node:fs/promises").then((fs) => fs.appendFile(path.join(repo, "README.md"), "dirty\n"));

    let pending: any = null;
    const mockDb = {
      task: {
        findUnique: async () => ({
          id: "task1",
          title: "Deploy me",
          workItemKey: "ENV-19",
          branchName: "feature/deploy",
          commitPrefix: "ENV-19",
          epicId: null,
          deletedAt: null,
          archivedAt: null,
          reporter: { id: "u1", username: "owner", name: "Example Owner", email: "owner@example.test" },
          project: {
            id: "p1",
            slug: "environment",
            repositoryPath: repo,
            deploymentProductionBranch: "main",
            deploymentPrTargetBranch: "main",
            deploymentBitbucketWorkspace: "workspace",
            deploymentBitbucketRepoSlug: "repo",
          },
        }),
      },
      epic: { findUnique: async () => null },
      deploymentPullRequest: {
        upsert: async ({ create }: any) => { pending = create; return create; },
      },
      activityLog: { create: async () => ({}) },
    };

    const result = await handleDeploymentApproved({
      scope: "task",
      scopeId: "task1",
      db: mockDb as never,
      createPr: async () => { throw new Error("PR should not be created while dirty"); },
    });
    assert.equal(result.action, "local-changes-approval-required");
    assert.equal(pending.status, "local_changes_pending_approval");
    assert.match(pending.localChangeSummary, /README\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function approvingLocalChangesCommitsPushesAndOpensPr() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deployment-local-approve-"));
  try {
    const bare = path.join(dir, "origin.git");
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["init", repo]);
    git(repo, ["config", "user.name", "Monitor"]);
    git(repo, ["config", "user.email", "monitor@example.test"]);
    git(repo, ["remote", "add", "origin", bare]);
    await import("node:fs/promises").then((fs) => fs.writeFile(path.join(repo, "README.md"), "base\n"));
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["push", "origin", "main"]);
    git(repo, ["checkout", "-b", "feature/deploy"]);
    await import("node:fs/promises").then((fs) => fs.appendFile(path.join(repo, "README.md"), "approved dirty\n"));

    const row: any = {
      id: "pending1",
      projectId: "p1",
      taskId: "task1",
      epicId: null,
      provider: "bitbucket",
      providerPrId: "pending-local:task:task1:task1",
      url: "",
      sourceBranch: "feature/deploy",
      targetBranch: "main",
      latestCommitSha: git(repo, ["rev-parse", "feature/deploy"]),
      reporterUserId: "u1",
      reporterName: "Example Owner",
      reporterEmail: "owner@example.test",
      status: "local_changes_pending_approval",
      project: {
        id: "p1",
        slug: "environment",
        repositoryPath: repo,
        deploymentProductionBranch: "main",
        deploymentPrTargetBranch: "main",
        deploymentMode: "pr-only",
        deploymentOnMerge: null,
        deploymentPipelineName: null,
        deploymentHost: null,
        deploymentEnvironment: null,
        deploymentBitbucketWorkspace: "workspace",
        deploymentBitbucketRepoSlug: "repo",
      },
    };
    const mockDb = {
      deploymentPullRequest: {
        findUnique: async () => row,
        update: async ({ data }: any) => { Object.assign(row, data); return row; },
      },
      task: {
        findUnique: async () => ({
          id: "task1",
          title: "Deploy me",
          workItemKey: "ENV-19",
          branchName: "feature/deploy",
          commitPrefix: "ENV-19",
          epicId: null,
          deletedAt: null,
          archivedAt: null,
          reporter: { id: "u1", username: "owner", name: "Example Owner", email: "owner@example.test" },
          project: row.project,
        }),
      },
      epic: { findUnique: async () => null },
      activityLog: { create: async () => ({}) },
    };

    const pr = await approveLocalChangesAndOpenDeploymentPr({
      rowId: row.id,
      actorUserId: "u1",
      db: mockDb as never,
      createPr: async ({ latestCommitSha }) => ({
        target: { taskId: "task1", epicId: null, workItemKey: "ENV-19", title: "Deploy me", branchName: "feature/deploy", commitPrefix: "ENV-19" },
        url: "https://bitbucket.org/workspace/repo/pull-requests/99",
        providerPrId: "99",
        sourceBranch: "feature/deploy",
        targetBranch: "main",
        latestCommitSha,
      }),
    });

    assert.equal(pr.providerPrId, "99");
    assert.equal(row.status, "open");
    assert.equal(row.providerPrId, "99");
    assert.equal(row.localChangeApprovedById, "u1");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
    const [authorName, authorEmail, subject] = git(repo, ["log", "-1", "--format=%an%x00%ae%x00%s", "feature/deploy"]).split("\0");
    assert.equal(authorName, "Example Owner");
    assert.equal(authorEmail, "owner@example.test");
    assert.match(subject, /^ENV-19/);
    assert.equal(git(repo, ["ls-remote", "--heads", "origin", "feature/deploy"]).split(/\s+/)[0], row.latestCommitSha);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mergedScriptSuccessWritesReporterReport() {
  const calls: any[] = [];
  const rows: any[] = [{
    id: "pr1",
    projectId: "p1",
    taskId: "task1",
    epicId: null,
    provider: "bitbucket",
    providerPrId: "12",
    url: "https://bitbucket.org/workspace/repo/pull-requests/12",
    sourceBranch: "feature/deploy",
    targetBranch: "main",
    latestCommitSha: "abc",
    reporterUserId: "u1",
    reporterName: "Example Owner",
    reporterEmail: "owner@example.test",
    status: "open",
    project: { repositoryPath: "/repo", deploymentMode: "script", deploymentOnMerge: "deploy.sh", deploymentBitbucketWorkspace: "workspace", deploymentBitbucketRepoSlug: "repo" },
  }];
  const mockDb = {
    deploymentPullRequest: {
      findMany: async (q: any) => q.where?.status === "open" ? rows.filter((r) => r.status === "open") : rows.filter((r) => r.epicId === q.where.epicId),
      findUnique: async () => ({ status: rows[0].status, deploymentReportedAt: null }),
      update: async ({ data }: any) => { calls.push(["pr.update", data]); Object.assign(rows[0], data); },
    },
    task: { update: async ({ data }: any) => calls.push(["task.update", data]) },
    epic: { update: async ({ data }: any) => calls.push(["epic.update", data]) },
    comment: { create: async ({ data }: any) => calls.push(["comment.create", data]) },
    activityLog: { create: async ({ data }: any) => calls.push(["activity.create", data]) },
  };
  const result = await pollDeploymentPullRequests({
    db: mockDb as never,
    fetchState: async () => ({ state: "merged", mergeSha: "merge123" }),
    runOnMerge: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });
  assert.deepEqual(result, { checked: 1, completed: 1, failed: 0, skipped: 0 });
  assert.equal(calls.find((c) => c[0] === "task.update")?.[1].deploymentStatus, "Successfully Deployed");
  const comment = calls.find((c) => c[0] === "comment.create")?.[1];
  assert.equal(comment.userId, "u1");
  assert.match(comment.body, /Merge SHA: merge123/);
}

async function nonZeroScriptIsDeploymentErrorAndIdempotent() {
  let commentCount = 0;
  const rows: any[] = [{
    id: "pr1", projectId: "p1", taskId: "task1", epicId: null, provider: "bitbucket", providerPrId: "12", url: "url", sourceBranch: "feature", targetBranch: "main", latestCommitSha: "abc", reporterUserId: "u1", reporterName: "Owner", reporterEmail: "owner@example.test", status: "open",
    project: { repositoryPath: "/repo", deploymentMode: "script", deploymentOnMerge: "deploy.sh", deploymentBitbucketWorkspace: "workspace", deploymentBitbucketRepoSlug: "repo" },
  }];
  const mockDb = {
    deploymentPullRequest: {
      findMany: async (q: any) => q.where?.status === "open" ? rows.filter((r) => r.status === "open") : rows,
      findUnique: async () => ({ status: rows[0].status, deploymentReportedAt: rows[0].deploymentReportedAt }),
      update: async ({ data }: any) => { Object.assign(rows[0], data); },
    },
    task: { update: async ({ data }: any) => { assert.equal(data.deploymentStatus, "Deployment Error"); } },
    epic: { update: async () => {} },
    comment: { create: async () => { commentCount += 1; } },
    activityLog: { create: async () => ({}) },
  };
  await pollDeploymentPullRequests({ db: mockDb as never, fetchState: async () => ({ state: "merged", mergeSha: "m" }), runOnMerge: async () => ({ exitCode: 42, stdout: "", stderr: "boom" }) });
  await pollDeploymentPullRequests({ db: mockDb as never, fetchState: async () => ({ state: "merged", mergeSha: "m" }), runOnMerge: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
  assert.equal(rows[0].status, "deployment_error");
  assert.equal(commentCount, 1);
}

async function declinedAndPipelineFailureFailDeployment() {
  for (const providerState of [{ state: "declined" as const, mergeSha: null }, { state: "open" as const, mergeSha: null, pipelineFailed: true }]) {
    const rows: any[] = [{ id: Math.random().toString(), projectId: "p1", taskId: "task1", epicId: null, provider: "bitbucket", providerPrId: "12", url: "url", sourceBranch: "feature", targetBranch: "main", latestCommitSha: "abc", reporterUserId: "u1", reporterName: "Owner", reporterEmail: "owner@example.test", status: "open", project: { repositoryPath: "/repo", deploymentMode: "pr-only", deploymentOnMerge: null } }];
    let status = "";
    const mockDb = {
      deploymentPullRequest: { findMany: async (q: any) => q.where?.status === "open" ? rows.filter((r) => r.status === "open") : rows, findUnique: async () => ({ status: rows[0].status }), update: async ({ data }: any) => { Object.assign(rows[0], data); } },
      task: { update: async ({ data }: any) => { status = data.deploymentStatus; } },
      epic: { update: async () => {} },
      comment: { create: async () => ({}) },
      activityLog: { create: async () => ({}) },
    };
    await pollDeploymentPullRequests({ db: mockDb as never, fetchState: async () => providerState });
    assert.equal(status, "Deployment Error");
  }
}

async function epicChildRollupWaitsForAllChildren() {
  const rows: any[] = [
    { id: "pr1", projectId: "p1", taskId: "t1", epicId: "e1", provider: "bitbucket", providerPrId: "1", url: "url1", sourceBranch: "b1", targetBranch: "main", latestCommitSha: "a", reporterUserId: "u1", reporterName: "Owner", reporterEmail: "owner@example.test", status: "open", project: { repositoryPath: "/repo", deploymentMode: "pr-only", deploymentOnMerge: null } },
    { id: "pr2", projectId: "p1", taskId: "t2", epicId: "e1", provider: "bitbucket", providerPrId: "2", url: "url2", sourceBranch: "b2", targetBranch: "main", latestCommitSha: "b", reporterUserId: "u1", reporterName: "Owner", reporterEmail: "owner@example.test", status: "open", project: { repositoryPath: "/repo", deploymentMode: "pr-only", deploymentOnMerge: null } },
  ];
  const epicUpdates: string[] = [];
  const mockDb = {
    deploymentPullRequest: { findMany: async (q: any) => q.where?.status === "open" ? rows.filter((r) => r.status === "open") : rows, findUnique: async ({ where }: any) => ({ status: rows.find((r) => r.id === where.id).status }), update: async ({ where, data }: any) => { Object.assign(rows.find((r) => r.id === where.id), data); } },
    task: { update: async () => {} },
    epic: { update: async ({ data }: any) => { epicUpdates.push(data.deploymentStatus); } },
    comment: { create: async () => ({}) },
    activityLog: { create: async () => ({}) },
  };
  await pollDeploymentPullRequests({ db: mockDb as never, fetchState: async (row: any) => row.id === "pr1" ? { state: "merged", mergeSha: "m1" } : { state: "open", mergeSha: null } });
  assert.equal(epicUpdates.length, 0);
  await pollDeploymentPullRequests({ db: mockDb as never, fetchState: async () => ({ state: "merged", mergeSha: "m2" }) });
  assert.deepEqual(epicUpdates, ["Successfully Deployed"]);
}

async function main() {
  await branchVerificationPushesReporterAuthoredCommit();
  await missingReporterEmailReturnsPrompt();
  await dirtyDeploymentApprovalRecordsPendingLocalChanges();
  await approvingLocalChangesCommitsPushesAndOpensPr();
  await mergedScriptSuccessWritesReporterReport();
  await nonZeroScriptIsDeploymentErrorAndIdempotent();
  await declinedAndPipelineFailureFailDeployment();
  await epicChildRollupWaitsForAllChildren();
  console.log("deployment-monitor tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
