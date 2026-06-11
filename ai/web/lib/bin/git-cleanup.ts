import { access, rm } from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "production",
  "prod",
  "staging",
  "stage",
  "develop",
  "dev",
]);

function isSafeBranchName(branch: string | null | undefined) {
  if (!branch) return false;
  if (PROTECTED_BRANCHES.has(branch)) return false;
  if (branch.startsWith("origin/")) return false;
  if (branch.includes("..") || branch.includes("~") || branch.includes("^") || branch.includes(":")) return false;
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(branch);
}

function worktreeDirFor(repoPath: string, branch: string) {
  return path.join(`${repoPath}.worktrees`, branch.replace(/[^A-Za-z0-9._-]+/g, "_"));
}

async function git(repoPath: string, args: string[]) {
  return execFileAsync("git", ["-C", repoPath, ...args], { timeout: 30_000, maxBuffer: 512_000 });
}

export async function cleanupEpicGitRefs(args: {
  repositoryPath: string | null;
  branches: Array<string | null | undefined>;
}) {
  const repoPath = args.repositoryPath;
  const cleaned: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  if (!repoPath) return { cleaned, skipped, errors };

  let current = "";
  try {
    current = (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  } catch (err) {
    errors.push(`current branch: ${(err as Error).message}`);
  }

  for (const branch of [...new Set(args.branches.filter(Boolean).map(String))]) {
    if (!isSafeBranchName(branch) || branch === current) {
      skipped.push(branch);
      continue;
    }

    const worktreeDir = worktreeDirFor(repoPath, branch);
    try {
      await access(worktreeDir);
      await git(repoPath, ["worktree", "remove", "--force", worktreeDir]).catch(async () => {
        await rm(worktreeDir, { recursive: true, force: true });
        await git(repoPath, ["worktree", "prune"]).catch(() => undefined);
      });
      cleaned.push(`worktree:${branch}`);
    } catch {
      // No local worktree folder for this branch; that's fine.
    }

    try {
      await git(repoPath, ["branch", "-D", branch]);
      cleaned.push(`local:${branch}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes("not found")) errors.push(`local ${branch}: ${msg}`);
    }

    try {
      await git(repoPath, ["push", "origin", "--delete", branch]);
      cleaned.push(`origin:${branch}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes("remote ref does not exist")) errors.push(`origin ${branch}: ${msg}`);
    }
  }

  return { cleaned, skipped, errors };
}
