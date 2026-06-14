import { execFile } from "child_process";
import { mkdir, readFile, stat } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";

const PICTURES_ROOT = "/srv/agents/Pictures";
const THUMB_ROOT = "/tmp/pm-web-agent-avatars";
const THUMB_SIZE = 160;
const execFileAsync = promisify(execFile);

function avatarHeaders(bytes: Buffer, sourceSize: number, mtimeMs: number) {
  const etag = `"${bytes.byteLength.toString(16)}-${sourceSize.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
  return {
    "content-type": "image/png",
    "content-length": String(bytes.byteLength),
    "cache-control": "public, max-age=0, must-revalidate",
    "etag": etag,
  };
}

async function readThumbnail(source: string, name: string, mtimeMs: number, sourceSize: number) {
  const cacheName = `${name}-${Math.floor(mtimeMs)}-${sourceSize}-${THUMB_SIZE}.png`;
  const cachePath = path.join(THUMB_ROOT, cacheName);
  try {
    return await readFile(cachePath);
  } catch {
    await mkdir(THUMB_ROOT, { recursive: true });
    await execFileAsync("/usr/bin/magick", [
      source,
      "-auto-orient",
      "-thumbnail",
      `${THUMB_SIZE}x${THUMB_SIZE}^`,
      "-gravity",
      "center",
      "-extent",
      `${THUMB_SIZE}x${THUMB_SIZE}`,
      "-strip",
      `PNG8:${cachePath}`,
    ], { timeout: 10000 });
    return readFile(cachePath);
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
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
    const fileStat = await stat(resolved);
    let bytes: Buffer;
    try {
      bytes = await readThumbnail(resolved, name, fileStat.mtimeMs, fileStat.size);
    } catch {
      bytes = await readFile(resolved);
    }
    const headers = avatarHeaders(bytes, fileStat.size, fileStat.mtimeMs);
    if (req.headers.get("if-none-match") === headers.etag) {
      const { "content-length": _contentLength, ...notModifiedHeaders } = headers;
      return new NextResponse(null, { status: 304, headers: notModifiedHeaders });
    }
    return new NextResponse(new Uint8Array(bytes), { headers });
  } catch {
    return NextResponse.json({ error: "avatar not found" }, { status: 404 });
  }
}
