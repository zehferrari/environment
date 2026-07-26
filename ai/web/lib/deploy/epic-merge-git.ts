import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pure git operations for Epic-branch auto-merge — deliberately free of any DB /
// app imports so the merge logic can be unit-tested against real throwaway
// repositories. The DB orchestration (poll / record / bounce) lives in
// lib/deploy/epic-merge.ts.

const execFileAsync = promisify(execFile);

let worktreeCounter = 0;

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 1024 * 1024 * 8,
    timeout: 120_000,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return String(stdout).trim();
}

async function gitOk(cwd: string, args: string[], env?: Record<string, string>) {
  try {
    await git(cwd, args, env);
    return true;
  } catch {
    return false;
  }
}

async function originRefExists(repoPath: string, branch: string) {
  return gitOk(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
}

export type EpicMergeResult =
  | { ok: true; kind: "merged"; sha: string }
  | { ok: true; kind: "already" }
  | { ok: true; kind: "noop"; note: string }
  | { ok: false; reason: string };

// Merge origin/<taskBranch> into origin/<epicBranch> (creating the Epic branch
// from origin/<baseBranch> when it does not exist yet) and push it back. Never
// touches the shared working tree: all work happens in a throwaway detached
// worktree. Returns a discriminated result; the caller decides how to record it.
export async function mergeTaskBranchIntoEpic(args: {
  repoPath: string;
  epicBranch: string;
  taskBranch: string;
  baseBranch: string;
  gitUserName: string;
  gitUserEmail: string;
  message: string;
}): Promise<EpicMergeResult> {
  const { repoPath, epicBranch, taskBranch, baseBranch } = args;

  if (!taskBranch || !epicBranch) return { ok: true, kind: "noop", note: "missing branch name" };
  if (taskBranch === epicBranch) {
    return { ok: true, kind: "noop", note: "task shares the Epic branch — nothing to merge" };
  }

  // Refresh origin refs. An earlier task in the same poll may have advanced the
  // Epic branch; --prune keeps deleted branches from lingering as stale refs.
  await git(repoPath, ["fetch", "--quiet", "--prune", "origin"]).catch(() => {});

  if (!(await originRefExists(repoPath, taskBranch))) {
    // No branch on origin means the task carried no pushed code (e.g. a non-code
    // Epic child). Nothing to integrate — treat as a clean no-op.
    return { ok: true, kind: "noop", note: `no origin branch \`${taskBranch}\` — nothing to merge` };
  }

  const epicExists = await originRefExists(repoPath, epicBranch);
  if (epicExists) {
    const already = await gitOk(repoPath, [
      "merge-base",
      "--is-ancestor",
      `origin/${taskBranch}`,
      `origin/${epicBranch}`,
    ]);
    if (already) return { ok: true, kind: "already" };
  } else if (!(await originRefExists(repoPath, baseBranch))) {
    return {
      ok: false,
      reason: `Neither the Epic branch \`${epicBranch}\` nor its base branch \`${baseBranch}\` exists on origin, so the Epic integration branch could not be created.`,
    };
  }

  const base = epicExists ? `origin/${epicBranch}` : `origin/${baseBranch}`;
  const identityEnv: Record<string, string> = {
    GIT_AUTHOR_NAME: args.gitUserName,
    GIT_AUTHOR_EMAIL: args.gitUserEmail,
    GIT_COMMITTER_NAME: args.gitUserName,
    GIT_COMMITTER_EMAIL: args.gitUserEmail,
  };

  worktreeCounter += 1;
  const wt = join(tmpdir(), `pm-epic-merge-${process.pid}-${Date.now()}-${worktreeCounter}`);
  try {
    if (!(await gitOk(repoPath, ["worktree", "add", "--detach", "--force", wt, base]))) {
      return { ok: false, reason: `Could not create a merge worktree from \`${base}\` for Epic branch \`${epicBranch}\`.` };
    }
    const merged = await gitOk(
      wt,
      ["merge", "--no-ff", "--no-edit", "-m", args.message, `origin/${taskBranch}`],
      identityEnv,
    );
    if (!merged) {
      await gitOk(wt, ["merge", "--abort"]);
      return {
        ok: false,
        reason: `Merging \`${taskBranch}\` into the Epic branch \`${epicBranch}\` hit a conflict. Rebase your branch on \`${epicBranch}\`, resolve the conflict, push, then move the task to Done again.`,
      };
    }
    const sha = await git(wt, ["rev-parse", "HEAD"]);
    if (!(await gitOk(wt, ["push", "origin", `HEAD:refs/heads/${epicBranch}`]))) {
      return {
        ok: false,
        reason: `Merged \`${taskBranch}\` locally but pushing the Epic branch \`${epicBranch}\` to origin failed (permissions or a concurrent update).`,
      };
    }
    return { ok: true, kind: "merged", sha };
  } finally {
    await gitOk(repoPath, ["worktree", "remove", "--force", wt]);
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}
