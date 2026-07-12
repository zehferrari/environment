"use server";

// System-settings save action. Mirrors lib/projects/actions.ts: blank
// fields are stored as null so the resolvers in lib/settings/system.ts
// fall through to the next level (project → system → built-in).

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth/permissions";
import { normalizeTheme } from "@/lib/settings/system";
import { normalizeDeployReviewPrompt } from "@/lib/epics/deploy-review";

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

function jsonObjectTextOrNull(v: unknown): string | null {
  const raw = trimOrNull(v);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return JSON.stringify(parsed, null, 2);
  } catch {
    throw new Error("Integration defaults must be a JSON object.");
  }
}

export async function setSystemSettings(formData: FormData) {
  const owner = await requireOwner();
  const userId = owner.id;

  const rawScope = String(formData.get("settingsScope") ?? "general");
  const scope = rawScope === "models" ? "models" : "general";
  const data: {
    defaultGitUserName?: string | null;
    defaultGitUserEmail?: string | null;
    doneTtlDays?: number | null;
    binTtlDays?: number | null;
    theme?: ReturnType<typeof normalizeTheme>;
    openRouterApiKey?: string | null;
    openRouterReferer?: string | null;
    openRouterTitle?: string | null;
    integrationDefaults?: string | null;
    deployReviewPrompt?: string | null;
  } = {};
  const payload: Record<string, unknown> = { scope };

  if (scope === "general") {
    data.defaultGitUserName = trimOrNull(formData.get("defaultGitUserName"));
    data.defaultGitUserEmail = trimOrNull(formData.get("defaultGitUserEmail"));
    data.doneTtlDays = intOrNull(formData.get("doneTtlDays"), 1, 365);
    data.binTtlDays = intOrNull(formData.get("binTtlDays"), 1, 3650);
    data.theme = normalizeTheme(formData.get("theme"));
    data.integrationDefaults = jsonObjectTextOrNull(formData.get("integrationDefaults"));
    data.deployReviewPrompt = normalizeDeployReviewPrompt(formData.get("deployReviewPrompt"));
    Object.assign(payload, { ...data, integrationDefaults: data.integrationDefaults ? "set" : null });
  } else {
    const current = await db.systemSettings.findUnique({
      where: { id: "system" },
      select: { openRouterApiKey: true },
    });
    const incomingKey = trimOrNull(formData.get("openRouterApiKey"));
    const clearKey = formData.get("clearOpenRouterApiKey") === "on";
    data.openRouterApiKey = clearKey ? null : incomingKey ?? current?.openRouterApiKey ?? null;
    data.openRouterReferer = trimOrNull(formData.get("openRouterReferer"));
    data.openRouterTitle = trimOrNull(formData.get("openRouterTitle"));
    payload.openRouterApiKey = clearKey ? "cleared" : incomingKey ? "set" : current?.openRouterApiKey ? "unchanged" : "empty";
    payload.openRouterReferer = data.openRouterReferer;
    payload.openRouterTitle = data.openRouterTitle;
  }

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
        payload: JSON.stringify(payload),
      },
    }),
  ]);

  revalidatePath("/system/settings");
  revalidatePath("/system/settings?tab=models");
  revalidatePath("/");
}
