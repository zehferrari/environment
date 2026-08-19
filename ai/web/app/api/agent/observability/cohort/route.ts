// PHASEE-10 — Cohort summary API endpoint (PM internal API surface).
//
// Read-only GET that returns cohort summary data across all projects
// (or a single project if ?projectId= is specified). Built on the
// getCohortSummary function from dashboard-data.ts.

import { NextResponse, type NextRequest } from "next/server";
import { getCohortSummary } from "@/lib/tasks/orchestrator/dashboard-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? undefined;

  const summary = await getCohortSummary(projectId);
  return NextResponse.json({ ok: true, cohort: summary });
}