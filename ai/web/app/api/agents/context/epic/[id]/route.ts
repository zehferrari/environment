// GET /api/agents/context/epic/<epicId> — loopback + agent-bearer auth.
// See ai/web/docs/agent-pm-api.md.

import { NextResponse, type NextRequest } from "next/server";
import {
  authenticateAgentContextRequest,
  isLoopbackRequest,
} from "@/lib/agents/context-api/auth";
import { buildEpicContextJson } from "@/lib/agents/context-api/serialize";

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
  const { id } = await ctx.params;
  const identity = await authenticateAgentContextRequest(req, "epic", id);
  if (!identity) {
    return NextResponse.json({ error: "Invalid or missing agent context grant" }, { status: 401 });
  }

  const data = await buildEpicContextJson(id, {
    attachmentGrant: identity.grantId ? req.nextUrl.searchParams.get("grant") : null,
  });
  if (!data) return NextResponse.json({ error: "Epic not found" }, { status: 404 });

  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}
