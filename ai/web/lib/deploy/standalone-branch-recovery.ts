import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type StandaloneBranchRecoveryResult = {
  ok: boolean;
  changed: boolean;
  originalSha: string | null;
  recoveredSha: string | null;
  remoteSha: string | null;
  baseSha: string | null;
  mergedRefs: string[];
  error: string | null;
  operational: boolean;
};

async function git(repo: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOrNull(repo: string, args: string[], timeout = 10_000): Promise<string | null> {
  try {
    return await git(repo, args, timeout);
  } catch {
    return null;
  }
}

function trimError(error: unknown, max = 900): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, max);
}

async function isAncestor(repo: string, ancestor: string, descendant = "HEAD"): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant], 10_000);
    return true;
  } catch {
    return false;
  }
}

async function refreshOptionalTaskRef(repo: string, branch: string): Promise<{
  remoteSha: string | null;
  error: string | null;
}> {
  try {
    const advertised = await git(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], 30_000);
    if (!advertised) return { remoteSha: null, error: null };
    await git(
      repo,
      ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      60_000,
    );
    return {
      remoteSha: await gitOrNull(repo, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]),
      error: null,
    };
  } catch (error) {
    return { remoteSha: null, error: trimError(error) };
  }
}

/**
 * Reconcile a clean standalone task branch with both its published task ref
 * and the current review base. Every required head remains an ancestor of the
 * result, so publication is always a normal fast-forward. Conflicts roll back
 * to the exact original clean HEAD; force-push and rebase are never used.
 */
export async function reconcileStandaloneBranch(args: {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  gitUserName: string | null | undefined;
  gitUserEmail: string | null | undefined;
}): Promise<StandaloneBranchRecoveryResult> {
  const originalSha = await gitOrNull(args.worktreePath, ["rev-parse", "--verify", "HEAD"]);
  const baseRef = `refs/remotes/origin/${args.baseBranch}`;
  const baseSha = await gitOrNull(args.worktreePath, ["rev-parse", "--verify", baseRef]);
  const currentBranch = await gitOrNull(args.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = await gitOrNull(args.worktreePath, ["status", "--porcelain"]);
  if (!originalSha || !baseSha || currentBranch !== args.branchName) {
    return {
      ok: false,
      changed: false,
      originalSha,
      recoveredSha: originalSha,
      remoteSha: null,
      baseSha,
      mergedRefs: [],
      error: !baseSha
        ? `${baseRef} is unavailable for recovery`
        : `registered worktree is on ${currentBranch ?? "an unreadable branch"}, expected ${args.branchName}`,
      operational: false,
    };
  }
  if (dirty) {
    return {
      ok: false,
      changed: false,
      originalSha,
      recoveredSha: originalSha,
      remoteSha: null,
      baseSha,
      mergedRefs: [],
      error: "automatic graph recovery requires a clean worktree; assignee changes were left untouched",
      operational: false,
    };
  }
  const refreshed = await refreshOptionalTaskRef(args.worktreePath, args.branchName);
  if (refreshed.error) {
    return {
      ok: false,
      changed: false,
      originalSha,
      recoveredSha: originalSha,
      remoteSha: null,
      baseSha,
      mergedRefs: [],
      error: refreshed.error,
      operational: true,
    };
  }

  const requiredRefs = [
    refreshed.remoteSha ? `refs/remotes/origin/${args.branchName}` : null,
    baseRef,
  ].filter((value): value is string => Boolean(value));
  const mergedRefs: string[] = [];
  try {
    for (const requiredRef of requiredRefs) {
      if (await isAncestor(args.worktreePath, requiredRef)) continue;
      if (await isAncestor(args.worktreePath, "HEAD", requiredRef)) {
        await git(args.worktreePath, ["merge", "--ff-only", requiredRef], 90_000);
      } else {
        if (!args.gitUserName || !args.gitUserEmail) {
          throw new Error("effective project Git identity is incomplete; PM cannot create a recovery merge");
        }
        await git(
          args.worktreePath,
          [
            "-c",
            `user.name=${args.gitUserName}`,
            "-c",
            `user.email=${args.gitUserEmail}`,
            "merge",
            "--no-edit",
            "--no-ff",
            requiredRef,
          ],
          90_000,
        );
      }
      mergedRefs.push(requiredRef);
    }

    const recoveredSha = await gitOrNull(args.worktreePath, ["rev-parse", "HEAD"]);
    const baseContained = await isAncestor(args.worktreePath, baseRef);
    const remoteContained = refreshed.remoteSha
      ? await isAncestor(args.worktreePath, `refs/remotes/origin/${args.branchName}`)
      : true;
    const cleanAfter = await gitOrNull(args.worktreePath, ["status", "--porcelain"]);
    if (!recoveredSha || !baseContained || !remoteContained || cleanAfter) {
      throw new Error("recovery result failed containment or cleanliness verification");
    }
    return {
      ok: true,
      changed: recoveredSha !== originalSha,
      originalSha,
      recoveredSha,
      remoteSha: refreshed.remoteSha,
      baseSha,
      mergedRefs,
      error: null,
      operational: false,
    };
  } catch (error) {
    await git(args.worktreePath, ["merge", "--abort"], 30_000).catch(() => undefined);
    await git(args.worktreePath, ["reset", "--hard", originalSha], 30_000).catch(() => undefined);
    return {
      ok: false,
      changed: false,
      originalSha,
      recoveredSha: await gitOrNull(args.worktreePath, ["rev-parse", "HEAD"]),
      remoteSha: refreshed.remoteSha,
      baseSha,
      mergedRefs: [],
      error: `automatic recovery could not preserve both histories cleanly: ${trimError(error)}`,
      operational: false,
    };
  }
}
