import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTaskGitChanges } from "@/lib/tasks/git-changes";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(repo: string, file: string, body: string, subject: string) {
  writeFileSync(path.join(repo, file), body);
  git(repo, ["add", file]);
  git(repo, ["commit", "-m", subject]);
}

async function main() {
  const repo = mkdtempSync(path.join(tmpdir(), "task-git-changes-"));
  try {
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);

    commit(repo, "base.txt", "base\n", "base commit");
    commit(repo, "custom.txt", "custom\n", "CUSTOM-42 custom-prefix change");
    commit(repo, "task.txt", "task\n", "ENV-109 task-id fallback change");

    const customOnly = await getTaskGitChanges({
      repositoryPath: repo,
      branchName: "main",
      commitPrefix: "CUSTOM-42",
    });
    assert.equal(customOnly.error, null);
    assert.deepEqual(customOnly.commits.map((commit) => commit.subject), ["CUSTOM-42 custom-prefix change"]);

    const customOrTaskKey = await getTaskGitChanges({
      repositoryPath: repo,
      branchName: "main",
      commitPrefix: ["CUSTOM-42", "ENV-109"],
    });
    assert.equal(customOrTaskKey.error, null);
    assert.deepEqual(
      customOrTaskKey.commits.map((commit) => commit.subject),
      ["ENV-109 task-id fallback change", "CUSTOM-42 custom-prefix change"],
    );

    git(repo, ["checkout", "-b", "custom-branch"]);
    commit(repo, "branch.txt", "branch\n", "ENV-109 branch-specific change");

    const branchSpecific = await getTaskGitChanges({
      repositoryPath: repo,
      branchName: "custom-branch",
      commitPrefix: ["CUSTOM-42", "ENV-109"],
    });
    assert.equal(branchSpecific.error, null);
    assert.equal(branchSpecific.ref, "custom-branch");
    assert.equal(branchSpecific.commits[0]?.subject, "ENV-109 branch-specific change");

    console.log("task-git-changes-test ok");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
