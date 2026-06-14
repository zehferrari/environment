import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ProfileError, readAgentProfile } from "@/lib/agents/management/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  try {
    const { agentId } = await params;
    return NextResponse.json(await readAgentProfile(agentId));
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
