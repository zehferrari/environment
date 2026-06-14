import { NextResponse, type NextRequest } from "next/server";
import { resolvePmChannelToken } from "@/lib/agents/pm-channel/openclaw";
import { authorizePmChannelCallback } from "@/lib/agents/pm-channel/callback-auth";
import { applyPmChannelStreamCallback } from "@/lib/agents/pm-channel/stream-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configuredToken() {
  return process.env.PM_OPENCLAW_CHANNEL_TOKEN
    ?? process.env.PM_OPENCLAW_CHANNEL_CALLBACK_TOKEN
    ?? "";
}

function bearerToken(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : "";
}

function targetAgentSlug(payload: Record<string, unknown>) {
  const target = payload.target;
  if (!target || typeof target !== "object") return "";
  const agentSlug = (target as Record<string, unknown>).agentSlug;
  return typeof agentSlug === "string" ? agentSlug : "";
}

export async function POST(req: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const agentSlug = targetAgentSlug(payload);
  const actualToken = bearerToken(req);
  const expectedShared = configuredToken();
  const expectedAgent = agentSlug ? await resolvePmChannelToken(agentSlug) : null;
  if (!authorizePmChannelCallback({
    presented: actualToken,
    expectedShared,
    expectedAgent,
  })) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await applyPmChannelStreamCallback({
    payload,
    transportMode: "http",
    rateLimit: true,
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
