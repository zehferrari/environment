import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { accessibleProjectWhere, requireViewer } from "@/lib/auth/permissions";
import {
  canReadRepository,
  chooseCodeSource,
  listCodeSources,
  normalizeRepoRelativePath,
  readRepositoryImageBytes,
} from "@/lib/projects/repo-code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streams raw image bytes for a repo file so the Code tab can preview images
// inline (<img src=...>). Browser-session auth only — agents never hit this.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  let viewer;
  try { viewer = await requireViewer(); } catch {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!viewer.isOwner) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { slug } = await ctx.params;
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug }),
    select: { repositoryPath: true, deletedAt: true },
  });
  if (!project || project.deletedAt || !project.repositoryPath) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const sources = await listCodeSources(project.repositoryPath);
  const source = chooseCodeSource(sources, url.searchParams.get("source") ?? undefined);
  if (!source) {
    return NextResponse.json({ error: "no_source" }, { status: 404 });
  }
  if (!(await canReadRepository(source.path))) {
    return NextResponse.json({ error: "unreadable" }, { status: 403 });
  }

  const relPath = normalizeRepoRelativePath(url.searchParams.get("path") ?? undefined);
  if (!relPath) {
    return NextResponse.json({ error: "bad_path" }, { status: 400 });
  }

  const image = await readRepositoryImageBytes(source, relPath);
  if (!image) {
    return NextResponse.json({ error: "not_an_image" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      "Content-Type": image.mime,
      "Content-Length": String(image.bytes.length),
      // Private: scoped to a signed-in user; the worktree contents can change.
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
