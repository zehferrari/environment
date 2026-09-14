import type { TaskExecutionEpisodeSummary } from "@/lib/agents/episodes/lifecycle";

/** Reserve space for the next action and risks rather than truncating the tail
 * of a rendered checkpoint after completed work has consumed the budget. */
export function compactTaskCheckpoint(episode: TaskExecutionEpisodeSummary) {
  const omittedFields: string[] = [];
  const section = (field: "completedWork" | "evidence" | "openChecklist" | "risks", budget: number) => {
    const text = episode.checkpoint[field].join("\n");
    if (text.length <= budget) return text || null;
    omittedFields.push(field);
    return text.slice(0, budget);
  };
  return {
    episodeNo: episode.episodeNo,
    status: episode.status,
    // Persisted nextAction is already limited to 1,200 characters at write time.
    nextAction: episode.checkpoint.nextAction,
    risks: section("risks", 300),
    openChecklist: section("openChecklist", 250),
    evidence: section("evidence", 400),
    completedWork: section("completedWork", 250),
    omittedFields,
    omittedDetails: "Use pm_context section=history only for a named missing detail.",
  };
}
