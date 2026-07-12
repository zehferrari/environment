// Canonical repo identity for a worktree/repo path, used to show only the
// worktrees that belong to a given project's repository. Pure string logic
// (no fs/node builtins) so it's safe to import in client components too.
//
//   /path/to/repository                         -> /path/to/repository
//   /path/to/repository.worktrees/feature       -> /path/to/repository
//   /path/to/repository.worktrees/feature/subdir -> /path/to/repository
export function worktreeRepoKey(p: string | null | undefined): string | null {
  if (!p) return null;
  const norm = p.replace(/\/+$/, "");
  const i = norm.indexOf(".worktrees/");
  return i === -1 ? norm : norm.slice(0, i);
}

export function isLinkedWorktreePath(p: string | null | undefined): boolean {
  if (!p) return false;
  return p.replace(/\/+$/, "").includes(".worktrees/");
}

export function displayWorktreesForRepo<T extends { path: string; branch: string }>(
  worktrees: T[],
  repoKey: string,
): T[] {
  const related = worktrees.filter((w) =>
    worktreeRepoKey(w.path) === repoKey && isLinkedWorktreePath(w.path)
  );
  const linkedBranches = new Set(
    related
      .filter((w) => isLinkedWorktreePath(w.path))
      .map((w) => w.branch),
  );

  if (linkedBranches.size === 0) return related;

  return related.filter((w) => {
    if (isLinkedWorktreePath(w.path)) return true;
    return !linkedBranches.has(w.branch);
  });
}
