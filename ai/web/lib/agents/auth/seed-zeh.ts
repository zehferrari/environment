import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

const SEED_USERNAME = "zeh";
const SEED_EMAIL = "e@zeh.me";
const SEED_PASSWORD = process.env.PM_SEED_ZEH_PASSWORD ?? "password1"; // Stage 1 only.

/**
 * Seed the zeh human user with the description-mandated temporary password.
 * Idempotent — only seeds when the row is absent.
 */
export async function seedZehUser(): Promise<{ seeded: boolean }> {
  const existing = await db.user.findUnique({ where: { username: SEED_USERNAME } });
  if (existing) {
    const ownerExists = await db.user.findFirst({
      where: { kind: "human", isOwner: true },
      select: { id: true },
    });
    if (!ownerExists && existing.kind === "human") {
      await db.user.update({ where: { id: existing.id }, data: { isOwner: true } });
    }
    return { seeded: false };
  }

  const ownerExists = await db.user.findFirst({
    where: { kind: "human", isOwner: true },
    select: { id: true },
  });

  await db.user.create({
    data: {
      username: SEED_USERNAME,
      email: SEED_EMAIL,
      kind: "human",
      passwordHash: await hashPassword(SEED_PASSWORD),
      passwordSetAt: new Date(),
      mustRotatePassword: true,
      isOwner: !ownerExists,
    },
  });
  return { seeded: true };
}
