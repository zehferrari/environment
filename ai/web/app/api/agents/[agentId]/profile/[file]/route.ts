import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  assertProfileFile,
  canEditProfile,
  ProfileError,
  readProfileFile,
  writeProfileFile,
} from "@/lib/agents/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string; file: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  try {
    const { agentId, file } = await params;
    assertProfileFile(file);
    return NextResponse.json(await readProfileFile(agentId, file));
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ agentId: string; file: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauth" }, { status: 401 });
  try {
    const { agentId, file } = await params;
    assertProfileFile(file);
    const allowed = await canEditProfile(
      { name: session.user.name, kind: session.user.kind },
      agentId,
    );
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

    const body = (await request.json()) as { content?: unknown; sha?: unknown };
    if (typeof body.content !== "string" || typeof body.sha !== "string") {
      return NextResponse.json({ error: "content and sha are required" }, { status: 400 });
    }

    const saved = await writeProfileFile({
      agent: agentId,
      file,
      content: body.content,
      expectedSha: body.sha,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.id,
    });
    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
