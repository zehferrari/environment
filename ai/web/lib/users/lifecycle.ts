import type { PrismaClient } from "@prisma/client";

type DisabledAccountDb = Pick<PrismaClient, "passwordResetToken" | "webPushSubscription">;

/** Revoke credentials and device delivery endpoints for a disabled account. */
export async function revokeDisabledHumanAccountAccess(
  client: DisabledAccountDb,
  userId: string,
  now: Date,
): Promise<void> {
  await client.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: now },
  });
  await client.webPushSubscription.deleteMany({ where: { userId } });
}
