import { readFile } from "node:fs/promises";
import { configPath, readAgentModelSettings, type OpenClawConfig } from "./model-settings";

// Published IDs are suggestions, never evidence of account entitlement.
// Verified 2026-09-10: developers.openai.com/api/docs/models/gpt-6-astra,
// anthropic.com/claude/fable and anthropic.com/claude/opus.
const published: Record<string, string[]> = {
  openai: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  "claude-cli": ["claude-fable-5-1", "claude-opus-5", "claude-fable-5"],
  anthropic: ["claude-fable-5-1", "claude-opus-5", "claude-fable-5"],
};

export async function discoverAgentModels(agent: string, provider: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw new Error("Invalid provider");
  const settings = await readAgentModelSettings(agent);
  if (!settings.readable) throw new Error("Cannot read agent configuration");
  const cfg = JSON.parse(await readFile(configPath(agent), "utf8")) as OpenClawConfig;
  const configured = settings.available.filter((m) => m.id.startsWith(`${provider}/`));
  const models = new Map(configured.map((m) => [m.id, { ...m, configured: true }]));
  let source: "live" | "published-and-configured" = "published-and-configured";
  let note = "Published suggestions last checked 10 September 2026; account access is unverified. You can enter an exact model ID.";
  let ids = published[provider] ?? [];
  try {
    const key = cfg.models?.providers?.[provider]?.apiKey;
    if (provider === "openai" && typeof key === "string" && key.startsWith("sk-")) {
      const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Model list HTTP ${res.status}`);
      const json = await res.json() as { data?: Array<{ id: string }> };
      ids = (json.data ?? []).map((m) => m.id).filter((id) => /^(gpt-|o[1-9])/.test(id) && !/(audio|realtime|transcri|tts|image|search)/.test(id));
      source = "live"; note = "Listed by this agent's OpenAI API account. Runtime compatibility still depends on its configured transport.";
    } else if (provider === "ollama") {
      const res = await fetch("http://127.0.0.1:11434/api/tags", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Model list HTTP ${res.status}`);
      const json = await res.json() as { models?: Array<{ name: string }> };
      ids = (json.models ?? []).map((m) => m.name);
      source = "live"; note = "Models listed by the local Ollama server.";
    }
  } catch {
    // Never return upstream bodies/headers; they can contain account details.
    note = "Live model check failed. Showing configured models and published suggestions; access is unverified.";
  }
  for (const id of ids) {
    const ref = `${provider}/${id}`;
    if (!models.has(ref)) models.set(ref, { id: ref, label: ref, configured: false });
  }
  return { provider, source, note, checkedAt: new Date().toISOString(), models: [...models.values()] };
}
