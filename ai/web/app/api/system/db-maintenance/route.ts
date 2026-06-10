// SQLite maintenance trigger (ENV-27/ZL-001). Runs WAL checkpoint + PRAGMA
// optimize and a conditional VACUUM (see lib/db-maintenance.ts). Guarded for
// the admin user OR a direct on-host loopback call so a host cron can drive it
// without a session.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { isLoopbackRequest } from "@/lib/agents/context-api/auth";
import { runDbMaintenance, type DbMaintenanceResult } from "@/lib/db-maintenance";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function shouldStoreMaintenanceActivity(result: DbMaintenanceResult) {
  return Boolean(
    result.error ||
    result.vacuumed ||
    (result.pagesReclaimed != null && result.pagesReclaimed > 0) ||
    (result.checkpoint?.busy ?? 0) > 0,
  );
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const isAdmin = session?.user?.name === "zeh";
  if (!isAdmin && !isLoopbackRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await runDbMaintenance();

  if (shouldStoreMaintenanceActivity(result)) {
    try {
      await db.activityLog.create({
        data: {
          kind: "db.maintenance",
          payload: JSON.stringify(result),
          userId: session?.user?.id ?? null,
        },
      });
    } catch (err) {
      console.error("[db-maintenance] failed to persist audit row:", err);
    }
  }

  return NextResponse.json(result, {
    status: result.error ? 500 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
