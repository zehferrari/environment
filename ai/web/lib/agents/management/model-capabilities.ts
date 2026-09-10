// Verified against official model/effort documentation on 2026-09-10.
// Keep explicit metadata for releases newer than the host's bundled catalogue.
export const KNOWN_MODEL_CAPABILITIES: Record<string, { reasoning: boolean; contextWindow: number; maxTokens: number; input: string[]; compat: { supportsReasoningEffort: boolean; supportedReasoningEfforts: string[] } }> = {
  "openai/gpt-6-astra": { reasoning: true, contextWindow: 1050000, maxTokens: 128000, input: ["text", "image"], compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] } },
  "claude-cli/claude-fable-5-1": { reasoning: true, contextWindow: 1000000, maxTokens: 128000, input: ["text", "image"], compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] } },
  "anthropic/claude-fable-5-1": { reasoning: true, contextWindow: 1000000, maxTokens: 128000, input: ["text", "image"], compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] } },
};
