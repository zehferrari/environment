import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

const PICTURES_ROOT = "/srv/agents/Pictures";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return NextResponse.json({ error: "invalid avatar name" }, { status: 400 });
  }

  const file = path.join(PICTURES_ROOT, name, "avatar.png");
  const resolved = path.resolve(file);
  const root = path.resolve(PICTURES_ROOT) + path.sep;
  if (!resolved.startsWith(root)) {
    return NextResponse.json({ error: "invalid avatar path" }, { status: 400 });
  }

  try {
    const bytes = await readFile(resolved);
    return new NextResponse(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "avatar not found" }, { status: 404 });
  }
}
