import { db } from "@/lib/db";
import { episodeCheckpointRequestAt } from "@/lib/agents/episodes/lifecycle";

export function checkpointGuidance(episode: {
  episodeNo: number; status: string; toolCycleCount: number; toolCycleBudget: number;
} | null) {
  if (!episode || episode.status !== "open" || episode.toolCycleBudget <= 0) return null;
  const remaining = Math.max(0, episode.toolCycleBudget - episode.toolCycleCount);
  const checkpointDue = episode.toolCycleCount >= episodeCheckpointRequestAt(episode.toolCycleBudget);
  return {
    episodeNo: episode.episodeNo,
    toolCallsRemaining: remaining,
    checkpointDue,
    instruction: checkpointDue
      ? "Save a checkpoint now with completed work, evidence, risks, durable verification job IDs and the exact next action. The acknowledged checkpoint ends this episode; when turnComplete is true, stop. PM resumes the next episode from the saved state. Checkpoint prose does not tick checklist items; include any pending completion update in the exact next action. The remaining tool calls are a hard grace limit."
      : "Record each finished item with complete_subtask and its evidence before starting the next item or saving a checkpoint; do not batch updates at task end. Save a checkpoint at each meaningful boundary and at least every 6 tool calls; do not wait for a live reminder.",
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
