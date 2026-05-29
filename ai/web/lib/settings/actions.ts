"use server";

// System-settings save action. Mirrors lib/projects/actions.ts: blank
// fields are stored as null so the resolvers in lib/settings/system.ts
// fall through to the next level (project → system → built-in).

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function intOrNull(v: unknown, min: number, max: number): number | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function setSystemSettings(formData: FormData) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Unauthenticated");

  const defaultGitUserName = trimOrNull(formData.get("defaultGitUserName"));
  const defaultGitUserEmail = trimOrNull(formData.get("defaultGitUserEmail"));
  const doneTtlDays = intOrNull(formData.get("doneTtlDays"), 1, 365);
  const binTtlDays = intOrNull(formData.get("binTtlDays"), 1, 3650);

  const data = { defaultGitUserName, defaultGitUserEmail, doneTtlDays, binTtlDays };

  await db.$transaction([
    db.systemSettings.upsert({
      where: { id: "system" },
      create: { id: "system", ...data },
      update: data,
    }),
    db.activityLog.create({
      data: {
        userId,
        kind: "system.settings",
        payload: JSON.stringify(data),
      },
    }),
  ]);

  revalidatePath("/system/settings");
}
