import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  AgentImageError,
  assertAgentImageKind,
  readStagedAgentImage,
} from "@/lib/agents/profile-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function imageHeaders(bytes: Buffer, sourceSize: number, mtimeMs: number) {
  const etag = `"${bytes.byteLength.toString(16)}-${sourceSize.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
  return {
    "content-type": "image/png",
    "content-length": String(bytes.byteLength),
    "cache-control": "private, max-age=300, stale-while-revalidate=86400",
    "etag": etag,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string; stageId: string; kind: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });

  try {
    const { agentId, stageId, kind } = await params;
    assertAgentImageKind(kind);
    const image = await readStagedAgentImage(agentId, stageId, kind);
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
