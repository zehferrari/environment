import { NextRequest, NextResponse } from "next/server";
import { getViewer } from "@/lib/auth/permissions";
import { readSwitchState } from "@/lib/deploy/worktrees";
import { getSwitchProject } from "@/lib/deploy/switch-registry";

export const dynamic = "force-dynamic";

// Human-only poll endpoint for the live-preview worktree switcher. Returns the
// runner-maintained state (served worktree, inventory, on/off, current job) for
// the project identified by ?repoKey=. Each project has its own spool, so the
// caller must say which one it wants.
export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer?.isOwner) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const repoKey = req.nextUrl.searchParams.get("repoKey");
  const project = getSwitchProject(repoKey);
  if (!project) {
    return NextResponse.json({ error: "unknown project" }, { status: 404 });
  }
  const state = await readSwitchState(project.spoolDir);
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}
