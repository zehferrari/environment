import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pure git operations for Epic-branch auto-merge — deliberately free of any DB /
// app imports so the merge logic can be unit-tested against real throwaway
// repositories. The DB orchestration (poll / enqueue / record / bounce) lives in
// lib/deploy/epic-merge.ts and runs through the pm-epic-merge-runner spool.

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

async function localRefExists(repoPath: string, branch: string) {
  return gitOk(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
}

async function isAncestor(repoPath: string, maybeAncestor: string, ref: string) {
  return gitOk(repoPath, ["merge-base", "--is-ancestor", maybeAncestor, ref]);
}

// True when refs/heads/<branch> is checked out in the primary checkout or any
// linked worktree — `git branch -f` refuses to move a checked-out ref.
async function branchCheckedOut(repoPath: string, branch: string) {
  try {
    const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
    return out.split("\n").includes(`branch refs/heads/${branch}`);
  } catch {
    return true; // unknown — be conservative, skip the ref update
  }
}

// Best-effort: keep the local Epic ref in step with what was just pushed so
// local-only child branches (P6) always have a fresh local merge target and
// claim-branch --epic bases new siblings on current work. Never moves a
// checked-out or diverged ref; failures are ignored (origin stays canonical).
async function fastForwardLocalEpicRef(repoPath: string, epicBranch: string, sha: string) {
  if (await branchCheckedOut(repoPath, epicBranch)) return;
  if (!(await localRefExists(repoPath, epicBranch))) {
    await gitOk(repoPath, ["branch", epicBranch, sha]);
    return;
  }
  if (await isAncestor(repoPath, `refs/heads/${epicBranch}`, sha)) {
    await gitOk(repoPath, ["branch", "-f", epicBranch, sha]);
  }
}

export type EpicMergeResult =
  | { ok: true; kind: "merged"; sha: string }
  | { ok: true; kind: "already" }
  | { ok: true; kind: "noop"; note: string }
  | { ok: false; reason: string };

// Merge a Done task's branch into the Epic integration branch (creating the
// Epic branch from origin/<baseBranch> when it does not exist yet) and push
// only the Epic branch back. Task branches are LOCAL-ONLY under the P6 model:
// the merge source is refs/heads/<taskBranch> first, with origin/<taskBranch>
// kept as a legacy fallback for branches pushed before the policy change. A
// task branch missing from BOTH is a bounce (ok:false), never a silent no-op —
// treating it as a no-op would record pm.epic.merge.ok for work that was never
// integrated. Never touches the shared working tree: all work happens in a
// throwaway detached worktree. Returns a discriminated result; the caller
// decides how to record it.
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
  // The runner executing this has full network/SSH, so a fetch failure means
  // every origin/* decision below would run on stale refs — bounce instead.
  try {
    await git(repoPath, ["fetch", "--quiet", "--prune", "origin"]);
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err).slice(0, 200);
    return {
      ok: false,
      reason: `\`git fetch origin\` failed for the merge runner (${detail}) — refusing to merge \`${taskBranch}\` against possibly stale refs. Fix runner connectivity/credentials, then move the task to Done again.`,
    };
  }

  let source: string;
  if (await localRefExists(repoPath, taskBranch)) {
    source = `refs/heads/${taskBranch}`;
  } else if (await originRefExists(repoPath, taskBranch)) {
    source = `refs/remotes/origin/${taskBranch}`;
  } else {
    return {
      ok: false,
      reason: `Task branch \`${taskBranch}\` was not found locally (refs/heads) or on origin — do not mark the task Done until the branch exists. Commit your work locally on \`${taskBranch}\` (Epic-child branches are never pushed), then move the task to Done again.`,
    };
  }

  const localEpicExists = await localRefExists(repoPath, epicBranch);
  const originEpicExists = await originRefExists(repoPath, epicBranch);

  // Ancestor short-circuit, local ref first: a manual/local integration counts,
  // but origin must contain it too before we call it done — push the Epic
  // branch eagerly when origin is behind so the pushed Epic ref stays the
  // canonical record (cleanup verifies against it).
  const inLocalEpic = localEpicExists && (await isAncestor(repoPath, source, `refs/heads/${epicBranch}`));
  const inOriginEpic = originEpicExists && (await isAncestor(repoPath, source, `refs/remotes/origin/${epicBranch}`));
  if (inOriginEpic) {
    if (inLocalEpic || !localEpicExists) return { ok: true, kind: "already" };
    // origin has it, local ref is stale — refresh it best-effort.
    const originSha = await git(repoPath, ["rev-parse", `refs/remotes/origin/${epicBranch}`]).catch(() => null);
    if (originSha) await fastForwardLocalEpicRef(repoPath, epicBranch, originSha);
    return { ok: true, kind: "already" };
  }
  if (inLocalEpic) {
    if (!(await gitOk(repoPath, ["push", "origin", `refs/heads/${epicBranch}:refs/heads/${epicBranch}`]))) {
      return {
        ok: false,
        reason: `\`${taskBranch}\` is already merged into the local Epic branch \`${epicBranch}\`, but pushing the Epic branch to origin failed (permissions or a concurrent update).`,
      };
    }
    return { ok: true, kind: "already" };
  }

  let base: string;
  if (originEpicExists) {
    base = `refs/remotes/origin/${epicBranch}`;
  } else if (localEpicExists) {
    // Epic branch created locally (claim-branch --epic) but never pushed yet.
    base = `refs/heads/${epicBranch}`;
  } else if (await originRefExists(repoPath, baseBranch)) {
    base = `refs/remotes/origin/${baseBranch}`;
  } else {
    return {
      ok: false,
      reason: `Neither the Epic branch \`${epicBranch}\` (local or origin) nor its base branch \`${baseBranch}\` exists on origin, so the Epic integration branch could not be created.`,
    };
  }

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
      ["merge", "--no-ff", "--no-edit", "-m", args.message, source],
      identityEnv,
    );
    if (!merged) {
      await gitOk(wt, ["merge", "--abort"]);
      return {
        ok: false,
        reason: `Merging \`${taskBranch}\` into the Epic branch \`${epicBranch}\` hit a conflict. Merge the Epic branch \`${epicBranch}\` into your task branch (or rebase onto it), resolve the conflict, commit the resolution locally, then move the task to Done again. Do not push Epic-child branches.`,
      };
    }
    const sha = await git(wt, ["rev-parse", "HEAD"]);
    if (!(await gitOk(wt, ["push", "origin", `HEAD:refs/heads/${epicBranch}`]))) {
      return {
        ok: false,
        reason: `Merged \`${taskBranch}\` locally but pushing the Epic branch \`${epicBranch}\` to origin failed (permissions or a concurrent update).`,
      };
    }
    await fastForwardLocalEpicRef(repoPath, epicBranch, sha);
    return { ok: true, kind: "merged", sha };
  } finally {
    await gitOk(repoPath, ["worktree", "remove", "--force", wt]);
    await rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}
