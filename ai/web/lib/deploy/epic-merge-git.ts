import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, realpath } from "node:fs/promises";
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

async function validBranchName(repoPath: string, branch: string) {
  if (!branch.trim()) return false;
  return gitOk(repoPath, ["check-ref-format", "--branch", branch]);
}

export type OriginBranchInspection =
  | { ok: true; sha: string | null }
  | { ok: false; sha: null; reason: string };

export type ValidatedCandidateWorktreeInspection =
  | { ok: true; sha: string }
  | { ok: false; reason: string };

// A review approves one exact commit in one registered task worktree. This
// check belongs next to the Git primitives so every finalizer can apply the
// same last-moment fence before it mutates an Epic or remote branch.
export async function inspectValidatedCandidateWorktree(args: {
  worktreePath: string;
  taskBranch: string;
  candidateSha: string;
}): Promise<ValidatedCandidateWorktreeInspection> {
  try {
    const [dirty, head, branch] = await Promise.all([
      git(args.worktreePath, ["status", "--porcelain"]),
      git(args.worktreePath, ["rev-parse", "HEAD"]),
      git(args.worktreePath, ["branch", "--show-current"]),
    ]);
    if (dirty) {
      return {
        ok: false,
        reason: "The task worktree changed after review validation. Commit and validate the new candidate before finalization.",
      };
    }
    if (branch !== args.taskBranch) {
      return {
        ok: false,
        reason: `The registered worktree is on ${branch || "a detached HEAD"}; expected task branch ${args.taskBranch}.`,
      };
    }
    if (head !== args.candidateSha) {
      return {
        ok: false,
        reason: `The task worktree moved to ${head || "an unknown commit"} after ${args.candidateSha} was validated. Validate the new candidate before finalization.`,
      };
    }
    return { ok: true, sha: head };
  } catch (err) {
    return {
      ok: false,
      reason: String(err instanceof Error ? err.message : err).trim().slice(0, 500),
    };
  }
}

// Read the remote itself rather than a potentially stale origin/* tracking
// ref. The reviewer gate uses this to detect an Epic-child branch that was
// published with --no-verify or before the local pre-push policy existed.
export async function inspectOriginBranch(
  repoPath: string,
  branch: string,
): Promise<OriginBranchInspection> {
  if (!(await validBranchName(repoPath, branch))) {
    return { ok: false, sha: null, reason: `Invalid branch name: ${branch}` };
  }
  try {
    const out = await git(repoPath, [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    ]);
    const sha = out.split(/\s+/)[0]?.trim() || null;
    return { ok: true, sha };
  } catch (err) {
    return {
      ok: false,
      sha: null,
      reason: String(err instanceof Error ? err.message : err).trim().slice(0, 400),
    };
  }
}

export type EpicPublishResult =
  | { ok: true; kind: "pushed" | "already"; sha: string }
  | { ok: false; reason: string };

