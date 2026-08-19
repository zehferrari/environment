// PHASEE-10 — Legacy invocation summary API endpoint (PM internal API surface).
//
// Read-only GET that returns legacy-invocation counts by boundary id +
// entry point, sourced from the boundary-registry counter contract
// (task.workflow.legacy_boundary.invoked ActivityLog rows).

import { NextResponse, type NextRequest } from "next/server";
import { getLegacyInvocationSummary } from "@/lib/tasks/orchestrator/dashboard-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? undefined;

  const summary = await getLegacyInvocationSummary(projectId);
  return NextResponse.json({ ok: true, legacyInvocations: summary });
}