// GET /api/agents/context/project/<projectId> — loopback + agent-bearer auth.
// Returns project env + epics + open tasks + active principals. Use when
// the agent is about to propose work-item changes and needs to avoid
// duplicates / pick valid assignees.
// See ai/web/docs/agent-pm-api.md.

import { NextResponse, type NextRequest } from "next/server";
import {
  authenticateAgentContextRequest,
  isLoopbackRequest,
} from "@/lib/agents/context/api/auth";
import { buildProjectContextJson } from "@/lib/agents/context/api/serialize";

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
  const identity = await authenticateAgentContextRequest(req, "project", id);
  if (!identity) {
    return NextResponse.json({ error: "Invalid or missing agent context grant" }, { status: 401 });
  }

  const data = await buildProjectContextJson(id);
  if (!data) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}
