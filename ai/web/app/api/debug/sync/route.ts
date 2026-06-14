import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { syncAgents } from "@/lib/agents/management/sync";
import { seedZehUser } from "@/lib/agents/auth/seed-zeh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Debug endpoint: returns the loaded codeOwner + agent sync result.
// Locked behind auth — Stage 1 only; Stage 2 (HOMELAB-44) gates by role.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  const zeh = await seedZehUser();
  const result = await syncAgents();
  return NextResponse.json({ zeh, result });
}
