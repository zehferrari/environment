import { NextResponse } from "next/server";
import { syncAgents } from "@/lib/agents/management/sync";
import { bootstrapOwner } from "@/lib/agents/auth/bootstrap-owner";
import { getViewer } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Debug endpoint: returns the loaded codeOwner + agent sync result.
// Locked behind auth — Stage 1 only; Stage 2 (HOMELAB-44) gates by role.
export async function GET() {
  const viewer = await getViewer();
  if (!viewer?.canAccessOwnerFeatures) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const ownerBootstrap = await bootstrapOwner();
  const result = await syncAgents();
  return NextResponse.json({ ownerBootstrap, result });
}
