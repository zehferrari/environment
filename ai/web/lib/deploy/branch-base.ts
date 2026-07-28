import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type BranchBaseValidation = {
  ok: boolean;
  baseBranch: string;
  originBaseSha: string | null;
  branchSha: string | null;
  mergeBaseSha: string | null;
  error: string | null;
};

export type VerificationBaseFetch = {
  baseBranch: string;
  error: string | null;
};

async function git(
  repo: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
) {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    timeout: opts.timeout ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOrNull(
  repo: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
) {
  try {
    return await git(repo, args, opts);
  } catch {
    return null;
  }
}

function trimError(err: unknown, max = 400) {
  const message = err instanceof Error ? err.message : String(err);
  return message.trim().slice(0, max);
}

async function validBranchName(repo: string, value: string | null | undefined) {
  const branch = value?.trim();
  if (!branch) return null;
  try {
    await git(repo, ["check-ref-format", "--branch", branch], { timeout: 10_000 });
    return branch;
  } catch {
    return null;
  }
}

async function remoteDefaultBranch(repo: string) {
  const remote = await gitOrNull(repo, ["ls-remote", "--symref", "origin", "HEAD"], {
    timeout: 30_000,
  });
  const remoteMatch = remote?.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m);
  const remoteBranch = await validBranchName(repo, remoteMatch?.[1]);
  if (remoteBranch) return remoteBranch;

  // A legacy/offline job may still have an accurate origin/HEAD even when
  // ls-remote is temporarily unavailable. The subsequent fetch remains the
  // authority and will fail safely if this local hint is stale.
  const local = await gitOrNull(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    timeout: 10_000,
  });
  return validBranchName(repo, local?.replace(/^origin\//, ""));
}

function addCandidate(candidates: string[], branch: string | null) {
  if (branch && !candidates.includes(branch)) candidates.push(branch);
}

async function fetchVerificationRefs(repo: string, baseBranch: string, branch: string) {
  const names = [...new Set([baseBranch, branch])];
  const refspecs = names.map(
    (name) => `+refs/heads/${name}:refs/remotes/origin/${name}`,
  );
  await git(repo, ["fetch", "--quiet", "origin", ...refspecs], { timeout: 60_000 });
}

/**
 * Fetch the feature branch and choose the base used by the review gate.
 *
 * New jobs carry the effective project PR target branch. Older jobs did not,
 * so they use origin's advertised default and finally the conventional
 * main/master names. A configured non-main branch is authoritative; only a
 * missing/legacy main default is eligible for fallback.
 */
export async function fetchVerificationBranch(
  repo: string,
  branch: string,
  requestedBaseBranch?: string | null,
): Promise<VerificationBaseFetch> {
  const validFeatureBranch = await validBranchName(repo, branch);
  if (!validFeatureBranch) {
    return { baseBranch: "main", error: `Invalid task branch name: ${branch}` };
  }

  const requested = requestedBaseBranch?.trim() || null;
  const validRequested = await validBranchName(repo, requested);
  if (requested && !validRequested) {
    return { baseBranch: requested, error: `Invalid configured base branch: ${requested}` };
  }

  const candidates: string[] = [];
  addCandidate(candidates, validRequested);
  if (!validRequested || validRequested === "main") {
    addCandidate(candidates, await remoteDefaultBranch(repo));
    addCandidate(candidates, "main");
    addCandidate(candidates, "master");
  }

  const errors: string[] = [];
  for (const baseBranch of candidates) {
    try {
      await fetchVerificationRefs(repo, baseBranch, validFeatureBranch);
      return { baseBranch, error: null };
    } catch (err) {
      errors.push(`origin/${baseBranch}: ${trimError(err, 300)}`);
    }
  }

  const baseBranch = candidates[0] ?? "main";
  return {
    baseBranch,
    error: errors.join("\n").slice(0, 800) || "No valid repository base branch could be resolved",
  };
}

// Epic-child local-only mode (P6): the task branch lives ONLY in
// refs/heads/<branch>; its review base is the Epic integration branch, not
// origin/master. Prefer the local Epic ref (kept fresh by the epic-merge
// runner's fast-forward) and fall back to origin/<epicBranch>; refresh the
// origin ref best-effort first so a stale remote-tracking ref cannot pass a
// branch that no longer contains the current Epic tip.
export type EpicVerificationBase = {
  epicBranch: string;
  baseRef: string | null;
  error: string | null;
};

export async function resolveEpicVerificationBase(
  repo: string,
  epicBranch: string | null | undefined,
): Promise<EpicVerificationBase> {
  const validEpicBranch = await validBranchName(repo, epicBranch);
  if (!validEpicBranch) {
    return {
      epicBranch: epicBranch?.trim() || "(unset)",
      baseRef: null,
      error: `No valid Epic integration branch on the verify job: ${epicBranch ?? "(unset)"}`,
    };
  }
  await gitOrNull(
    repo,
    ["fetch", "--quiet", "origin", `+refs/heads/${validEpicBranch}:refs/remotes/origin/${validEpicBranch}`],
    { timeout: 60_000 },
  );
  for (const baseRef of [`refs/heads/${validEpicBranch}`, `refs/remotes/origin/${validEpicBranch}`]) {
    const sha = await gitOrNull(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`], { timeout: 10_000 });
    if (sha) return { epicBranch: validEpicBranch, baseRef, error: null };
  }
  return {
    epicBranch: validEpicBranch,
    baseRef: null,
    error: `Epic branch ${validEpicBranch} was not found locally (refs/heads) or on origin — create it with claim-branch --epic before review`,
  };
}

export async function validateEpicBase(
  repo: string,
  branch: string,
  base: EpicVerificationBase,
): Promise<BranchBaseValidation> {
  const baseBranch = base.epicBranch;
  if (!base.baseRef) {
    return {
      ok: false,
      baseBranch,
      originBaseSha: null,
      branchSha: await gitOrNull(repo, ["rev-parse", "--verify", `refs/heads/${branch}`], { timeout: 10_000 }),
      mergeBaseSha: null,
      error: base.error ?? `Epic branch ${baseBranch} is unavailable`,
    };
  }

  const baseSha = await gitOrNull(repo, ["rev-parse", "--verify", base.baseRef], { timeout: 10_000 });
  const branchSha = await gitOrNull(repo, ["rev-parse", "--verify", `refs/heads/${branch}`], { timeout: 10_000 });
  if (!baseSha) {
    return {
      ok: false,
      baseBranch,
      originBaseSha: null,
      branchSha,
      mergeBaseSha: null,
      error: `${base.baseRef} is unavailable`,
    };
  }
  if (!branchSha) {
    return {
      ok: false,
      baseBranch,
      originBaseSha: baseSha,
      branchSha: null,
      mergeBaseSha: null,
      error: `refs/heads/${branch} does not exist — Epic-child branches are local-only; commit your work on the local branch (do not push it)`,
    };
  }

  const mergeBaseSha = await gitOrNull(repo, ["merge-base", base.baseRef, `refs/heads/${branch}`], { timeout: 10_000 });
  if (mergeBaseSha !== baseSha) {
    return {
      ok: false,
      baseBranch,
      originBaseSha: baseSha,
      branchSha,
      mergeBaseSha,
      error: `refs/heads/${branch} does not contain the current Epic branch ${baseBranch}; merge ${baseBranch} into your branch (or rebase onto it) and commit locally before review`,
    };
  }

  return {
    ok: true,
    baseBranch,
    originBaseSha: baseSha,
    branchSha,
    mergeBaseSha,
    error: null,
  };
}

export async function validateOriginBase(
  repo: string,
  branch: string,
  baseBranch: string,
): Promise<BranchBaseValidation> {
  const originBaseSha = await gitOrNull(
    repo,
    ["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}`],
    { timeout: 10_000 },
  );
  const branchRef = `origin/${branch}`;
  const branchSha = await gitOrNull(
    repo,
    ["rev-parse", "--verify", `refs/remotes/${branchRef}`],
    { timeout: 10_000 },
  );

  if (!originBaseSha) {
    return {
      ok: false,
      baseBranch,
      originBaseSha: null,
      branchSha,
      mergeBaseSha: null,
      error: `origin/${baseBranch} is unavailable after the monitor fetch`,
    };
  }
  if (!branchSha) {
    return {
      ok: false,
      baseBranch,
      originBaseSha,
      branchSha: null,
      mergeBaseSha: null,
      error: `${branchRef} is unavailable after the monitor fetch`,
    };
  }

  const mergeBaseSha = await gitOrNull(
    repo,
    ["merge-base", `origin/${baseBranch}`, branchRef],
    { timeout: 10_000 },
  );
  if (mergeBaseSha !== originBaseSha) {
    return {
      ok: false,
      baseBranch,
      originBaseSha,
      branchSha,
      mergeBaseSha,
      error: `${branchRef} does not contain the current origin/${baseBranch}; recreate or update the branch from origin/${baseBranch} before review`,
    };
  }

  return {
    ok: true,
    baseBranch,
    originBaseSha,
    branchSha,
    mergeBaseSha,
    error: null,
  };
}