// Epic-Done finalization must leave the Epic integration branch on origin,
// even when all child integrations happened locally before the P6 merge
// runner existed. The push is fast-forward-only; divergent refs fail visibly.
export async function publishEpicBranch(args: {
  repoPath: string;
  epicBranch: string;
}): Promise<EpicPublishResult> {
  const { repoPath, epicBranch } = args;
  if (!(await validBranchName(repoPath, epicBranch))) {
    return { ok: false, reason: `Invalid Epic branch name: ${epicBranch}` };
  }
  try {
    await git(repoPath, ["fetch", "--quiet", "--prune", "origin"]);
  } catch (err) {
    return {
      ok: false,
      reason: `Could not refresh origin before publishing the Epic branch: ${String(
        err instanceof Error ? err.message : err,
      ).trim().slice(0, 300)}`,
    };
  }

  const localExists = await localRefExists(repoPath, epicBranch);
  const originExists = await originRefExists(repoPath, epicBranch);
  if (!localExists) {
    if (originExists) {
      return {
        ok: true,
        kind: "already",
        sha: await git(repoPath, ["rev-parse", `refs/remotes/origin/${epicBranch}`]),
      };
    }
    return {
      ok: false,
      reason: `Epic branch \`${epicBranch}\` exists neither locally nor on origin.`,
    };
  }

  const localSha = await git(repoPath, ["rev-parse", `refs/heads/${epicBranch}`]);
  if (originExists) {
    const originRef = `refs/remotes/origin/${epicBranch}`;
    const originSha = await git(repoPath, ["rev-parse", originRef]);
    if (localSha === originSha || (await isAncestor(repoPath, `refs/heads/${epicBranch}`, originRef))) {
      return { ok: true, kind: "already", sha: originSha };
    }
    if (!(await isAncestor(repoPath, originRef, `refs/heads/${epicBranch}`))) {
      return {
        ok: false,
        reason: `Local Epic branch \`${epicBranch}\` and origin/${epicBranch} have diverged; refusing a force-push.`,
      };
    }
  }

  if (!(await gitOk(repoPath, [
    "push",
    "origin",
    `refs/heads/${epicBranch}:refs/heads/${epicBranch}`,
  ]))) {
    return {
      ok: false,
      reason: `Pushing Epic branch \`${epicBranch}\` to origin failed (permissions or a concurrent update).`,
    };
  }
  const remote = await inspectOriginBranch(repoPath, epicBranch);
  if (!remote.ok || remote.sha !== localSha) {
    return {
      ok: false,
      reason: remote.ok
        ? `Origin/${epicBranch} did not resolve to the pushed local tip ${localSha}.`
        : remote.reason,
    };
  }
  return { ok: true, kind: "pushed", sha: localSha };
}

export type RemoteChildCleanupResult = {
  branch: string;
  outcome: "removed" | "absent" | "failed";
  detail: string | null;
};

// Remove an accidentally published Epic-child ref only after proving its tip
// is preserved by the pushed Epic branch. This is deliberately narrower than
// a generic remote-branch cleanup: no ancestry, no deletion.
export async function removeMergedOriginChildBranch(args: {
  repoPath: string;
  epicBranch: string;
  taskBranch: string;
}): Promise<RemoteChildCleanupResult> {
  const { repoPath, epicBranch, taskBranch } = args;
  if (taskBranch === epicBranch) {
    return { branch: taskBranch, outcome: "failed", detail: "task branch is the Epic branch" };
  }
  if (!(await validBranchName(repoPath, taskBranch))) {
    return { branch: taskBranch, outcome: "failed", detail: "invalid task branch name" };
  }
  try {
    await git(repoPath, ["fetch", "--quiet", "--prune", "origin"]);
  } catch (err) {
    return {
      branch: taskBranch,
      outcome: "failed",
      detail: `could not refresh origin: ${String(err instanceof Error ? err.message : err).trim().slice(0, 250)}`,
    };
  }

  if (!(await originRefExists(repoPath, taskBranch))) {
    return { branch: taskBranch, outcome: "absent", detail: null };
  }
  if (!(await originRefExists(repoPath, epicBranch))) {
    return {
      branch: taskBranch,
      outcome: "failed",
      detail: `Epic branch \`${epicBranch}\` is not on origin`,
    };
  }
  if (!(await isAncestor(
    repoPath,
    `refs/remotes/origin/${taskBranch}`,
    `refs/remotes/origin/${epicBranch}`,
  ))) {
    return {
      branch: taskBranch,
      outcome: "failed",
      detail: `origin/${taskBranch} is not an ancestor of origin/${epicBranch}; remote ref preserved`,
    };
  }
  if (!(await gitOk(repoPath, ["push", "origin", "--delete", taskBranch]))) {
    return {
      branch: taskBranch,
      outcome: "failed",
      detail: `deleting the merged leaked ref origin/${taskBranch} failed`,
    };
  }
  await gitOk(repoPath, ["update-ref", "-d", `refs/remotes/origin/${taskBranch}`]);
  const remaining = await inspectOriginBranch(repoPath, taskBranch);
  if (!remaining.ok || remaining.sha) {
    return {
      branch: taskBranch,
      outcome: "failed",
      detail: remaining.ok
        ? `origin/${taskBranch} still exists after deletion`
        : `could not verify deletion: ${remaining.reason}`,
    };
  }
  return { branch: taskBranch, outcome: "removed", detail: null };
}

