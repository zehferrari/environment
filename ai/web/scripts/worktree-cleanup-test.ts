import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const helper = path.resolve(process.cwd(), "deploy/worktree-remove");

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runCleanup(repo: string, worktreesRoot: string, target: string, servedRoot = "", protectedBranches: string[] = []) {
  const lockFile = path.join(path.dirname(worktreesRoot), "worktree-operation.lock");
  try {
    return {
      ok: true,
      output: execFileSync("python3", [
        helper,
        repo,
        worktreesRoot,
        target,
        servedRoot ? "path" : "none",
        servedRoot,
        "",
        lockFile,
        JSON.stringify(protectedBranches),
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // Exercise the same ownership gate hit when the monitor runner uses a
        // worktree owned by another code-agents member.
        env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
      }).trim(),
    };
  } catch (error) {
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const output = [failed.stdout, failed.stderr]
      .map((value) => typeof value === "string" ? value : value?.toString("utf8") ?? "")
      .join("")
      .trim();
    return { ok: false, output, status: failed.status };
  }
}

function expectRejected(repo: string, worktreesRoot: string, target: string, reason: string, servedRoot = "", protectedBranches: string[] = []) {
  const result = runCleanup(repo, worktreesRoot, target, servedRoot, protectedBranches);
  assert.equal(result.ok, false, `${target} should be rejected`);
  assert.match(result.output, new RegExp(reason));
}

function commit(repo: string, filename: string, contents: string, subject: string) {
  writeFileSync(path.join(repo, filename), contents);
  git(repo, ["add", filename]);
  git(repo, ["commit", "-m", subject]);
}

function createBranch(repo: string, branch: string, merged: boolean) {
  git(repo, ["checkout", "-b", branch]);
  commit(repo, `${branch.replaceAll("/", "-")}.txt`, `${branch}\n`, branch);
  git(repo, ["checkout", "main"]);
  if (merged) git(repo, ["merge", "--no-ff", branch, "-m", `Merge ${branch}`]);
}

function addWorktree(repo: string, worktreesRoot: string, branch: string, name: string) {
  const worktree = path.join(worktreesRoot, name);
  git(repo, ["worktree", "add", worktree, branch]);
  return worktree;
}

