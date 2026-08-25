// PHASEE-10 — Legacy invocation summary API endpoint (PM internal API surface).
//
// Read-only GET that returns legacy-invocation counts by boundary id +
// entry point, sourced from the boundary-registry counter contract
// (task.workflow.legacy_boundary.invoked ActivityLog rows).

import { NextResponse, type NextRequest } from "next/server";
import {
  authenticateAgentBearer,
  isLoopbackRequest,
} from "@/lib/agents/context/api/auth";
import { getLegacyInvocationSummary } from "@/lib/tasks/orchestrator/dashboard-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isLoopbackRequest(req)) {
    return NextResponse.json(
      { error: "Loopback-only endpoint. Call PM at http://127.0.0.1:3000 from on-host." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  if (!await authenticateAgentBearer(req.headers.get("authorization"))) {
    return NextResponse.json(
      { error: "Invalid or missing agent bearer" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (since && !Number.isFinite(since.getTime())) {
    return NextResponse.json(
      { error: "since must be an ISO-8601 timestamp" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const summary = await getLegacyInvocationSummary(projectId, { since });
  return NextResponse.json(
    { ok: true, legacyInvocations: summary },
    { headers: { "cache-control": "no-store" } },
  );
}
