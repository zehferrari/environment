import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isOwnerUserId } from "@/lib/auth/permissions";
import { getProvider, type ProviderModel } from "@/lib/agents/management/providers";
import { getSystemSettings } from "@/lib/settings/system";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live model list for a provider, used by the agent form's "Refresh models"
 * action. Falls back to the provider's curated seed list when the live source
 * is unreachable or needs credentials we don't hold (so the UI never empties).
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!(await isOwnerUserId(session.user.id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const providerId = req.nextUrl.searchParams.get("provider") ?? "";
  const filter = req.nextUrl.searchParams.get("filter") ?? "";
  const provider = getProvider(providerId);
  if (!provider) return NextResponse.json({ error: "unknown_provider" }, { status: 400 });

  const ctrl = AbortSignal.timeout(8000);

  try {
    if (provider.refresh === "ollama") {
      const models = await fetchOllama(provider.connection.baseUrl, filter, ctrl);
      return NextResponse.json({ provider: providerId, source: "live", models });
    }
    if (provider.refresh === "openrouter") {
      const settings = await getSystemSettings();
      const models = await fetchOpenRouter(filter, ctrl, settings.openRouterApiKey);
      return NextResponse.json({ provider: providerId, source: "live", models });
    }
    if (provider.refresh === "anthropic") {
      const models = await fetchAnthropic(ctrl);
      if (models) return NextResponse.json({ provider: providerId, source: "live", models });
    }
    // codex (no public list endpoint) and anthropic-without-key fall through.
    return NextResponse.json({ provider: providerId, source: "curated", models: provider.seedModels });
  } catch (err) {
    console.error(`[agents/models] ${providerId} refresh failed, returning seed:`, err);
    return NextResponse.json({ provider: providerId, source: "curated", models: provider.seedModels });
  }
}

async function fetchOllama(baseUrl: string, filter: string, signal: AbortSignal): Promise<ProviderModel[]> {
  if (filter === "popular") return OLLAMA_POPULAR;
  // Default: models actually pulled on this host.
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`ollama /api/tags ${res.status}`);
  const json = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
  const seen = new Set<string>();
  const out: ProviderModel[] = [];
  for (const m of json.models ?? []) {
    const id = m.name || m.model;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: id });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchOpenRouter(filter: string, signal: AbortSignal, apiKey?: string | null): Promise<ProviderModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal, cache: "no-store", headers });
  if (!res.ok) throw new Error(`openrouter /models ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string } }>;
  };
  let rows = json.data ?? [];
  const isFree = (p?: { prompt?: string; completion?: string }) =>
    p != null && Number(p.prompt ?? "1") === 0 && Number(p.completion ?? "1") === 0;
  if (filter === "free") rows = rows.filter((m) => isFree(m.pricing));
  if (filter === "popular") rows = rows.filter((m) => POPULAR_OPENROUTER_PREFIXES.some((p) => m.id.startsWith(p)));
  return rows
    .map((m) => ({ id: m.id, name: m.name || m.id, free: isFree(m.pricing) }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 400);
}

async function fetchAnthropic(signal: AbortSignal): Promise<ProviderModel[] | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null; // claude-cli is OAuth-only here; no key to list with.
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    signal,
    cache: "no-store",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`anthropic /models ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
}

// Curated popular Ollama cloud models (the host bridges :cloud to ollama.com).
const OLLAMA_POPULAR: ProviderModel[] = [
  { id: "gpt-oss:120b-cloud", name: "gpt-oss:120b-cloud" },
  { id: "deepseek-v3.1:671b-cloud", name: "deepseek-v3.1:671b-cloud" },
  { id: "qwen3-coder:480b-cloud", name: "qwen3-coder:480b-cloud" },
  { id: "gemma4:31b-cloud", name: "gemma4:31b-cloud" },
  { id: "nemotron-3-ultra:cloud", name: "nemotron-3-ultra:cloud" },
];

const POPULAR_OPENROUTER_PREFIXES = [
  "anthropic/",
  "openai/",
  "google/",
  "meta-llama/",
  "deepseek/",
  "qwen/",
  "mistralai/",
  "x-ai/",
];
