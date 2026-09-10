import { isProtocolSilentReply } from "./turn-completion.js";
// Observe provider-reported usage only; never retain prompt, reasoning or credentials.
const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
export function createPmTaskTelemetry({ findTurn }) {
  return {
    input(event, context) {
      const turn = findTurn(context.sessionKey);
      if (!turn || turn.abortedAt || !turn.taskRuntime || !event.runId) return;
      (turn.modelRunIds ??= new Set()).add(event.runId);
    },
    async output(event, context) {
      const turn = findTurn(context.sessionKey);
      if (!turn || turn.abortedAt || !turn.taskRuntime || !turn.modelRunIds?.delete(event.runId)) return;
      const texts = event.assistantTexts;
      if (Array.isArray(texts) && texts.length) turn.silentReply = isProtocolSilentReply(texts.at(-1));
      if (!event.usage || typeof event.usage !== "object") return;
      await turn.stream?.contextUsage({
        modelRunId: event.runId,
        inputTokens: nonnegative(event.usage.input),
        outputTokens: nonnegative(event.usage.output),
        cacheReadTokens: nonnegative(event.usage.cacheRead),
        cacheWriteTokens: nonnegative(event.usage.cacheWrite),
        totalTokens: nonnegative(event.usage.total),
        contextLimit: nonnegative(event.contextTokenBudget ?? context.contextTokenBudget),
      });
    },
  };
}
