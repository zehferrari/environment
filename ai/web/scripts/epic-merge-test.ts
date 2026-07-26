import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTaskBranchIntoEpic } from "../lib/deploy/epic-merge-git";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "epic-merge-test-"));
  const originDir = join(root, "origin.git");
  const cloneDir = join(root, "clone");
  try {
    execFileSync("git", ["init", "--bare", "-b", "main", originDir]);
    execFileSync("git", ["clone", "--quiet", originDir, cloneDir]);
    git(cloneDir, "config", "user.name", "Test");
    git(cloneDir, "config", "user.email", "test@example.com");

    // base main
    writeFileSync(join(cloneDir, "base.txt"), "line1\nline2\nline3\n");
    git(cloneDir, "add", "-A");
    git(cloneDir, "commit", "-m", "base");
    git(cloneDir, "push", "-u", "origin", "main");

    const makeBranch = (name: string, changes: Array<{ path: string; content: string }>) => {
      git(cloneDir, "checkout", "-B", name, "main");
      for (const c of changes) writeFileSync(join(cloneDir, c.path), c.content);
      git(cloneDir, "add", "-A");
      git(cloneDir, "commit", "-m", `${name} change`);
      git(cloneDir, "push", "-u", "origin", name);
      git(cloneDir, "checkout", "main");
    };

    const base = {
      repoPath: cloneDir,
      baseBranch: "main",
      gitUserName: "PM Monitor",
      gitUserEmail: "pm@example.com",
      message: "merge",
    };

    // 1. task == epic branch -> no-op
    let r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "epic-x" });
    assert(r.ok && r.kind === "noop", "shared branch must be a no-op");

    // 2. task branch absent on origin -> no-op (non-code Epic child)
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "nope" });
    assert(r.ok && r.kind === "noop", "missing task branch must be a no-op");

    // 3. first Done task creates the Epic branch from base and merges in
    makeBranch("feat-a", [{ path: "a.txt", content: "aaa\n" }]);
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "feat-a" });
    assert(r.ok && r.kind === "merged", "feat-a must merge and create epic-x");
    git(cloneDir, "fetch", "--quiet", "origin");
    assert(
      git(cloneDir, "ls-tree", "-r", "--name-only", "origin/epic-x").includes("a.txt"),
      "epic-x must contain a.txt",
    );

    // 4. second Done task accumulates onto the same Epic branch
    makeBranch("feat-b", [{ path: "b.txt", content: "bbb\n" }]);
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "feat-b" });
    assert(r.ok && r.kind === "merged", "feat-b must merge into epic-x");
    git(cloneDir, "fetch", "--quiet", "origin");
    const files = git(cloneDir, "ls-tree", "-r", "--name-only", "origin/epic-x");
    assert(files.includes("a.txt") && files.includes("b.txt"), "epic-x must contain a.txt and b.txt");

    // 5. idempotent — an already-integrated task is detected, not re-merged
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "feat-a" });
    assert(r.ok && r.kind === "already", "feat-a must be detected as already merged");

    // 6. conflicting task bounces (ok:false) and leaves the Epic branch untouched
    makeBranch("feat-c", [{ path: "base.txt", content: "lineC\nline2\nline3\n" }]);
    makeBranch("feat-d", [{ path: "base.txt", content: "lineD\nline2\nline3\n" }]);
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-y", taskBranch: "feat-c" });
    assert(r.ok && r.kind === "merged", "feat-c must merge into fresh epic-y");
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-y", taskBranch: "feat-d" });
    assert(!r.ok && /conflict/i.test(r.reason), "feat-d must conflict against epic-y");
    git(cloneDir, "fetch", "--quiet", "origin");
    assert(
      !/feat-d/.test(git(cloneDir, "log", "--format=%s", "origin/epic-y")),
      "an aborted conflict must not advance the Epic branch",
    );

    console.log("epic-merge-test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
