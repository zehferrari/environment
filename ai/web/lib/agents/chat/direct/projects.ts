export const MAX_DIRECT_CHAT_PROJECTS = 8;
export const MAX_DIRECT_CHAT_PROJECT_CONTEXT_CHARS = 320_000;

export function normalizeDirectChatProjectIds(values: unknown[]) {
  const projectIds = Array.from(new Set(
    values.map((value) => String(value).trim()).filter(Boolean),
  ));
  if (projectIds.length > MAX_DIRECT_CHAT_PROJECTS) {
    throw new Error(
      `A direct chat can link at most ${MAX_DIRECT_CHAT_PROJECTS} projects. Remove some projects and try again.`,
    );
  }
  return projectIds;
}

/**
 * Share one aggregate prompt budget fairly across every selected project.
 * The beginning of each environment contains its identity, policy, and breadth
 * manifest, so clipping each packet (instead of dropping later projects)
 * preserves useful context and authorization instructions for the full set.
 */
export function boundDirectChatProjectContexts(contexts: string[]) {
  if (contexts.length === 0) return [];
  const separatorBudget = Math.max(0, contexts.length - 1) * 2;
  const perProjectBudget = Math.max(
    1,
    Math.floor((MAX_DIRECT_CHAT_PROJECT_CONTEXT_CHARS - separatorBudget) / contexts.length),
  );
  return contexts.map((context) => {
    if (context.length <= perProjectBudget) return context;
    const suffix = `\n[project environment truncated: ${context.length - perProjectBudget}+ characters omitted]`;
    const bodyBudget = Math.max(0, perProjectBudget - suffix.length);
    return `${context.slice(0, bodyBudget).trimEnd()}${suffix}`.slice(0, perProjectBudget);
  });
}