// Return the worktree that currently owns refs/heads/<branch>. Git refuses to
// move a checked-out ref with `branch -f`, but a clean owning worktree can be
// advanced safely with an ordinary fast-forward merge.
async function checkedOutBranchWorktree(repoPath: string, branch: string) {
  try {
    const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
    const branchLine = `branch refs/heads/${branch}`;
    const record = out
      .split(/\n\s*\n/)
      .map((entry) => entry.split("\n"))
      .find((lines) => lines.includes(branchLine));
    return record?.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? null;
  } catch {
    return null; // unknown — be conservative and leave reconciliation visible
  }
}

// Best-effort: keep the local Epic ref and its owning worktree in step with
// what was just pushed so local-only child branches (P6) always have a fresh
// merge target and whole-Epic acceptance sees the same frozen candidate on
// both sides. A checked-out ref advances only through `merge --ff-only` after
// proving its worktree clean; dirty/diverged/racing state remains untouched
// and is reported later by the acceptance gate. Origin stays canonical.
async function fastForwardLocalEpicRef(repoPath: string, epicBranch: string, sha: string) {
  if (!(await localRefExists(repoPath, epicBranch))) {
    await gitOk(repoPath, ["branch", epicBranch, sha]);
    return;
  }
  const localRef = `refs/heads/${epicBranch}`;
  if (!(await isAncestor(repoPath, localRef, sha))) return;
  const worktreePath = await checkedOutBranchWorktree(repoPath, epicBranch);
  if (!worktreePath) {
    await gitOk(repoPath, ["branch", "-f", epicBranch, sha]);
    return;
  }
  const status = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => null);
  if (status !== "") return;
  await gitOk(worktreePath, ["merge", "--ff-only", sha]);
}

export type EpicMergeResult =
  | { ok: true; kind: "merged"; sha: string }
  | { ok: true; kind: "already" }
  | { ok: true; kind: "noop"; note: string }
  | { ok: false; reason: string };

export type EpicCheckpointResult =
  | {
      ok: true;
      kind: "published" | "already";
      checkpointSha: string;
      epicSha: string;
      createdCommit: boolean;
    }
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

