// Does a project's configured repository participate in the shared worktree
// approach (claim-branch: a primary checkout with a sibling
// "<repo>.worktrees/" dir, or a linked worktree living inside "*.worktrees/")?
// Used to gate the per-project "Worktree live preview" switcher in project
// settings — it only makes sense for git repos exposed to that model.

import { existsSync } from "node:fs";
import path from "node:path";

export function isWorktreeExposedRepo(
  repositoryPath: string | null | undefined
): boolean {
  if (!repositoryPath) return false;
  try {
    const p = path.resolve(repositoryPath);
    // ".git" is a dir for the primary checkout, a file for a linked worktree.
    if (!existsSync(path.join(p, ".git"))) return false;
    // Primary checkout: has a sibling "<repo>.worktrees" dir.
    if (existsSync(p + ".worktrees")) return true;
    // Linked worktree: some path segment is a "*.worktrees" dir.
    return p.split(path.sep).some((seg) => seg.endsWith(".worktrees"));
  } catch {
    return false;
  }
}
