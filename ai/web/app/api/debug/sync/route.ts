import { NextResponse } from "next/server";
import { syncAgents } from "@/lib/agents/management/sync";
import { seedZehUser } from "@/lib/agents/auth/seed-zeh";
import { getViewer } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Debug endpoint: returns the loaded codeOwner + agent sync result.
// Locked behind auth — Stage 1 only; Stage 2 (HOMELAB-44) gates by role.
export async function GET() {
  const viewer = await getViewer();
  if (!viewer?.isOwner) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const zeh = await seedZehUser();
  const result = await syncAgents();
  return NextResponse.json({ zeh, result });
}
