import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readSwitchState } from "@/lib/deploy/worktrees";

export const dynamic = "force-dynamic";

// Human-only poll endpoint for the live-preview worktree switcher. Returns the
// runner-maintained state (served worktree, inventory, current job).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || session.user.kind === "agent") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const state = await readSwitchState();
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}
