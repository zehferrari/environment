import { db } from "@/lib/db";
import { pmChannelRunTargetKey } from "./runs";
import type { PmChannelReplyTarget } from "./openclaw";

export function numericTaskUsage(value: Record<string, unknown>) {
  return Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "contextLimit"].flatMap((key) => {
    const n = value[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? [[key, n]] : [];
  }));
}

// Activity survives stream compaction and the unique dedupe key fences callback replay.
export async function recordTaskModelUsage(target: PmChannelReplyTarget, usage: Record<string, unknown>) {
  if (!("taskId" in target) || typeof usage.modelRunId !== "string" || !usage.modelRunId || usage.modelRunId.length > 200) return;
  const numbers = numericTaskUsage(usage);
  if (!Object.keys(numbers).some((key) => key !== "contextLimit")) return;
  const run = await db.pmChannelRun.findUnique({ where: { targetKey: pmChannelRunTargetKey(target) }, select: { id: true, projectId: true, sessionKey: true } });
  if (!run) return;
  await db.activityLog.create({ data: {
    taskId: target.taskId, projectId: run.projectId, targetAgent: target.agentSlug, kind: "pm.task.model_usage",
    dedupeKey: `pm-task-usage:${run.id}:${usage.modelRunId}`,
    payload: JSON.stringify({ runId: run.id, messageId: target.messageId, modelRunId: usage.modelRunId, sessionKey: run.sessionKey, ...numbers }),
  } }).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
  });
}
