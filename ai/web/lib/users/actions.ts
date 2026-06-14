"use server";

// Human-user profile editing (display name + avatar). Admin-only: gated to
// the code owner (zeh), mirroring lib/agents/management/profile.ts::canEditProfile.
// The avatar is resized to a square PNG via ImageMagick (same binary the
// agent-avatar route uses) and stored inline on the User row — small, and
// there are only a handful of human users.

import { revalidatePath } from "next/cache";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const execFileAsync = promisify(execFile);
const AVATAR_SIZE = 256;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // raw upload cap before resize

async function isAdmin(): Promise<boolean> {
  const session = await auth();
  // No RBAC layer yet (RolePermission is a stub) — the code owner is the
  // de-facto admin, same rule as agent profile editing.
  return session?.user?.name === "zeh";
}

async function resizeToAvatarPng(input: Buffer): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await mkdtemp(path.join(tmpdir(), "pm-avatar-"));
  try {
    const src = path.join(dir, "src");
    const dst = path.join(dir, "out.png");
    await writeFile(src, input);
    // [0] = first frame (handles multi-frame inputs); square center-crop.
    await execFileAsync(
      "/usr/bin/magick",
      [
        `${src}[0]`,
        "-auto-orient",
        "-thumbnail",
        `${AVATAR_SIZE}x${AVATAR_SIZE}^`,
        "-gravity",
        "center",
        "-extent",
        `${AVATAR_SIZE}x${AVATAR_SIZE}`,
        "-strip",
        `PNG8:${dst}`,
      ],
      { timeout: 15000 },
    );
    // Copy into a fresh ArrayBuffer-backed Uint8Array (Prisma's Bytes type
    // wants Uint8Array<ArrayBuffer>, not Node's Buffer<ArrayBufferLike>).
    const buf = await readFile(dst);
    const out = new Uint8Array(buf.byteLength);
    out.set(buf);
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function updateHumanProfile(formData: FormData) {
  if (!(await isAdmin())) throw new Error("Not authorized");

  const userId = String(formData.get("userId") ?? "");
  if (!userId) return;
  const nameRaw = String(formData.get("name") ?? "").trim();
  const newName = nameRaw === "" ? null : nameRaw.slice(0, 120);
  const removeAvatar = formData.get("removeAvatar") === "on";

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, kind: true },
  });
  if (!user || user.kind !== "human") return;

  let avatarBytes: Uint8Array<ArrayBuffer> | null = null;
  const file = formData.get("avatar");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error("Avatar image exceeds 8 MiB.");
    }
    try {
      avatarBytes = await resizeToAvatarPng(Buffer.from(await file.arrayBuffer()));
    } catch {
      throw new Error("Could not process that image — try a PNG, JPG or WebP.");
    }
  }

  await db.user.update({
    where: { id: userId },
    data: {
      name: newName,
      ...(avatarBytes
        ? { avatar: avatarBytes, avatarUpdatedAt: new Date() }
        : removeAvatar
          ? { avatar: null, avatarUpdatedAt: null }
          : {}),
    },
  });

  revalidatePath("/system/users");
  revalidatePath("/", "layout"); // refresh the sidebar chip avatar/name
}
