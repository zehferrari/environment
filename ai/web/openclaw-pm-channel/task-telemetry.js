import { isProtocolSilentReply } from "./turn-completion.js";
// Observe provider-reported usage only; never retain prompt, reasoning or credentials.
const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

// llm_output.usage is aggregate attempt billing in OpenClaw. The repeated
// prompts in a multi-call turn must never be counted as live context. CLI
// harnesses also expose aggregate billing as lastAssistant.usage; require
// their explicit contextUsage snapshot instead of guessing.
export function latestContextSnapshot(event, context = {}) {
  const limit = nonnegative(event.contextTokenBudget ?? context.contextTokenBudget);
  const assistant = event.lastAssistant;
  const usage = assistant?.usage;
  const explicit = usage?.contextUsage ?? event.usage?.contextUsage;
  let promptTokens;
  let totalTokens;
  let source;
  if (explicit?.state === "available") {
    promptTokens = nonnegative(explicit.promptTokens);
    totalTokens = nonnegative(explicit.totalTokens);
    source = "provider_context";
  } else if (explicit?.state !== "unavailable" && usage && assistant.api !== "cli" && event.provider !== "claude-cli" && event.harnessId !== "claude-cli") {
    const buckets = [usage.input, usage.cacheRead, usage.cacheWrite].map(nonnegative);
    if (buckets.some((value) => value !== undefined)) {
      promptTokens = buckets.reduce((sum, value) => sum + (value ?? 0), 0);
      totalTokens = promptTokens + (nonnegative(usage.output) ?? 0);
      source = "last_model_call";
    }
  }
  if (promptTokens === undefined || promptTokens <= 0 || (totalTokens !== undefined && totalTokens < promptTokens)) {
    return { state: "unavailable", ...(limit ? { limit } : {}) };
  }
  return { state: "available", promptTokens, totalTokens, source, ...(limit ? { limit } : {}), observedAt: new Date().toISOString() };
}

const eligibleTurn = (turn) => turn && !turn.abortedAt && typeof turn.replyTarget?.taskId === "string";
export function createPmTaskTelemetry({ findTurn }) {
  return {
    input(event, context) {
      const turn = findTurn(context.sessionKey);
      if (!eligibleTurn(turn) || !event.runId) return;
      (turn.modelRunIds ??= new Set()).add(event.runId);
      turn.stream?.modelContext?.(nonnegative(event.contextTokenBudget ?? context.contextTokenBudget));
    },
    async output(event, context) {
      const turn = findTurn(context.sessionKey);
      if (!eligibleTurn(turn) || !turn.modelRunIds?.delete(event.runId)) return;
      const texts = event.assistantTexts;
      if (Array.isArray(texts) && texts.length) turn.silentReply = isProtocolSilentReply(texts.at(-1));
      const usage = event.usage && typeof event.usage === "object" ? event.usage : {};
      await turn.stream?.contextUsage({
        modelRunId: event.runId,
        usageScope: "attempt",
        inputTokens: nonnegative(usage.input),
        outputTokens: nonnegative(usage.output),
        cacheReadTokens: nonnegative(usage.cacheRead),
        cacheWriteTokens: nonnegative(usage.cacheWrite),
        totalTokens: nonnegative(usage.total),
        contextLimit: nonnegative(event.contextTokenBudget ?? context.contextTokenBudget),
        contextSnapshot: latestContextSnapshot(event, context),
      });
    },
  };
}
