"use server";

// Human-user invitation, access management, and profile editing. Every entry
// point is owner-gated; project memberships are the visibility grant.
// The avatar is resized to a square PNG via ImageMagick (same binary the
// agent-avatar route uses) and stored inline on the User row — small, and
// there are only a handful of human users.

import { revalidatePath } from "next/cache";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { requireOwner } from "@/lib/auth/permissions";

const execFileAsync = promisify(execFile);
const AVATAR_SIZE = 256;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // raw upload cap before resize

function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizedUsername(value: FormDataEntryValue | null): string {
  return String(value ?? "").trim().toLowerCase();
}

function selectedProjectIds(formData: FormData): string[] {
  return [...new Set(formData.getAll("projectId").map(String).filter(Boolean))];
}

async function validateProjectIds(projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const count = await db.project.count({
    where: { id: { in: projectIds }, deletedAt: null },
  });
  if (count !== projectIds.length) throw new Error("One or more projects are unavailable.");
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
  await requireOwner();

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

export async function inviteHumanUser(formData: FormData) {
  await requireOwner();

  const username = normalizedUsername(formData.get("username"));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const displayName = String(formData.get("name") ?? "").trim();
  const projectIds = selectedProjectIds(formData);

  if (!/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/.test(username)) {
    throw new Error("Username must be 3-64 lowercase letters, numbers, dots, hyphens, or underscores.");
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    throw new Error("A valid email address is required.");
  }
  if (displayName.length > 120) throw new Error("Display name must be 120 characters or fewer.");
  await validateProjectIds(projectIds);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username,
        email,
        name: displayName || null,
        kind: "human",
        status: "invited",
        isOwner: false,
        mustRotatePassword: false,
      },
      select: { id: true },
    });
    if (projectIds.length > 0) {
      await tx.projectMember.createMany({
        data: projectIds.map((projectId) => ({ projectId, userId: user.id, role: "member" })),
      });
    }
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: inviteTokenHash(token),
        expiresAt,
      },
    });
  });

  revalidatePath("/system/users");
  redirect(`/system/users?invite=${encodeURIComponent(token)}`);
}

export async function updateHumanProjectAccess(formData: FormData) {
  await requireOwner();
  const userId = String(formData.get("userId") ?? "");
  const projectIds = selectedProjectIds(formData);
  if (!userId) return;
  await validateProjectIds(projectIds);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { kind: true, isOwner: true },
  });
  if (!user || user.kind !== "human") return;
  if (user.isOwner) throw new Error("The Mission Control owner has access to every project.");

  await db.$transaction(async (tx) => {
    await tx.projectMember.deleteMany({ where: { userId } });
    if (projectIds.length > 0) {
      await tx.projectMember.createMany({
        data: projectIds.map((projectId) => ({ projectId, userId, role: "member" })),
      });
    }
  });

  revalidatePath("/system/users");
  revalidatePath("/", "layout");
}

export async function resetHumanPassword(formData: FormData) {
  await requireOwner();
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, kind: true, status: true },
  });
  if (!user || user.kind !== "human" || user.status !== "active") {
    throw new Error("Only active human users can receive a password reset link.");
  }

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await db.$transaction([
    db.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    }),
    db.passwordResetToken.create({
      data: {
        userId,
        tokenHash: inviteTokenHash(token),
        expiresAt,
      },
    }),
  ]);

  revalidatePath("/system/users");
  redirect(
    `/system/users?reset=${encodeURIComponent(token)}&resetUser=${encodeURIComponent(user.username)}`,
  );
}

export async function setPasswordFromToken(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("passwordConfirmation") ?? "");
  if (!token) throw new Error("Password token is missing.");
  if (password.length < 12) throw new Error("Password must be at least 12 characters.");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const invitation = await db.passwordResetToken.findUnique({
    where: { tokenHash: inviteTokenHash(token) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      user: { select: { kind: true, status: true } },
    },
  });
  if (
    !invitation ||
    invitation.usedAt ||
    invitation.expiresAt <= new Date() ||
    invitation.user.kind !== "human" ||
    !["active", "invited"].includes(invitation.user.status)
  ) {
    throw new Error("This password link is invalid or has expired.");
  }

  const now = new Date();
  const wasInvited = invitation.user.status === "invited";
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: invitation.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new Error("This password link has already been used.");

    await tx.user.update({
      where: { id: invitation.userId },
      data: {
        passwordHash,
        passwordSetAt: now,
        mustRotatePassword: false,
        status: "active",
      },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: invitation.userId, usedAt: null },
      data: { usedAt: now },
    });
  });

  redirect(wasInvited ? "/login?invited=1" : "/login?reset=1");
}
