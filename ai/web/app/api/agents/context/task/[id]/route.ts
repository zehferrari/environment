// GET /api/agents/context/task/<taskId>
//
// On-host, loopback-only, bearer-auth read API consumed by OpenClaw agents.
// Replaces the legacy practice of PM inlining a 58 KB context packet into
// every dispatch — see ai/web/docs/agent-pm-api.md for the contract.

import { NextResponse, type NextRequest } from "next/server";
import {
  authenticateAgentBearer,
  isLoopbackRequest,
} from "@/lib/agents/context-api/auth";
import { buildTaskContextJson } from "@/lib/agents/context-api/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!isLoopbackRequest(req)) {
    return NextResponse.json(
      { error: "Loopback-only endpoint. Call PM at http://127.0.0.1:3000 from on-host." },
      { status: 403 },
    );
  }
  const identity = await authenticateAgentBearer(req.headers.get("authorization"));
  if (!identity) {
    return NextResponse.json({ error: "Invalid or missing agent bearer token" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const data = await buildTaskContextJson(id);
  if (!data) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  return NextResponse.json(data, {
    headers: { "cache-control": "no-store" },
  });
}
