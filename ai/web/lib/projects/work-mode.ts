export const PROJECT_WORK_MODES = ["repository", "general"] as const;

export type ProjectWorkMode = (typeof PROJECT_WORK_MODES)[number];

export function normalizeProjectWorkMode(
  value: unknown,
  fallback: ProjectWorkMode = "repository",
): ProjectWorkMode {
  return PROJECT_WORK_MODES.includes(value as ProjectWorkMode)
    ? value as ProjectWorkMode
    : fallback;
}

export function projectUsesRepository(project: {
  workMode?: string | null;
  repositoryPath?: string | null;
}): boolean {
  return normalizeProjectWorkMode(project.workMode) === "repository"
    && Boolean(project.repositoryPath?.trim());
}
