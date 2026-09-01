// Billing run callback.
//
// GET  — the full ledger for the run, for an agent that wants more than the
//        compact table it was dispatched with.
// POST — the agent's answer: one summary and estimate per day.
//
// Auth is the HMAC in lib/billing/token.ts, bound to (projectId, reportId,
// agentSlug) and presented as a bearer token. Single use is enforced by the
// REPORT, not the token: a report that is already `ready`, `failed` or `final`
// refuses another write, so a leaked token cannot reopen a settled invoice.
//
// The agent never states what was committed. Facts come from the stored ledger,
// and a submitted day that is not in it is dropped rather than billed.

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyBillingCallbackToken } from "@/lib/billing/token";
import { applyBillingResult, parseLedger, type SubmittedBillingDay } from "@/lib/billing/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

function bearer(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

async function authorize(request: NextRequest, projectId: string, reportId: string) {
  const report = await db.billingReport.findUnique({
    where: { id: reportId },
    select: { id: true, projectId: true, agentSlug: true, status: true, ledger: true },
  });
  // A report that belongs to another project answers exactly like one that does
  // not exist, so the endpoint is not an oracle for which report ids are real.
  if (!report || report.projectId !== projectId) {
    return { ok: false as const, response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  }
  if (!verifyBillingCallbackToken(projectId, reportId, report.agentSlug, bearer(request))) {
    return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  const agent = await db.agent.findFirst({
    where: { slug: report.agentSlug, deactivatedAt: null, user: { is: { status: "active" } } },
    select: { slug: true },
  });
  if (!agent) {
    return { ok: false as const, response: NextResponse.json({ error: "agent_inactive" }, { status: 403 }) };
  }
  return { ok: true as const, report };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; reportId: string }> },
) {
  const { projectId, reportId } = await context.params;
  const auth = await authorize(request, projectId, reportId);
  if (!auth.ok) return auth.response;

  const ledger = parseLedger(auth.report.ledger);
  if (!ledger) return NextResponse.json({ error: "no_ledger" }, { status: 409 });
  return NextResponse.json({ reportId, status: auth.report.status, ledger });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; reportId: string }> },
) {
  const { projectId, reportId } = await context.params;
  const auth = await authorize(request, projectId, reportId);
  if (!auth.ok) return auth.response;

  if (auth.report.status === "final") {
    return NextResponse.json({ error: "finalized" }, { status: 409 });
  }
  // Answered once already. 410 rather than 409 so a retrying agent can tell
  // "you are too late" from "try again".
  if (auth.report.status === "ready") {
    return NextResponse.json({ error: "already_submitted" }, { status: 410 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  }

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
  if (!Array.isArray(body.days)) {
    return NextResponse.json({ error: "days_required" }, { status: 400 });
  }

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

  const applied = await applyBillingResult({
    reportId,
    days,
    notes: typeof body.notes === "string" ? body.notes : null,
  });
  if (!applied.ok) {
    return NextResponse.json({ error: applied.error }, { status: 409 });
  }

  await db.activityLog.create({
    data: {
      projectId,
      userId: null,
      kind: "project.billing.result",
      targetAgent: auth.report.agentSlug,
      payload: JSON.stringify({ reportId, written: applied.written, skipped: applied.skipped }),
    },
  });

  return NextResponse.json({
    ok: true,
    written: applied.written,
    // Named back so the agent can see which days it invented or misspelled.
    skipped: applied.skipped,
  });
}
