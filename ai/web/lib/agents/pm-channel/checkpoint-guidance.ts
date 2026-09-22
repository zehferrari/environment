import { db } from "@/lib/db";

export function checkpointGuidance(episode: {
  episodeNo: number; status: string; toolCycleCount: number; toolCycleBudget: number;
} | null) {
  if (!episode || episode.status !== "open" || episode.toolCycleBudget <= 0) return null;
  const remaining = Math.max(0, episode.toolCycleBudget - episode.toolCycleCount);
  const checkpointDue = episode.toolCycleCount >= Math.max(8, Math.floor(episode.toolCycleBudget * 2 / 3));
  return {
    episodeNo: episode.episodeNo,
    toolCallsRemaining: remaining,
    checkpointDue,
    instruction: checkpointDue
      ? "Save a checkpoint now with completed work, evidence, risks and the exact next action before further tools. Finish or checkpoint before the remaining tool calls are exhausted."
      : "Save a checkpoint at each meaningful boundary and at least every 6 tool calls; do not wait for a live reminder.",
  };
}

export async function readCheckpointGuidance(taskId: string, agentSlug: string, messageId?: string) {
  const episode = await db.taskExecutionEpisode.findFirst({
    where: { taskId, agentSlug, ...(messageId ? { messageId } : {}), status: "open" },
    orderBy: { episodeNo: "desc" },
    select: { episodeNo: true, status: true, toolCycleCount: true, toolCycleBudget: true },
  });
  return checkpointGuidance(episode);
}
