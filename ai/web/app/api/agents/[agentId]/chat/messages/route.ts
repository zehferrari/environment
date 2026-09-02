import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { messageSenderSelect, serializeSender } from "@/lib/agents/chat/message-sender";
import { directChatCursorWhere, parseDirectChatCursor } from "@/lib/agents/chat/direct/cursor";
import { isOwnerUserId } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ agentId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isOwnerUserId(session.user.id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { agentId } = await ctx.params;
  const agentSlug = agentId.trim();
  if (!agentSlug) {
    return NextResponse.json({ error: "Missing agent" }, { status: 400 });
  }

  const limitParam = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "120", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(200, Math.max(1, limitParam))
    : 120;

  // Optional incremental cursor: the poll passes the (createdAt, id) pair for
  // its newest known message. The composite cursor prevents same-timestamp
  // messages from being skipped while still avoiding >= re-fetch churn.
  const cursor = parseDirectChatCursor(req.nextUrl.searchParams);

  // Take the NEWEST `limit` messages (desc), then restore chronological order.
  // Ordering asc + take would keep the OLDEST rows and drop recent ones in a
  // long active chat — including the in-flight turn the poll is reconciling.
  const rows = await db.directAgentChatMessage.findMany({
    where: {
      agentSlug,
      archiveId: null,
      billingRunId: null,
      ...directChatCursorWhere(cursor),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: {
      sender: { select: messageSenderSelect },
      deletedBy: { select: { username: true, name: true, kind: true } },
    },
  });
  rows.reverse();

  return NextResponse.json({
    messages: rows.map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      sender: serializeSender(m.sender),
      deletedAt: m.deletedAt?.toISOString() ?? null,
      deletedBy: m.deletedBy,
    })),
  });
}
