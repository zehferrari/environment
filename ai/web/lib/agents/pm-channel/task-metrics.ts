import { db } from "@/lib/db";
import { pmChannelRunTargetKey } from "./runs";
import type { PmChannelReplyTarget } from "./openclaw";

export function numericTaskUsage(value: Record<string, unknown>) {
  return Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "contextLimit"].flatMap((key) => {
    const n = value[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? [[key, n]] : [];
  }));
}

export function taskContextSnapshot(usage: Record<string, unknown>) {
  const sample = usage.contextSnapshot;
  if (!sample || typeof sample !== "object") return null;
  const value = sample as Record<string, unknown>;
  if (value.state !== "available" || !["provider_context", "last_model_call"].includes(String(value.source))) return null;
  const promptTokens = value.promptTokens;
  const limit = value.limit;
  if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens <= 0 || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return { state: "available" as const, promptTokens, limit, source: value.source as string };
}

// Activity survives stream compaction and the unique dedupe key fences callback replay.
export async function recordTaskModelUsage(target: PmChannelReplyTarget, usage: Record<string, unknown>) {
  if (!("taskId" in target) || typeof usage.modelRunId !== "string" || !usage.modelRunId || usage.modelRunId.length > 200) return;
  const numbers = numericTaskUsage(usage);
  const contextSnapshot = taskContextSnapshot(usage);
  const run = await db.pmChannelRun.findUnique({ where: { targetKey: pmChannelRunTargetKey(target) }, select: { id: true, projectId: true, sessionKey: true } });
  if (!run) return;
  const dedupeKey = `pm-task-usage:${run.id}:${usage.modelRunId}`;
  await db.activityLog.upsert({ where: { dedupeKey }, update: {}, create: {
    taskId: target.taskId, projectId: run.projectId, targetAgent: target.agentSlug, kind: "pm.task.model_usage",
    dedupeKey,
    payload: JSON.stringify({ runId: run.id, messageId: target.messageId, modelRunId: usage.modelRunId, sessionKey: run.sessionKey, usageScope: "attempt", ...numbers, contextSnapshot: contextSnapshot ?? { state: "unavailable" } }),
  } }).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
  });
}
