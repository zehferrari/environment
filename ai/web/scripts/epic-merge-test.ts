import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectOriginBranch,
  inspectValidatedCandidateWorktree,
  mergeTaskBranchIntoEpic,
  publishEpicBranch,
  publishTaskCheckpointToEpic,
  removeMergedOriginChildBranch,
} from "../lib/deploy/epic-merge-git";

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

    // P6: task branches are LOCAL-ONLY by default; `push` covers the legacy
    // origin-branch fallback.
    const makeBranch = (
      name: string,
      changes: Array<{ path: string; content: string }>,
      opts: { push?: boolean } = {},
    ) => {
      git(cloneDir, "checkout", "-B", name, "main");
      for (const c of changes) writeFileSync(join(cloneDir, c.path), c.content);
      git(cloneDir, "add", "-A");
      git(cloneDir, "commit", "-m", `${name} change`);
      if (opts.push) git(cloneDir, "push", "-u", "origin", name);
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

    // 2. task branch absent locally AND on origin -> bounce, never noop-ok
    //    (a silent noop would record pm.epic.merge.ok for unintegrated work)
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "nope" });
    assert(!r.ok, "missing task branch must bounce (ok:false)");
    assert(/not found locally/i.test(r.ok ? "" : r.reason), "bounce must say the branch was not found locally");

    // 3. first Done task (LOCAL-ONLY branch) creates the Epic branch from base
    //    and merges in via refs/heads
    makeBranch("feat-a", [{ path: "a.txt", content: "aaa\n" }]);
    assert(
      git(cloneDir, "ls-remote", "--heads", "origin", "feat-a") === "",
      "test setup: feat-a must not be on origin",
    );
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "feat-a" });
    assert(r.ok && r.kind === "merged", "local-only feat-a must merge and create epic-x");
    git(cloneDir, "fetch", "--quiet", "origin");
    assert(
      git(cloneDir, "ls-tree", "-r", "--name-only", "origin/epic-x").includes("a.txt"),
      "epic-x must contain a.txt",
    );
    // Local Epic ref fast-forwarded to the pushed merge (not checked out anywhere).
    assert(
      git(cloneDir, "rev-parse", "refs/heads/epic-x") === git(cloneDir, "rev-parse", "origin/epic-x"),
      "local refs/heads/epic-x must be fast-forwarded to the pushed Epic tip",
    );

    // 4. second Done task (local-only) accumulates onto the same Epic branch
    makeBranch("feat-b", [{ path: "b.txt", content: "bbb\n" }]);
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "feat-b" });
    assert(r.ok && r.kind === "merged", "feat-b must merge into epic-x");
    git(cloneDir, "fetch", "--quiet", "origin");
    const files = git(cloneDir, "ls-tree", "-r", "--name-only", "origin/epic-x");
    assert(files.includes("a.txt") && files.includes("b.txt"), "epic-x must contain a.txt and b.txt");
    assert(
      git(cloneDir, "rev-parse", "refs/heads/epic-x") === git(cloneDir, "rev-parse", "origin/epic-x"),
      "local refs/heads/epic-x must track the pushed Epic tip after each merge",
    );

    // 5. idempotent — an already-integrated task is detected via the LOCAL
    //    Epic ref, not re-merged
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "feat-a" });
    assert(r.ok && r.kind === "already", "feat-a must be detected as already merged");

    // 6. legacy fallback — a task branch that exists ONLY on origin still merges
    makeBranch("feat-legacy", [{ path: "legacy.txt", content: "legacy\n" }], { push: true });
    git(cloneDir, "branch", "-D", "feat-legacy");
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-x", taskBranch: "feat-legacy" });
    assert(r.ok && r.kind === "merged", "origin-only feat-legacy must merge via the origin fallback");
    git(cloneDir, "fetch", "--quiet", "origin");
    assert(
      git(cloneDir, "ls-tree", "-r", "--name-only", "origin/epic-x").includes("legacy.txt"),
      "epic-x must contain legacy.txt",
    );

    // 7. conflicting task bounces (ok:false) and leaves the Epic branch untouched
    makeBranch("feat-c", [{ path: "base.txt", content: "lineC\nline2\nline3\n" }]);
    makeBranch("feat-d", [{ path: "base.txt", content: "lineD\nline2\nline3\n" }]);
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-y", taskBranch: "feat-c" });
    assert(r.ok && r.kind === "merged", "feat-c must merge into fresh epic-y");
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-y", taskBranch: "feat-d" });
    assert(!r.ok && /conflict/i.test(r.reason), "feat-d must conflict against epic-y");
    assert(
      !/push your branch|push \`/i.test(r.ok ? "" : r.reason),
      "conflict bounce must never instruct pushing the task branch",
    );
    git(cloneDir, "fetch", "--quiet", "origin");
    assert(
      !/feat-d/.test(git(cloneDir, "log", "--format=%s", "origin/epic-y")),
      "an aborted conflict must not advance the Epic branch",
    );

    // 8. local-already short-circuit pushes a lagging origin Epic ref: merge
    //    feat-e into the LOCAL epic-z only, then let the module detect
    //    "already merged locally" and publish the Epic branch itself.
    makeBranch("feat-e", [{ path: "e.txt", content: "eee\n" }]);
    git(cloneDir, "branch", "epic-z", "main");
    git(cloneDir, "checkout", "epic-z");
    git(cloneDir, "merge", "--no-ff", "--no-edit", "feat-e");
    git(cloneDir, "checkout", "main");
    assert(
      git(cloneDir, "ls-remote", "--heads", "origin", "epic-z") === "",
      "test setup: epic-z must not be on origin yet",
    );
    r = await mergeTaskBranchIntoEpic({ ...base, epicBranch: "epic-z", taskBranch: "feat-e" });
    assert(r.ok && r.kind === "already", "feat-e must be detected as merged into the local epic-z");
    git(cloneDir, "fetch", "--quiet", "origin");
    assert(
      git(cloneDir, "ls-tree", "-r", "--name-only", "origin/epic-z").includes("e.txt"),
      "the local-already path must push the Epic branch so origin has e.txt",
    );

    // 9. Epic-Done finalization publishes a local-ahead Epic branch even when
    //    no child merge happens during that transition.
    git(cloneDir, "checkout", "-B", "epic-final", "main");
    writeFileSync(join(cloneDir, "final.txt"), "final\n");
    git(cloneDir, "add", "-A");
    git(cloneDir, "commit", "-m", "local epic finalization");
    const finalSha = git(cloneDir, "rev-parse", "HEAD");
    git(cloneDir, "checkout", "main");
    const published = await publishEpicBranch({ repoPath: cloneDir, epicBranch: "epic-final" });
    assert(published.ok && published.kind === "pushed", "Epic finalization must push a local-ahead Epic branch");
    assert.equal(
      git(cloneDir, "ls-remote", "--heads", "origin", "epic-final").split(/\s+/)[0],
      finalSha,
      "origin Epic ref must equal the finalized local Epic tip",
    );

    // 10. A leaked remote task ref is removed only after its tip has been
    //     merged into and published on the Epic branch.
    makeBranch("feat-leaked", [{ path: "leaked.txt", content: "preserved\n" }], { push: true });
    assert.equal((await inspectOriginBranch(cloneDir, "feat-leaked")).sha?.length, 40);
    r = await mergeTaskBranchIntoEpic({
      ...base,
      epicBranch: "epic-final",
      taskBranch: "feat-leaked",
    });
    assert(r.ok, "leaked task work must still be preserved in the Epic branch");
    const removedRemote = await removeMergedOriginChildBranch({
      repoPath: cloneDir,
      epicBranch: "epic-final",
      taskBranch: "feat-leaked",
    });
    assert.equal(removedRemote.outcome, "removed", "merged leaked remote task ref must be deleted");
    assert.equal(
      (await inspectOriginBranch(cloneDir, "feat-leaked")).sha,
      null,
      "only the Epic ref should remain on origin",
    );

    // 11. Never delete a remote child whose tip is not preserved by the Epic.
    makeBranch("feat-unsafe", [{ path: "unsafe.txt", content: "not merged\n" }], { push: true });
    const preservedRemote = await removeMergedOriginChildBranch({
      repoPath: cloneDir,
      epicBranch: "epic-final",
      taskBranch: "feat-unsafe",
    });
    assert.equal(preservedRemote.outcome, "failed", "unmerged remote child must be preserved");
    assert.equal((await inspectOriginBranch(cloneDir, "feat-unsafe")).sha?.length, 40);

    // 12. An owner-authorized mid-task checkpoint commits the dirty local-only
    // child, publishes only the Epic branch, and advances the still-active
    // child worktree to the published Epic tip so later work has a clean base.
    const checkpointWt = join(root, "checkpoint-wt");
    git(cloneDir, "branch", "feat-checkpoint", "main");
    git(cloneDir, "worktree", "add", checkpointWt, "feat-checkpoint");
    writeFileSync(join(checkpointWt, "checkpoint.txt"), "first\n");
    let checkpoint = await publishTaskCheckpointToEpic({
      repoPath: cloneDir,
      worktreePath: checkpointWt,
      epicBranch: "epic-checkpoint",
      taskBranch: "feat-checkpoint",
      baseBranch: "main",
      gitUserName: "Checkpoint Bot",
      gitUserEmail: "checkpoint@example.com",
      commitSubject: "CHK-1 deployable checkpoint",
      mergeMessage: "Checkpoint CHK-1 into epic-checkpoint",
    });
    assert(checkpoint.ok && checkpoint.kind === "published", "dirty checkpoint must publish the Epic branch");
    assert(checkpoint.ok && checkpoint.createdCommit, "dirty checkpoint must create a PM-owned commit");
    git(cloneDir, "fetch", "--quiet", "origin");
    assert.equal(
      git(checkpointWt, "rev-parse", "HEAD"),
      git(cloneDir, "rev-parse", "origin/epic-checkpoint"),
      "active child branch must advance to the published Epic tip",
    );
    assert.equal(git(checkpointWt, "status", "--porcelain"), "", "checkpoint worktree must be clean");
    assert.equal(
      git(cloneDir, "ls-remote", "--heads", "origin", "feat-checkpoint"),
      "",
      "checkpoint must never publish the child branch",
    );
    assert.match(
      git(cloneDir, "log", "--format=%s", "origin/epic-checkpoint"),
      /CHK-1 deployable checkpoint/,
      "published Epic history must contain the prefixed PM checkpoint commit",
    );

    writeFileSync(join(checkpointWt, "checkpoint.txt"), "second\n");
    checkpoint = await publishTaskCheckpointToEpic({
      repoPath: cloneDir,
      worktreePath: checkpointWt,
      epicBranch: "epic-checkpoint",
      taskBranch: "feat-checkpoint",
      baseBranch: "main",
      gitUserName: "Checkpoint Bot",
      gitUserEmail: "checkpoint@example.com",
      commitSubject: "CHK-1 second deployable checkpoint",
      mergeMessage: "Checkpoint CHK-1 into epic-checkpoint",
    });
    assert(checkpoint.ok && checkpoint.kind === "published", "a later checkpoint must publish from the refreshed child base");
    assert.equal(
      git(checkpointWt, "rev-parse", "HEAD"),
      checkpoint.ok ? checkpoint.epicSha : "",
      "later checkpoint must leave the child at its new repository baseline",
    );

    // 13. Finalization is fenced to the exact clean candidate the reviewer
    // approved. Dirty changes, a moved HEAD, and a branch switch all invalidate
    // the candidate before any merge or push can occur.
    const candidateWt = join(root, "candidate-wt");
    git(cloneDir, "branch", "feat-candidate", "main");
    git(cloneDir, "worktree", "add", candidateWt, "feat-candidate");
    const candidateSha = git(candidateWt, "rev-parse", "HEAD");
    let candidate = await inspectValidatedCandidateWorktree({
      worktreePath: candidateWt,
      taskBranch: "feat-candidate",
      candidateSha,
    });
    assert(candidate.ok, "the exact clean reviewed candidate must pass the finalization fence");

    writeFileSync(join(candidateWt, "unreviewed.txt"), "dirty\n");
    candidate = await inspectValidatedCandidateWorktree({
      worktreePath: candidateWt,
      taskBranch: "feat-candidate",
      candidateSha,
    });
    assert(!candidate.ok && /changed after review validation/i.test(candidate.reason), "dirty work must invalidate review");
    git(candidateWt, "clean", "-f");

    git(candidateWt, "commit", "--allow-empty", "-m", "unreviewed candidate");
    candidate = await inspectValidatedCandidateWorktree({
      worktreePath: candidateWt,
      taskBranch: "feat-candidate",
      candidateSha,
    });
    assert(!candidate.ok && /moved to/i.test(candidate.reason), "a new commit must invalidate the reviewed SHA");
    git(candidateWt, "reset", "--hard", candidateSha);

    git(candidateWt, "checkout", "--detach", candidateSha);
    candidate = await inspectValidatedCandidateWorktree({
      worktreePath: candidateWt,
      taskBranch: "feat-candidate",
      candidateSha,
    });
    assert(!candidate.ok && /detached HEAD/i.test(candidate.reason), "a branch change must invalidate the candidate lease");

    console.log("epic-merge-test passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
