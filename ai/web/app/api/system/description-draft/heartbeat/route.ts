// Description-draft heartbeat — keeps the requester's draft alive while
// their task/epic page is open. The DescriptionField client component pings
// this endpoint every 15s; the row's lastSeenAt bumps to now. If the user
// closes the page (or the tab goes inactive long enough), pings stop and
// the reaper purges the row within ~60s. See lib/description-drafts.ts.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { touchDescriptionDraft, type DraftScope } from "@/lib/description-drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isScope(value: unknown): value is DraftScope {
  return value === "task" || value === "epic";
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const requesterUserId = session?.user?.id;
  if (!requesterUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { scope?: unknown; targetId?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const scope = payload.scope;
  const targetId = typeof payload.targetId === "string" ? payload.targetId : "";
  if (!isScope(scope) || !targetId) {
    return NextResponse.json(
      { error: "scope ('task'|'epic') and targetId are required" },
      { status: 400 },
    );
  }

  await touchDescriptionDraft({ scope, targetId, requesterUserId });
  return NextResponse.json({ ok: true });
}
