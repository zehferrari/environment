import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";

type BootstrapOwnerResult =
  | { status: "existing-owner" }
  | { status: "not-configured" }
  | { status: "created"; username: string }
  | { status: "promoted-existing-user"; username: string };

type BootstrapOwnerConfig = {
  username: string;
  email: string;
  password: string;
};

function readBootstrapOwnerConfig(): BootstrapOwnerConfig | null {
  const username = process.env.PM_BOOTSTRAP_OWNER_USERNAME?.trim() ?? "";
  const email = process.env.PM_BOOTSTRAP_OWNER_EMAIL?.trim() ?? "";
  const password = process.env.PM_BOOTSTRAP_OWNER_PASSWORD ?? "";
  const configured = [username, email, password].filter(Boolean).length;

  if (configured === 0) return null;

  const missing = [
    !username ? "PM_BOOTSTRAP_OWNER_USERNAME" : null,
    !email ? "PM_BOOTSTRAP_OWNER_EMAIL" : null,
    !password ? "PM_BOOTSTRAP_OWNER_PASSWORD" : null,
  ].filter((name): name is string => Boolean(name));
  if (missing.length > 0) {
    throw new Error(`Initial owner bootstrap is incomplete; set ${missing.join(", ")}.`);
  }

  return { username, email, password };
}

/**
 * Create the initial Mission Control owner only for an uninitialized database.
 * Existing installations already have an owner and are never changed here.
 */
export async function bootstrapOwner(): Promise<BootstrapOwnerResult> {
  const ownerExists = await db.user.findFirst({
    where: { kind: "human", isOwner: true },
    select: { id: true },
  });
  if (ownerExists) return { status: "existing-owner" };

  const config = readBootstrapOwnerConfig();
  if (!config) return { status: "not-configured" };

  const existing = await db.user.findUnique({ where: { username: config.username } });
  if (existing) {
    if (existing.kind !== "human") {
      throw new Error(`Initial owner username @${config.username} belongs to an agent account.`);
    }
    await db.user.update({ where: { id: existing.id }, data: { isOwner: true } });
    return { status: "promoted-existing-user", username: config.username };
  }

  await db.user.create({
    data: {
      username: config.username,
      email: config.email,
      kind: "human",
      passwordHash: await hashPassword(config.password),
      passwordSetAt: new Date(),
      mustRotatePassword: false,
      isOwner: true,
    },
  });
  return { status: "created", username: config.username };
}
