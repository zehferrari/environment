/**
 * Model-provider catalog — shared by the agent form (client), the model-refresh
 * API, and the provisioning renderer. `google-gravity` was retired; the fleet
 * now runs on Codex, the Claude CLI, local Ollama, and OpenRouter.
 *
 * `connection` is the verbatim `models.providers[<id>]` block written into an
 * agent's openclaw.json; `authMode` (when set) adds an `auth.profiles` entry.
 *
 * Provider ids, `api` values, and model namespaces below were reconciled against
 * the installed openclaw bundle (`/usr/local/lib/node_modules/openclaw`): Codex
 * and Ollama match live agent configs; the Claude provider is keyed `anthropic`
 * with `api: "claude-cli"` (CLI OAuth) and an `auth.profiles` provider of
 * `claude-cli`; OpenRouter is OpenAI-compatible, so it uses the supported
 * `openai-completions` adapter while model refs stay namespaced as
 * `openrouter/<vendor>/<model>`.
 */

export type ProviderId = "openai-codex" | "anthropic" | "ollama" | "openrouter";

export type ProviderModel = { id: string; name: string; free?: boolean };

export type RefreshKind = "ollama" | "openrouter" | "anthropic" | "codex";

export type ProviderDef = {
  id: ProviderId;
  name: string;
  /** Canonical OpenClaw config key when it differs from the PM/UI provider id. */
  configId?: string;
  /** Canonical model-ref namespace when it differs from the PM/UI provider id. */
  modelNamespace?: string;
  /** Verbatim openclaw.json `models.providers[id]` block (minus `.models`). */
  connection: { baseUrl: string; apiKey: string; api: string; auth?: "oauth" | "token" };
  /** When set, an `auth.profiles[id:default]` entry is written with this mode. */
  authMode?: "oauth" | "token";
  /** `auth.profiles[id:default].provider` when it differs from the block key. */
  authProvider?: string;
  /** How the refresh endpoint fetches this provider's live model list. */
  refresh: RefreshKind;
  /** Curated/known models shown before (or instead of) a live refresh. */
  seedModels: ProviderModel[];
  /** Filters the refresh UI may offer for this provider. */
  filters?: Array<"installed" | "popular" | "free">;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    configId: "openai",
    modelNamespace: "openai",
    connection: {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "codex-app-server",
      api: "openai-chatgpt-responses",
      auth: "oauth",
    },
    authMode: "oauth",
    authProvider: "openai",
    refresh: "codex",
    seedModels: [{ id: "gpt-5.5", name: "gpt-5.5" }],
  },
  {
    // openclaw normalises claude model refs to `anthropic/<model>`; the CLI
    // OAuth transport is selected by api `claude-cli` + a `claude-cli` profile.
    id: "anthropic",
    name: "Claude CLI",
    connection: {
      baseUrl: "https://api.anthropic.com",
      apiKey: "claude-cli-oauth",
      api: "claude-cli",
      auth: "oauth",
    },
    authMode: "oauth",
    authProvider: "claude-cli",
    refresh: "anthropic",
    seedModels: [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (local + cloud)",
    connection: {
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "ollama-local",
      api: "ollama",
    },
    refresh: "ollama",
    seedModels: [
      { id: "kimi-k2.7-code:cloud", name: "kimi-k2.7-code:cloud" },
      { id: "gemma4:31b-cloud", name: "gemma4:31b-cloud" },
      { id: "nemotron-3-ultra:cloud", name: "nemotron-3-ultra:cloud" },
      { id: "qwen2.5:3b-instruct", name: "qwen2.5:3b-instruct (offline fallback)" },
    ],
    filters: ["installed", "popular"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    connection: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "openrouter-api-key",
      api: "openai-completions",
      auth: "token",
    },
    authMode: "token",
    refresh: "openrouter",
    seedModels: [],
    filters: ["popular", "free"],
  },
];

export const PROVIDER_IDS: ProviderId[] = PROVIDERS.map((p) => p.id);

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isProviderId(id: string): id is ProviderId {
  return PROVIDER_IDS.includes(id as ProviderId);
}

/** "openai-codex/gpt-5.5" → "openai-codex". */
export function providerOfModelRef(ref: string): string {
  return ref.split("/")[0] ?? "";
}

/** "openai-codex/gpt-5.5" → "gpt-5.5" (handles ids that themselves contain "/"). */
export function modelIdOfRef(ref: string): string {
  const i = ref.indexOf("/");
  return i === -1 ? ref : ref.slice(i + 1);
}

/** Compact chip label: strips provider + verbose suffixes, à la dashboard shortModel. */
export function shortModelLabel(ref: string): string {
  const id = modelIdOfRef(ref);
  return id.replace(/^claude-/, "").replace(/:cloud$/, "");
}
