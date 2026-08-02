export const MAX_DIRECT_CHAT_PROJECTS = 8;
export const MAX_DIRECT_CHAT_PROJECT_CONTEXT_CHARS = 320_000;

/**
 * Keep project context read-only unless the human explicitly asks to mutate
 * PM work items. Normalize whitespace so ordinary multiline requests behave
 * like one sentence, and accept the plural nouns people naturally use when
 * asking for more than one task, Epic, or proposal.
 */
export function directlyRequestsWorkItemManagement(body: string) {
  const text = body.toLowerCase().replace(/\s+/g, " ");
  const workItemNoun = "(?:work[- ]?items?|tasks?|sub[- ]?tasks?|epics?|action plans?|proposals?|boards?|backlogs?)";
  const managementVerb = "(?:create|add|make|update|edit|change|reorganize|re-organize|move|assign|comment|archive|delete|split|break down|breakdown|propose|submit)";
  const openWorkItem = new RegExp(
    `\\bopen\\b\\s+(?:(?:a|an|another|new|one|two|three|four|five|six|seven|eight|nine|ten|some|\\d+)\\s+)\\b${workItemNoun}\\b`,
  );
  return (
    new RegExp(`\\b${managementVerb}\\b.{0,80}\\b${workItemNoun}\\b`).test(text) ||
    new RegExp(`\\b${workItemNoun}\\b.{0,80}\\b${managementVerb}\\b`).test(text) ||
    openWorkItem.test(text)
  );
}

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
