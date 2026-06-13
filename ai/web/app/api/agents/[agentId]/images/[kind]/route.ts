import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  AgentImageError,
  assertAgentImageKind,
  assertCanManageManualAgentImages,
  deleteAgentImage,
  readAgentImage,
  writeAgentImage,
} from "@/lib/agents/profile-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function imageHeaders(bytes: Buffer, sourceSize: number, mtimeMs: number) {
  const etag = `"${bytes.byteLength.toString(16)}-${sourceSize.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
  return {
    "content-type": "image/png",
    "content-length": String(bytes.byteLength),
    "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
    "etag": etag,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string; kind: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  try {
    const { agentId, kind } = await params;
    assertAgentImageKind(kind);
    const image = await readAgentImage(agentId, kind);
    const headers = imageHeaders(image.bytes, image.size, image.mtimeMs);
    if (request.headers.get("if-none-match") === headers.etag) {
      const { "content-length": _contentLength, ...notModifiedHeaders } = headers;
      return new NextResponse(null, { status: 304, headers: notModifiedHeaders });
    }
    return new NextResponse(new Uint8Array(image.bytes), { headers });
  } catch (err) {
    if (err instanceof AgentImageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ agentId: string; kind: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauth" }, { status: 401 });

  try {
    const { agentId, kind } = await params;
    assertAgentImageKind(kind);
    await assertCanManageManualAgentImages({
      actor: { name: session.user.name, kind: session.user.kind },
      agent: agentId,
    });

    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "image file is required" }, { status: 400 });
    }

    const saved = await writeAgentImage({
      agent: agentId,
      kind,
      file,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.id,
    });
    revalidatePath(`/agents/${agentId}`);
    revalidatePath("/agents");
    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof AgentImageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ agentId: string; kind: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauth" }, { status: 401 });

  try {
    const { agentId, kind } = await params;
    assertAgentImageKind(kind);
    await assertCanManageManualAgentImages({
      actor: { name: session.user.name, kind: session.user.kind },
      agent: agentId,
    });
    const removed = await deleteAgentImage({
      agent: agentId,
      kind,
      actorUserId: session.user.id,
      actorName: session.user.name ?? session.user.id,
    });
    revalidatePath(`/agents/${agentId}`);
    revalidatePath("/agents");
    return NextResponse.json(removed);
  } catch (err) {
    if (err instanceof AgentImageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