// Publish an explicitly authorized mid-task checkpoint without weakening the
// local-only Epic-child rule. PM owns the commit, merges only the Epic branch
// to origin, then fast-forwards the still-active task branch to the published
// Epic tip so subsequent work starts from the new integration base.
//
// This exists for implementation that must be deployed before its remaining
// live-verification checklist can be completed. It deliberately does not move
// the task to Review or remove its worktree.
export async function publishTaskCheckpointToEpic(args: {
  repoPath: string;
  worktreePath: string;
  epicBranch: string;
  taskBranch: string;
  baseBranch: string;
  previousBaseSha?: string | null;
  gitUserName: string;
  gitUserEmail: string;
  commitSubject: string;
  mergeMessage: string;
}): Promise<EpicCheckpointResult> {
  const {
    repoPath,
    worktreePath,
    epicBranch,
    taskBranch,
    baseBranch,
  } = args;

  if (!(await validBranchName(repoPath, taskBranch))) {
    return { ok: false, reason: `Invalid task branch name: ${taskBranch}` };
  }
  if (!(await validBranchName(repoPath, epicBranch))) {
    return { ok: false, reason: `Invalid Epic branch name: ${epicBranch}` };
  }
  if (taskBranch === epicBranch) {
    return {
      ok: false,
      reason: "A publish checkpoint requires a dedicated Epic-child task branch; the task and Epic branches are the same.",
    };
  }
  if (!args.gitUserName.trim() || !args.gitUserEmail.trim()) {
    return {
      ok: false,
      reason: "The effective project Git identity is incomplete; PM cannot create the checkpoint commit.",
    };
  }

  try {
    const [topLevel, currentBranch] = await Promise.all([
      git(worktreePath, ["rev-parse", "--show-toplevel"]),
      git(worktreePath, ["branch", "--show-current"]),
    ]);
    if (join(topLevel) !== join(worktreePath)) {
      return {
        ok: false,
        reason: `The repository checkpoint worktree resolved to ${topLevel}, not ${worktreePath}.`,
      };
    }
    if (currentBranch !== taskBranch) {
      return {
        ok: false,
        reason: `The repository checkpoint worktree is on ${currentBranch || "a detached HEAD"}, not ${taskBranch}.`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Could not validate the repository checkpoint worktree: ${String(err instanceof Error ? err.message : err).trim().slice(0, 500)}`,
    };
  }

  const remoteTaskBranch = await inspectOriginBranch(repoPath, taskBranch);
  if (!remoteTaskBranch.ok) return remoteTaskBranch;
  if (remoteTaskBranch.sha) {
    return {
      ok: false,
      reason: `Epic-child branch origin/${taskBranch} already exists at ${remoteTaskBranch.sha.slice(0, 10)}; checkpoint publication must use only the Epic branch.`,
    };
  }

  // A runner can crash after publishing and fast-forwarding the task worktree
  // but before repository bookkeeping records the new base. A later retry may
  // then find unrelated follow-up work dirty in that same worktree. Recover
  // only when Git proves that HEAD is the exact owner-authorized checkpoint
  // merge on origin and the recorded base is its ancestor; never commit the
  // later dirty work under the consumed authorization.
  const previousBaseSha = args.previousBaseSha?.trim() ?? "";
  if (previousBaseSha) {
    const publishedEpic = await inspectOriginBranch(repoPath, epicBranch);
    if (!publishedEpic.ok) return publishedEpic;
    const taskHead = await git(worktreePath, ["rev-parse", "HEAD"]).catch(() => null);
    if (
      taskHead &&
      publishedEpic.sha === taskHead &&
      taskHead !== previousBaseSha &&
      await gitOk(repoPath, ["merge-base", "--is-ancestor", previousBaseSha, taskHead])
    ) {
      const [mergeSubject, parentLine] = await Promise.all([
        git(repoPath, ["show", "-s", "--format=%s", taskHead]).catch(() => null),
        git(repoPath, ["show", "-s", "--format=%P", taskHead]).catch(() => null),
      ]);
      const parents = parentLine?.split(/\s+/).filter(Boolean) ?? [];
      const checkpointSha = parents.length === 2 ? parents[1] : null;
      const checkpointSubject = checkpointSha
        ? await git(repoPath, ["show", "-s", "--format=%s", checkpointSha]).catch(() => null)
        : null;
      if (
        mergeSubject === args.mergeMessage &&
        checkpointSubject === args.commitSubject.slice(0, 240) &&
        checkpointSha &&
        await gitOk(repoPath, ["merge-base", "--is-ancestor", previousBaseSha, checkpointSha])
      ) {
        return {
          ok: true,
          kind: "already",
          checkpointSha,
          epicSha: taskHead,
          createdCommit: true,
        };
      }
    }
  }

  let createdCommit = false;
  try {
    const dirty = await git(worktreePath, ["status", "--porcelain"]);
    if (dirty) {
      await git(worktreePath, ["add", "--all"]);
      const hasStagedChanges = !(await gitOk(worktreePath, ["diff", "--cached", "--quiet"]));
      if (hasStagedChanges) {
        await git(
          worktreePath,
          ["commit", "-m", args.commitSubject.slice(0, 240)],
          {
            GIT_AUTHOR_NAME: args.gitUserName,
            GIT_AUTHOR_EMAIL: args.gitUserEmail,
            GIT_COMMITTER_NAME: args.gitUserName,
            GIT_COMMITTER_EMAIL: args.gitUserEmail,
          },
        );
        createdCommit = true;
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `PM could not create the checkpoint commit: ${String(err instanceof Error ? err.message : err).trim().slice(0, 700)}`,
    };
  }

  let checkpointSha: string;
  try {
    checkpointSha = await git(worktreePath, ["rev-parse", "HEAD"]);
  } catch (err) {
    return {
      ok: false,
      reason: `PM could not resolve the checkpoint commit: ${String(err instanceof Error ? err.message : err).trim().slice(0, 500)}`,
    };
  }

  const merged = await mergeTaskBranchIntoEpic({
    repoPath,
    epicBranch,
    taskBranch,
    baseBranch,
    gitUserName: args.gitUserName,
    gitUserEmail: args.gitUserEmail,
    message: args.mergeMessage,
  });
  if (!merged.ok) return merged;

  try {
    await git(repoPath, [
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${epicBranch}:refs/remotes/origin/${epicBranch}`,
    ]);
    const epicRef = `refs/remotes/origin/${epicBranch}`;
    if (!(await isAncestor(repoPath, checkpointSha, epicRef))) {
      return {
        ok: false,
        reason: `Checkpoint ${checkpointSha} is not contained in the published Epic branch ${epicBranch}.`,
      };
    }
    const dirtyAfterPublish = await git(worktreePath, ["status", "--porcelain"]);
    if (dirtyAfterPublish) {
      return {
        ok: false,
        reason: "The task worktree became dirty after checkpoint publication; PM left it in place and refused to advance its base.",
      };
    }
    await git(worktreePath, ["merge", "--ff-only", epicRef]);
    const epicSha = await git(worktreePath, ["rev-parse", "HEAD"]);
    return {
      ok: true,
      kind: merged.kind === "already" ? "already" : "published",
      checkpointSha,
      epicSha,
      createdCommit,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `The Epic checkpoint was published, but PM could not advance the active task branch to the new Epic tip: ${String(err instanceof Error ? err.message : err).trim().slice(0, 700)}`,
    };
  }
}

