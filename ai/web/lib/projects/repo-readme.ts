// Helpers for the project "Summary" tab: the README.md at the root of the
// project's configured repository folder (Project.repositoryPath). Distinct
// from Project.readmePath (the PM-owned project README under /srv/Data).
//
// Reads are best-effort: a missing repo path, missing README, or an
// unreadable file all resolve to "no summary" rather than throwing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const README_NAME = "README.md";

export function repoHasReadme(repositoryPath: string | null | undefined): boolean {
  if (!repositoryPath) return false;
  try {
    return existsSync(path.join(repositoryPath, README_NAME));
  } catch {
    return false;
  }
}

export async function readRepoReadme(
  repositoryPath: string | null | undefined,
): Promise<string | null> {
  if (!repositoryPath) return null;
  try {
    return await readFile(path.join(repositoryPath, README_NAME), "utf8");
  } catch {
    return null;
  }
}
