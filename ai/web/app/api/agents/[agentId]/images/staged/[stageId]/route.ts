import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOwnerUserId } from "@/lib/auth/permissions";
import { AgentImageError, readStagedAgentImagesState } from "@/lib/agents/management/profile-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string; stageId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauth" }, { status: 401 });
  if (!(await isOwnerUserId(session.user.id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const { agentId, stageId } = await params;
    return NextResponse.json(await readStagedAgentImagesState(agentId, stageId));
  } catch (err) {
    if (err instanceof AgentImageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
