import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileStandaloneBranch } from "../lib/deploy/standalone-branch-recovery";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(repo: string, file: string, content: string, subject: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "-m", subject]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "pm-standalone-recovery-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const worktree = join(root, "worktree");
  try {
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "-b", "master", seed], { stdio: "ignore" });
    git(seed, ["config", "user.name", "PM Test"]);
    git(seed, ["config", "user.email", "pm-test@example.invalid"]);
    const base0 = commitFile(seed, "base.txt", "base 0\n", "base 0");
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "master"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/master"]);

    git(seed, ["checkout", "-b", "feature/recover", base0]);
    const remoteTask = commitFile(seed, "task.txt", "same task result\n", "TASK-1 remote submission");
    git(seed, ["push", "-u", "origin", "feature/recover"]);
    git(seed, ["checkout", "master"]);
    const base1 = commitFile(seed, "base.txt", "base 1\n", "advance base");
    git(seed, ["push", "origin", "master"]);

    execFileSync("git", ["clone", remote, worktree], { stdio: "ignore" });
    git(worktree, ["config", "user.name", "PM Test"]);
    git(worktree, ["config", "user.email", "pm-test@example.invalid"]);
    git(worktree, ["checkout", "-b", "feature/recover", base0]);
    commitFile(worktree, "task.txt", "same task result\n", "TASK-1 local submission");
    git(worktree, ["fetch", "origin", "+refs/heads/master:refs/remotes/origin/master"]);
    const localBefore = git(worktree, ["rev-parse", "HEAD"]);

    const recovered = await reconcileStandaloneBranch({
      worktreePath: worktree,
      branchName: "feature/recover",
      baseBranch: "master",
      gitUserName: "PM Test",
      gitUserEmail: "pm-test@example.invalid",
    });
    assert.equal(recovered.ok, true, recovered.error ?? "recovery should succeed");
    assert.equal(recovered.changed, true);
    assert.equal(git(worktree, ["status", "--porcelain"]), "");
    assert.doesNotThrow(() => git(worktree, ["merge-base", "--is-ancestor", remoteTask, "HEAD"]));
    assert.doesNotThrow(() => git(worktree, ["merge-base", "--is-ancestor", base1, "HEAD"]));
    assert.notEqual(git(worktree, ["rev-parse", "HEAD"]), localBefore);
    git(worktree, ["push", "origin", "feature/recover"]);
    assert.equal(
      git(worktree, ["rev-parse", "HEAD"]),
      git(worktree, ["rev-parse", "origin/feature/recover"]),
      "the recovered candidate must publish with a normal fast-forward push",
    );

    git(seed, ["checkout", "master"]);
    git(seed, ["checkout", "-b", "feature/conflict", base1]);
    commitFile(seed, "conflict.txt", "remote\n", "remote conflict");
    git(seed, ["push", "origin", "feature/conflict"]);
    git(worktree, ["checkout", "-b", "feature/conflict", base1]);
    commitFile(worktree, "conflict.txt", "local\n", "local conflict");
    const conflictHead = git(worktree, ["rev-parse", "HEAD"]);
    const conflictResult = await reconcileStandaloneBranch({
      worktreePath: worktree,
      branchName: "feature/conflict",
      baseBranch: "master",
      gitUserName: "PM Test",
      gitUserEmail: "pm-test@example.invalid",
    });
    assert.equal(conflictResult.ok, false, "a real content conflict must stop recovery");
    assert.match(conflictResult.error ?? "", /could not preserve both histories cleanly/);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), conflictHead, "conflict rollback must restore HEAD");
    assert.equal(git(worktree, ["status", "--porcelain"]), "", "conflict rollback must restore cleanliness");

    writeFileSync(join(worktree, "dirty.txt"), "do not touch\n");
    const dirtyHead = git(worktree, ["rev-parse", "HEAD"]);
    const dirtyResult = await reconcileStandaloneBranch({
      worktreePath: worktree,
      branchName: "feature/conflict",
      baseBranch: "master",
      gitUserName: "PM Test",
      gitUserEmail: "pm-test@example.invalid",
    });
    assert.equal(dirtyResult.ok, false);
    assert.match(dirtyResult.error ?? "", /requires a clean worktree/);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), dirtyHead);
    assert.match(git(worktree, ["status", "--porcelain"]), /dirty\.txt/);

    console.log("standalone-branch-recovery-test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
