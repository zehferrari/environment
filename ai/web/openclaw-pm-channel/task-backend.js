// CLI subprocesses do not inherit tools registered in the gateway process.
// Check the whole configured fallback chain: switching backend must not leave
// a compact turn with instructions for tools that cannot exist there.
export function nativeTaskToolsSupported(cfg, agentId = "main") {
  const defaults = cfg?.agents?.defaults ?? {};
  const agent = cfg?.agents?.entries?.[agentId] ?? cfg?.agents?.list?.find((entry) => entry.id === agentId);
  const model = agent?.model ?? defaults.model;
  const primary = typeof model === "string" ? model : model?.primary;
  const fallbacks = typeof model === "object" && Array.isArray(model?.fallbacks)
    ? model.fallbacks : agent?.fallbacks ?? defaults.model?.fallbacks ?? [];
  if (typeof primary !== "string" || !primary.includes("/")) return false;
  return [primary, ...fallbacks].every((ref) => {
    if (typeof ref !== "string" || !ref.includes("/")) return false;
    const provider = ref.split("/")[0].toLowerCase();
    const providerConfig = cfg?.models?.providers?.[provider];
    const id = ref.slice(ref.indexOf("/") + 1);
    const catalog = providerConfig?.models?.find((row) => row.id === id || row.id === ref);
    const runtime = defaults.models?.[ref]?.agentRuntime?.id
      ?? catalog?.agentRuntime?.id ?? providerConfig?.agentRuntime?.id;
    const api = providerConfig?.api;
    // OpenClaw 2026.9 uses canonical provider names plus execution policy,
    // e.g. anthropic/claude-fable-5-1 with agentRuntime.id = claude-cli.
    if (runtime && (runtime.endsWith("-cli") || runtime === "codex-app-server")) return false;
    return !provider.endsWith("-cli") && provider !== "codex-app-server"
      && !String(api ?? "").endsWith("-cli")
      && !Object.hasOwn(defaults.cliBackends ?? {}, provider);
  });
}
