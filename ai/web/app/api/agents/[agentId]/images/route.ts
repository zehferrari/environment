import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AgentImageError, readAgentImagesState } from "@/lib/agents/management/profile-images";
import { isOwnerUserId } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauth" }, { status: 401 });
  if (!(await isOwnerUserId(session.user.id))) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const { agentId } = await params;
    return NextResponse.json(await readAgentImagesState(agentId));
  } catch (err) {
    if (err instanceof AgentImageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
