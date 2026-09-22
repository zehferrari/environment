import { execFile } from "node:child_process";
import { readFile, writeFile, rename, unlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type EpicChildSyncResult = {
  outcome: "unchanged" | "revalidate" | "conflicts" | "error";
  originalSha: string | null;
  checkpointSha: string | null;
  headSha: string | null;
  baseSha: string;
  conflictPaths: string[];
  error: string | null;
};
type SyncRecord = EpicChildSyncResult & { requestId: string; branchName: string };

/** PM owns the merge; assignees only edit/stage conflicts and revalidate.
 * A checkpoint preserves tracked AND untracked work before synchronization.
 * No push, rebase, stash, reset, or automatic conflict resolution is used.
 */
export async function synchronizeEpicChild(args: {
  worktreePath: string;
  branchName: string;
  baseSha: string;
  requestId: string;
  commitSubject: string;
  gitUserName: string | null | undefined;
  gitUserEmail: string | null | undefined;
}): Promise<EpicChildSyncResult> {
  const result: EpicChildSyncResult = {
    outcome: "error", originalSha: null, checkpointSha: null, headSha: null,
    baseSha: args.baseSha, conflictPaths: [], error: null,
  };
  const git = async (...argv: string[]) => (await exec("git", ["-C", args.worktreePath, ...argv], {
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
  const optional = async (...argv: string[]) => {
    try { return await git(...argv); } catch { return null; }
  };
  try {
    if (!/^[a-f0-9]{40,64}$/.test(args.baseSha)) throw new Error("Invalid pinned Epic base SHA");
    const gitDir = await realpath(await git("rev-parse", "--absolute-git-dir"));
    const commonDir = await realpath(path.resolve(args.worktreePath, await git("rev-parse", "--git-common-dir")));
    const worktree = await realpath(args.worktreePath);
    const registered = (await git("worktree", "list", "--porcelain")).split("\n\n").some(record =>
      record.split("\n").includes(`worktree ${worktree}`) && record.split("\n").includes(`branch refs/heads/${args.branchName}`));
    if (gitDir === commonDir || !registered || await git("branch", "--show-current") !== args.branchName) {
      throw new Error("Epic synchronization requires the registered linked task worktree on its expected branch");
    }
    if (!args.gitUserName || !args.gitUserEmail) throw new Error("Project Git identity is required for PM synchronization");
    const identity = ["-c", `user.name=${args.gitUserName}`, "-c", `user.email=${args.gitUserEmail}`];
    result.originalSha = result.headSha = await git("rev-parse", "HEAD");
    await git("cat-file", "-e", `${args.baseSha}^{commit}`);
    const marker = path.join(gitDir, "pm-epic-sync.json");
    const save = async () => {
      await writeFile(marker + ".tmp", JSON.stringify({ ...result, requestId: args.requestId, branchName: args.branchName }));
      await rename(marker + ".tmp", marker);
    };
    let previous: SyncRecord | null = null;
    try { previous = JSON.parse(await readFile(marker, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous && previous.branchName !== args.branchName) throw new Error("Synchronization record belongs to another branch");
    // A repeated worker job must not turn synchronization into accepted evidence.
    if (previous?.requestId === args.requestId && ["revalidate", "conflicts"].includes(previous.outcome)) return previous;
    const mergeHead = await optional("rev-parse", "--verify", "MERGE_HEAD");
    if (mergeHead) {
      if (!previous || mergeHead !== previous.baseSha || result.headSha !== previous.checkpointSha) {
        throw new Error("An unrelated merge is in progress; PM left it untouched");
      }
      result.originalSha = previous.originalSha;
      result.checkpointSha = previous.checkpointSha;
      result.conflictPaths = (await git("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
      if (result.conflictPaths.length) {
        result.outcome = "conflicts";
        result.baseSha = previous.baseSha;
        await save();
        return result;
      }
      // The assignee must explicitly stage resolved files. Do not stage markers
      // on its behalf and silently turn unresolved/binary conflicts into a commit.
      try { await git("diff", "--cached", "--check"); }
      catch (error) {
        if ((error as { code?: number }).code !== 2 && (error as { code?: number }).code !== 1) throw error;
        result.outcome = "conflicts";
        result.baseSha = previous.baseSha;
        result.error = `Staged resolution failed git diff --check: ${String(error)}`.slice(0, 1200);
        result.conflictPaths = (await git("diff", "--cached", "--name-only")).split("\n").filter(Boolean);
        await save();
        return result;
      }
      await git(...identity, "commit", "--no-edit");
      result.headSha = await git("rev-parse", "HEAD");
      result.outcome = "revalidate";
      result.baseSha = previous.baseSha;
      await save();
      return result;
    }
    if (await optional("rev-parse", "--verify", "CHERRY_PICK_HEAD") || await optional("rev-parse", "--verify", "REBASE_HEAD")) {
      throw new Error("Another Git operation is in progress; PM left it untouched");
    }
    // Verify ancestry separately from command failures; a failed Git command
    // must never be mistaken for a stale base that authorizes mutation.
    const mergeBase = await git("merge-base", "HEAD", args.baseSha);
    if (mergeBase === args.baseSha) {
      // A crash after Git completed its merge but before the result was saved
      // must still require revalidation, rather than certifying changed code.
      if (previous && previous.outcome !== "revalidate" && previous.checkpointSha && result.headSha !== previous.checkpointSha) {
        result.originalSha = previous.originalSha;
        result.checkpointSha = previous.checkpointSha;
        result.outcome = "revalidate";
        await save();
        return result;
      }
      if (previous) await unlink(marker);
      result.outcome = "unchanged";
      return result;
    }
    if (await git("status", "--porcelain")) {
      await git("add", "--all");
      await git(...identity, "commit", "-m", args.commitSubject);
    }
    result.checkpointSha = result.headSha = await git("rev-parse", "HEAD");
    await save(); // durable ownership before invoking merge, including crash recovery
    try {
      await git(...identity, "merge", "--ff", "--no-edit", args.baseSha);
    } catch (error) {
      if (await optional("rev-parse", "--verify", "MERGE_HEAD") !== args.baseSha) throw error;
      result.conflictPaths = (await git("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
      if (!result.conflictPaths.length) throw error;
      result.outcome = "conflicts";
      await save();
      return result;
    }
    result.headSha = await git("rev-parse", "HEAD");
    result.outcome = "revalidate";
    await save();
    return result;
  } catch (error) {
    result.error = (error instanceof Error ? error.message : String(error)).slice(0, 1200);
    return result;
  }
}

export function renderEpicSyncHandoff(result: EpicChildSyncResult, branch: string, epicBranch: string): string {
  return [
    result.outcome === "conflicts"
      ? `PM preserved local work on \`${branch}\` and prepared synchronization with Epic \`${epicBranch}\`; content conflicts need resolution.`
      : `PM synchronized local task branch \`${branch}\` with Epic \`${epicBranch}\`. Revalidation is required before reviewer handoff.`,
    `- Preserved checkpoint: \`${result.checkpointSha}\`; current HEAD: \`${result.headSha}\`; pinned Epic revision: \`${result.baseSha}\`.`,
    "- The task branch remains local-only. Previous automated results describe the earlier source and are not proof of the integrated revision.",
    ...(result.error ? [`- Resolution check: ${result.error}`] : []),
    result.outcome === "conflicts"
      ? `Assignee: edit the conflicting files (${result.conflictPaths.map(p => `\`${p}\``).join(", ")}) to preserve both changes, then stage only resolved files with git add (or git rm for an intentional resolution deletion). Call ready_for_review so PM can finish its merge. Do not run merge, rebase, commit, push, or abort the PM-owned merge. PM will return the resulting revision for validation.`
      : "Assignee: inspect the integrated source, run the affected automated checks, update evidence for this revision, then call ready_for_review again. PM owns commits, merges and publication. Owner-deferred physical checks remain pending for final acceptance; they do not block this work.",
  ].join("\n");
}