export type StandaloneCheckpointResult =
  | { ok: true; kind: "published" | "already"; checkpointSha: string; publishedSha: string; createdCommit: boolean }
  | { ok: false; reason: string };

// Publication before browser verification is not review acceptance. Keep the
// original review base and the registered worktree; publish only an exact task
// commit, with ordinary fast-forward protection and a durable replay marker.
export async function publishStandaloneTaskCheckpoint(args: {
  repoPath: string; worktreePath: string; taskBranch: string; baseBranch: string;
  gitUserName: string; gitUserEmail: string; commitSubject: string;
  authorizationCommentId: string;
}): Promise<StandaloneCheckpointResult> {
  const { repoPath, worktreePath, taskBranch } = args;
  try {
    if (!(await validBranchName(repoPath, taskBranch)) || ["main", "master", args.baseBranch].includes(taskBranch)) {
      return { ok: false, reason: "A standalone checkpoint must target a feature task branch, never the production/integration branch." };
    }
    if (!args.gitUserName.trim() || !args.gitUserEmail.trim() || !/^[a-zA-Z0-9_-]+$/.test(args.authorizationCommentId)) {
      return { ok: false, reason: "Checkpoint identity or authorization ID is invalid." };
    }
    const [top, branch, common, expectedCommon, gitDir] = await Promise.all([
      git(worktreePath, ["rev-parse", "--show-toplevel"]),
      git(worktreePath, ["branch", "--show-current"]),
      git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktreePath, ["rev-parse", "--absolute-git-dir"]),
    ]);
    if (await realpath(top) !== await realpath(worktreePath) || branch !== taskBranch ||
        await realpath(common) !== await realpath(expectedCommon) || await realpath(gitDir) === await realpath(common)) {
      return { ok: false, reason: "Checkpoint requires the exact registered task worktree in the expected repository." };
    }
    const epicOwner = await git(repoPath, ["config", "--get", `branch.${taskBranch}.pmEpicBranch`]).catch(() => "");
    if (epicOwner) return { ok: false, reason: "An Epic-child branch cannot be published as a standalone checkpoint." };
    const remote = await inspectOriginBranch(repoPath, taskBranch);
    if (!remote.ok) return { ok: false, reason: remote.reason };
    const trailer = `PM-Checkpoint-Authorization: ${args.authorizationCommentId}`;
    if (remote.sha) {
      await git(repoPath, ["fetch", "--no-tags", "origin", `refs/heads/${taskBranch}`]);
      const message = await git(repoPath, ["show", "-s", "--format=%B", remote.sha]);
      if (message.split("\n").includes(trailer)) {
        return { ok: true, kind: "already", checkpointSha: remote.sha, publishedSha: remote.sha, createdCommit: true };
      }
      if (!(await isAncestor(repoPath, remote.sha, `refs/heads/${taskBranch}`))) {
        return { ok: false, reason: "Origin advanced or diverged; reconcile the task branch before publishing. No work was discarded." };
      }
    }
    await git(worktreePath, ["diff", "--check"]);
    const dirty = await git(worktreePath, ["status", "--porcelain"]);
    const headBefore = await git(worktreePath, ["rev-parse", "HEAD"]);
    const headMessage = await git(worktreePath, ["show", "-s", "--format=%B", "HEAD"]);
    if (!dirty && remote.sha === headBefore) {
      return { ok: false, reason: "The clean task SHA is already published. Verify its deployment instead of requesting another checkpoint." };
    }
    if (dirty && headMessage.split("\n").includes(trailer)) {
      return { ok: false, reason: "An unpublished checkpoint already consumed this authorization and later edits exist. Preserve both and obtain a fresh authorization; a retry cannot absorb new work." };
    }
    let createdCommit = false;
    if (dirty || !headMessage.split("\n").includes(trailer)) {
      await git(worktreePath, ["add", "--all"]);
      // An already-committed unpublished change also needs a durable grant
      // marker so a post-push retry cannot absorb newer work under that grant.
      if (!(await gitOk(worktreePath, ["diff", "--cached", "--quiet"])) || !headMessage.split("\n").includes(trailer)) {
        await git(worktreePath, ["commit", "--allow-empty", "-m", args.commitSubject.slice(0, 240), "-m", trailer], {
          GIT_AUTHOR_NAME: args.gitUserName, GIT_AUTHOR_EMAIL: args.gitUserEmail,
          GIT_COMMITTER_NAME: args.gitUserName, GIT_COMMITTER_EMAIL: args.gitUserEmail,
        });
        createdCommit = true;
      }
    }
    const sha = await git(worktreePath, ["rev-parse", "HEAD"]);
    const currentBranch = await git(worktreePath, ["branch", "--show-current"]);
    if (currentBranch !== taskBranch || await git(worktreePath, ["status", "--porcelain"])) {
      return { ok: false, reason: "The worktree changed during checkpoint preparation; the commit was preserved and publication stopped." };
    }
    if (remote.sha !== sha) await git(worktreePath, ["push", "origin", `${sha}:refs/heads/${taskBranch}`]);
    const published = await inspectOriginBranch(repoPath, taskBranch);
    if (!published.ok || published.sha !== sha) return { ok: false, reason: "Origin did not confirm the exact checkpoint SHA; inspect before retrying." };
    return { ok: true, kind: remote.sha === sha ? "already" : "published", checkpointSha: sha, publishedSha: sha, createdCommit };
  } catch (err) {
    return { ok: false, reason: `PM could not publish the standalone checkpoint: ${String(err instanceof Error ? err.message : err).slice(0, 700)}` };
  }
}