function hasLocalBranch(repo: string, branch: string) {
  try {
    execFileSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const root = mkdtempSync(path.join(tmpdir(), "worktree-cleanup-"));
  try {
    const remote = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    const worktreesRoot = path.join(root, "repo.worktrees");
    git(root, ["init", "--bare", remote]);
    git(root, ["clone", remote, repo]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);
    commit(repo, "base.txt", "base\n", "base");
    git(repo, ["branch", "-M", "main"]);
    commit(repo, ".gitignore", ".openclaw/\n", "ignore agent runtime metadata");
    git(repo, ["push", "-u", "origin", "main"]);
    mkdirSync(worktreesRoot);
    writeFileSync(path.join(root, "worktree-operation.lock"), "");

    createBranch(repo, "feature/remove-me", true);
    git(repo, ["push", "origin", "feature/remove-me"]);
    const removeMe = addWorktree(repo, worktreesRoot, "feature/remove-me", "remove-me");
    expectRejected(repo, worktreesRoot, "missing", "unknown");

    const removed = runCleanup(repo, worktreesRoot, "remove-me");
    assert.equal(removed.ok, true, removed.output);
    assert.match(removed.output, /Remote branches were not changed/);
    assert.equal(existsSync(removeMe), false, "clean linked worktree should be removed");
    assert.equal(hasLocalBranch(repo, "feature/remove-me"), false, "local branch should be removed");
    execFileSync("git", ["--git-dir", remote, "show-ref", "--verify", "--quiet", "refs/heads/feature/remove-me"]);

    createBranch(repo, "feature/live", true);
    const live = addWorktree(repo, worktreesRoot, "feature/live", "live");
    expectRejected(repo, worktreesRoot, "live", "currently served", live);
    assert.equal(existsSync(live), true, "served worktree must remain");

    createBranch(repo, "feature/dirty", true);
    const dirty = addWorktree(repo, worktreesRoot, "feature/dirty", "dirty");
    writeFileSync(path.join(dirty, "uncommitted.txt"), "dirty\n");
    expectRejected(repo, worktreesRoot, "dirty", "local changes");
    assert.equal(existsSync(dirty), true, "dirty worktree must remain");

    git(repo, ["checkout", "-b", "feature/generated-version"]);
    mkdirSync(path.join(repo, "public"), { recursive: true });
    commit(repo, "public/version.json", "{\"commit\":\"base\",\"builtAt\":\"initial\"}\n", "generated version base");
    git(repo, ["checkout", "main"]);
    git(repo, ["merge", "--no-ff", "feature/generated-version", "-m", "Merge feature/generated-version"]);
    const generatedVersion = addWorktree(repo, worktreesRoot, "feature/generated-version", "generated-version");
    writeFileSync(path.join(generatedVersion, "public/version.json"), "{\"commit\":\"generated\",\"builtAt\":\"later\"}\n");
    const removedGeneratedVersion = runCleanup(repo, worktreesRoot, "generated-version");
    assert.equal(removedGeneratedVersion.ok, true, removedGeneratedVersion.output);
    assert.equal(existsSync(generatedVersion), false, "worktree with only a generated version stamp should be removable");
    assert.equal(hasLocalBranch(repo, "feature/generated-version"), false, "generated-version local branch should be removed");

    createBranch(repo, "feature/inaccessible-runtime", true);
    const inaccessibleRuntime = addWorktree(
      repo,
      worktreesRoot,
      "feature/inaccessible-runtime",
      "inaccessible-runtime",
    );
    const privateRuntime = path.join(inaccessibleRuntime, ".openclaw");
    mkdirSync(privateRuntime);
    writeFileSync(path.join(privateRuntime, "session.json"), "{}\n");
    chmodSync(privateRuntime, 0o000);
    expectRejected(repo, worktreesRoot, "inaccessible-runtime", "permission denied while preflighting");
    assert.equal(
      existsSync(path.join(inaccessibleRuntime, ".git")),
      true,
      "an inaccessible ignored runtime directory must be rejected before Git metadata is removed",
    );
    assert.equal(
      hasLocalBranch(repo, "feature/inaccessible-runtime"),
      true,
      "preflight rejection must preserve the local branch",
    );
    chmodSync(privateRuntime, 0o700);

    createBranch(repo, "feature/unmerged", false);
    git(repo, ["push", "origin", "feature/unmerged"]);
    const unmerged = addWorktree(repo, worktreesRoot, "feature/unmerged", "unmerged");
    const removedUnmerged = runCleanup(repo, worktreesRoot, "unmerged");
    assert.equal(removedUnmerged.ok, true, removedUnmerged.output);
    assert.equal(existsSync(unmerged), false, "clean unmerged worktree should be removable");
    assert.equal(hasLocalBranch(repo, "feature/unmerged"), false, "unmerged local branch should be removed");
    execFileSync("git", ["--git-dir", remote, "show-ref", "--verify", "--quiet", "refs/heads/feature/unmerged"]);

    createBranch(repo, "feature/stale-upstream", true);
    git(repo, ["branch", "--set-upstream-to=origin/main", "feature/stale-upstream"]);
    const staleUpstream = addWorktree(repo, worktreesRoot, "feature/stale-upstream", "stale-upstream");
    const removedStaleUpstream = runCleanup(repo, worktreesRoot, "stale-upstream");
    assert.equal(removedStaleUpstream.ok, true, removedStaleUpstream.output);
    assert.equal(existsSync(staleUpstream), false, "clean worktree with a stale upstream should be removable");
    assert.equal(hasLocalBranch(repo, "feature/stale-upstream"), false, "stale-upstream local branch should be removed");

    git(repo, ["branch", "develop", "main"]);
    const protectedWorktree = addWorktree(repo, worktreesRoot, "develop", "develop");
    expectRejected(repo, worktreesRoot, "develop", "protected local branch");
    assert.equal(existsSync(protectedWorktree), true, "protected branch worktree must remain");

    createBranch(repo, "release/stable", true);
    const configuredProtected = addWorktree(repo, worktreesRoot, "release/stable", "release-stable");
    expectRejected(repo, worktreesRoot, "release-stable", "protected local branch", "", ["release/stable"]);
    assert.equal(existsSync(configuredProtected), true, "configured protected branch worktree must remain");

    const detached = path.join(worktreesRoot, "detached");
    git(repo, ["worktree", "add", "--detach", detached, "HEAD"]);
    const detachedResult = runCleanup(repo, worktreesRoot, "detached");
    assert.equal(detachedResult.ok, true, detachedResult.output);
    assert.equal(existsSync(detached), false, "clean detached worktree should be removable");

    createBranch(repo, "feature/detached-unmerged", false);
    const detachedUnmerged = path.join(worktreesRoot, "detached-unmerged");
    git(repo, ["worktree", "add", "--detach", detachedUnmerged, "feature/detached-unmerged"]);
    const removedDetachedUnmerged = runCleanup(repo, worktreesRoot, "detached-unmerged");
    assert.equal(removedDetachedUnmerged.ok, true, removedDetachedUnmerged.output);
    assert.equal(existsSync(detachedUnmerged), false, "clean detached worktree with unmerged commits should be removable");
    assert.equal(hasLocalBranch(repo, "feature/detached-unmerged"), true, "detached removal should not delete a local branch");

    createBranch(repo, "feature/outside", true);
    const outside = path.join(root, "outside");
    git(repo, ["worktree", "add", outside, "feature/outside"]);
    expectRejected(repo, worktreesRoot, "outside", "outside the managed root");
    assert.equal(existsSync(outside), true, "outside worktree must remain");

    expectRejected(repo, worktreesRoot, path.basename(repo), "primary checkout", repo);

    createBranch(repo, "feature/symlink-a", true);
    createBranch(repo, "feature/symlink-b", true);
    const symlinkA = addWorktree(repo, worktreesRoot, "feature/symlink-a", "symlink-a");
    const symlinkB = addWorktree(repo, worktreesRoot, "feature/symlink-b", "symlink-b");
    rmSync(symlinkA, { recursive: true, force: true });
    symlinkSync(symlinkB, symlinkA, "dir");
    expectRejected(repo, worktreesRoot, "symlink-a", "resolves through a symlink");
    assert.equal(existsSync(symlinkB), true, "a symlinked target must not remove another worktree");
    assert.equal(hasLocalBranch(repo, "feature/symlink-b"), true, "the other local branch must remain");

    const lockFile = path.join(root, "worktree-operation.lock");
    rmSync(lockFile, { force: true });
    symlinkSync(symlinkB, lockFile, "file");
    expectRejected(repo, worktreesRoot, "live", "invalid worktree operation lock");
    assert.equal(existsSync(live), true, "an unsafe lock path must not start removal");

    const helperSource = readFileSync(helper, "utf8");
    assert.match(helperSource, /def assert_tree_removable\(worktree_path\):/);
    assert.match(helperSource, /os\.walk\([\s\S]*?onerror=inspection_error/);
    assert.match(helperSource, /assert_tree_removable\(worktree_path\)[\s\S]*?\["worktree", "remove", worktree_path\]/);
    assert.match(helperSource, /Git partially removed worktree metadata/);
    assert.match(helperSource, /remove_registered_worktree\(repo_real, selected_path\)/);
    assert.match(helperSource, /remove_registered_worktree\(repo_real, holder_path\)/);
    assert.match(helperSource, /\["branch", "-D", "--", branch\]/);
    assert.match(helperSource, /public\/version\.json/);
    assert.match(helperSource, /O_NOFOLLOW/);
    assert.match(helperSource, /safe\.directory=/);
    assert.doesNotMatch(helperSource, /--force|\["push"/);

    // Every monitor-owned Git path must use an exact, invocation-scoped
    // safe.directory override. Persistent or wildcard trust would weaken the
    // account for unrelated repositories.
    for (const gitUser of [
      "deploy/pm-switch.sh",
      "deploy/pm-switch-runner",
      "deploy/worktree-switch.sh",
      "deploy/worktree-switch-runner",
      "deploy/worktree-remove",
    ]) {
      const source = readFileSync(path.resolve(process.cwd(), gitUser), "utf8");
      assert.match(source, /safe\.directory=/, `${gitUser} must scope Git trust to its repository`);
      assert.doesNotMatch(source, /safe\.directory=\*|config\s+--global[^\n]*safe\.directory/);
    }
    const actionSource = readFileSync(path.resolve(process.cwd(), "lib/deploy/actions.ts"), "utf8");
    assert.match(actionSource, /requestLocalWorktreeRemoval[\s\S]*?const owner = await requireOwner\(\)/);
    assert.match(actionSource, /protectedBranches/);
    assert.match(actionSource, /REQUEST_LOCK_STALE_MS/);
    for (const runner of ["deploy/pm-switch-runner", "deploy/worktree-switch-runner"]) {
      const source = readFileSync(path.resolve(process.cwd(), runner), "utf8");
      assert.match(source, /action == "remove"/);
      assert.match(source, /worktree-remove/);
    }

    // A generic switcher upgraded from before local cleanup existed may have
    // neither WORKTREE_LOCK_FILE in its contract nor the lock itself. The
    // project installer must repair both and restart the long-running runner;
    // otherwise an attempted removal is misrouted through stale switch code.
    const genericInstaller = readFileSync(path.resolve(process.cwd(), "deploy/worktree-preview-install.sh"), "utf8");
    const patriciaInstaller = genericInstaller.slice(
      genericInstaller.indexOf("install_patricia()"),
      genericInstaller.indexOf("migrate_pm()"),
    );
    assert.match(genericInstaller, /ensure_operation_lock\(\)/);
    assert.match(genericInstaller, /if \[\[ ! -e "\$lock_file" \]\]/);
    assert.match(genericInstaller, /else\n\s+chown root:"\$CODE_GROUP" "\$lock_file"/);
    assert.match(genericInstaller, /write_contract\(\)/);
    assert.match(genericInstaller, /verify_operation_contract\(\)/);
    assert.match(patriciaInstaller, /ensure_operation_lock "\$lock_file"/);
    assert.match(patriciaInstaller, /WORKTREE_LOCK_FILE=\$lock_file/);
    assert.match(patriciaInstaller, /verify_operation_contract "\$key" "\$lock_file"/);
    assert.match(patriciaInstaller, /systemctl restart "worktree-switch-runner@\$key\.service"/);
    assert.match(genericInstaller, /quiesce_shared_runners\(\)/);
    assert.match(genericInstaller, /quiesce_runner wdt\s+quiesce_runner patricia/);
    assert.match(genericInstaller, /acquire_operation_lock wdt\s+acquire_operation_lock patricia/);
    assert.match(genericInstaller, /flock -w 30 "\$fd"/);
    assert.match(genericInstaller, /release_all_operation_locks/);
    assert.match(genericInstaller, /if \(\( status == 0 \)\); then\s+log "Reloading \$unit after shared-helper reconciliation/);
    assert.match(genericInstaller, /patricia\)\s+quiesce_shared_runners; install_shared; install_patricia/);
    assert.match(genericInstaller, /wdt\)\s+quiesce_shared_runners; install_shared; install_wdt/);
    assert.match(genericInstaller, /migrate-pm\)\s+quiesce_shared_runners; install_shared; migrate_pm/);
    assert.match(genericInstaller, /trap restore_quiesced_runners EXIT/);
    assert.match(genericInstaller, /QUIESCED_RUNNERS\+=\("\$key"\)/);
    assert.match(genericInstaller, /installer exited before \$key reconciliation completed; restoring \$unit/);
    const statusCheck = genericInstaller.slice(
      genericInstaller.indexOf("show_status()"),
      genericInstaller.indexOf('case "${1:-all}"'),
    );
    assert.match(statusCheck, /expected WORKTREE_LOCK_FILE=\$expected_lock/);
    assert.match(statusCheck, /runner predates an installed helper and has not loaded it/);

    console.log("worktree-cleanup-test ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
