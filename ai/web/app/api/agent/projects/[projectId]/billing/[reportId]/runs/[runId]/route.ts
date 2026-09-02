import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyBillingCallbackToken } from "@/lib/billing/token";
import { applyBillingRunResult, parseLedger, type SubmittedBillingDay } from "@/lib/billing/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

function bearer(request: NextRequest) {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get("authorization") ?? "").trim());
  return match ? match[1].trim() : "";
}

async function authorize(request: NextRequest, projectId: string, reportId: string, runId: string) {
  const run = await db.billingRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      ledger: true,
      report: { select: { id: true, projectId: true, agentSlug: true, status: true } },
    },
  });
  if (!run || run.report.id !== reportId || run.report.projectId !== projectId) {
    return { ok: false as const, response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  if (!verifyBillingCallbackToken(projectId, runId, run.report.agentSlug, bearer(request))) {
    return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  const active = await db.agent.findFirst({
    where: { slug: run.report.agentSlug, deactivatedAt: null, user: { is: { status: "active" } } },
    select: { id: true },
  });
  if (!active) {
    return { ok: false as const, response: NextResponse.json({ error: "agent_inactive" }, { status: 403 }) };
  }
  return { ok: true as const, run };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; reportId: string; runId: string }> },
) {
  const { projectId, reportId, runId } = await context.params;
  const auth = await authorize(request, projectId, reportId, runId);
  if (!auth.ok) return auth.response;
  const ledger = parseLedger(auth.run.ledger);
  if (!ledger) return NextResponse.json({ error: "no_ledger" }, { status: 409 });
  return NextResponse.json({ reportId, runId, status: auth.run.status, ledger });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; reportId: string; runId: string }> },
) {
  const { projectId, reportId, runId } = await context.params;
  const auth = await authorize(request, projectId, reportId, runId);
  if (!auth.ok) return auth.response;
  if (auth.run.report.status === "final") {
    return NextResponse.json({ error: "finalized" }, { status: 409 });
  }
  if (["ready", "accepted", "superseded", "discarded"].includes(auth.run.status)) {
    return NextResponse.json({ error: "already_submitted" }, { status: 410 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = parsed as { days?: unknown; notes?: unknown };
  if (!Array.isArray(body.days)) return NextResponse.json({ error: "days_required" }, { status: 400 });

  const days: SubmittedBillingDay[] = [];
  for (const entry of body.days) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.day !== "string") continue;
    days.push({
      day: row.day,
      summary: typeof row.summary === "string" ? row.summary : "",
      estimatedMinutes: typeof row.estimatedMinutes === "number" ? row.estimatedMinutes : Number(row.estimatedMinutes),
      rationale: typeof row.rationale === "string" ? row.rationale : null,
    });
  }
  const applied = await applyBillingRunResult({
    runId,
    days,
    notes: typeof body.notes === "string" ? body.notes : null,
  });
  if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 409 });

  await db.activityLog.create({
    data: {
      projectId,
      kind: "project.billing.result",
      targetAgent: auth.run.report.agentSlug,
      payload: JSON.stringify({ reportId, runId, written: applied.written, skipped: applied.skipped }),
    },
  });
  return NextResponse.json({ ok: true, written: applied.written, skipped: applied.skipped });
}
