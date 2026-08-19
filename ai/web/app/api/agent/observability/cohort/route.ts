// PHASEE-10 — Cohort summary API endpoint (PM internal API surface).
//
// Read-only GET that returns cohort summary data across all projects
// (or a single project if ?projectId= is specified). Built on the
// getCohortSummary function from dashboard-data.ts.

import { NextResponse, type NextRequest } from "next/server";
import {
  authenticateAgentBearer,
  isLoopbackRequest,
} from "@/lib/agents/context/api/auth";
import { getCohortSummary } from "@/lib/tasks/orchestrator/dashboard-data";

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

  const summary = await getCohortSummary(projectId);
  return NextResponse.json(
    { ok: true, cohort: summary },
    { headers: { "cache-control": "no-store" } },
  );
}
