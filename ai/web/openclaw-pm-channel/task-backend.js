// CLI subprocesses do not inherit tools registered in the gateway process.
// Check the whole configured fallback chain: switching backend must not leave
// a compact turn with instructions for tools that cannot exist there.
export function nativeTaskToolsSupported(cfg, agentId = "main") {
  const defaults = cfg?.agents?.defaults ?? {};
  const agent = cfg?.agents?.list?.find((entry) => entry.id === agentId);
  const model = agent?.model ?? defaults.model;
  const primary = typeof model === "string" ? model : model?.primary;
  const fallbacks = typeof model === "object" && Array.isArray(model?.fallbacks)
    ? model.fallbacks : agent?.fallbacks ?? defaults.model?.fallbacks ?? [];
  if (typeof primary !== "string" || !primary.includes("/")) return false;
  return [primary, ...fallbacks].every((ref) => {
    if (typeof ref !== "string" || !ref.includes("/")) return false;
    const provider = ref.split("/")[0].toLowerCase();
    const api = cfg?.models?.providers?.[provider]?.api;
    return !provider.endsWith("-cli") && provider !== "codex-app-server"
      && !String(api ?? "").endsWith("-cli")
      && !Object.hasOwn(defaults.cliBackends ?? {}, provider);
  });
}
