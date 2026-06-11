import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const messageSenderSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
} as const;

function serializeSender(sender: {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
}) {
  return {
    id: sender.id,
    username: sender.username,
    kind: sender.kind,
    name: sender.name,
    avatarUpdatedAt: sender.avatarUpdatedAt?.toISOString() ?? null,
    agent: sender.agent,
  };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ agentId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Take the NEWEST `limit` messages (desc), then restore chronological order.
  // Ordering asc + take would keep the OLDEST rows and drop recent ones in a
  // long active chat — including the in-flight turn the poll is reconciling.
  const rows = await db.directAgentChatMessage.findMany({
    where: { agentSlug, archiveId: null },
    orderBy: { createdAt: "desc" },
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
