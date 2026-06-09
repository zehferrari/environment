// System-wide settings reader + fallback resolvers.
//
// A single `SystemSettings` row (id "system") holds global defaults used
// when a project leaves the matching field blank:
//   - git identity (name/email) for agent commits;
//   - doneTtlDays for automatic archiving of Done tasks;
//   - binTtlDays for how long ANY soft-delete bin is kept before purge.
//   - theme for the system UI.
//
// This module is read-only (no "use server") so server components and the
// purge jobs can import it directly. Writes go through lib/settings/actions.ts.

import { db } from "@/lib/db";

export const DONE_TTL_FALLBACK_DAYS = 5;

export interface SystemSettingsValues {
  defaultGitUserName: string | null;
  defaultGitUserEmail: string | null;
  doneTtlDays: number | null;
  binTtlDays: number | null;
  theme: SystemTheme;
}

export type SystemTheme = "light" | "dark";

const EMPTY: SystemSettingsValues = {
  defaultGitUserName: null,
  defaultGitUserEmail: null,
  doneTtlDays: null,
  binTtlDays: null,
  theme: "light",
};

export async function getSystemSettings(): Promise<SystemSettingsValues> {
  const row = await db.systemSettings.findUnique({
    where: { id: "system" },
    select: {
      defaultGitUserName: true,
      defaultGitUserEmail: true,
      doneTtlDays: true,
      binTtlDays: true,
      theme: true,
    },
  });
  if (!row) return EMPTY;
  return {
    ...row,
    theme: normalizeTheme(row.theme),
  };
}

export function normalizeTheme(value: unknown): SystemTheme {
  return value === "dark" ? "dark" : "light";
}

// Automatic archive age (days): project value → system value → hardcoded fallback.
export async function resolveDoneTtlDays(
  projectDoneTtlDays: number | null,
): Promise<number> {
  if (projectDoneTtlDays != null) return projectDoneTtlDays;
  const sys = await getSystemSettings();
  return sys.doneTtlDays ?? DONE_TTL_FALLBACK_DAYS;
}

// Effective git identity for a project: project value → system value → null.
export async function resolveGitIdentity(project: {
  defaultGitUserName: string | null;
  defaultGitUserEmail: string | null;
}): Promise<{ name: string | null; email: string | null }> {
  const sys = await getSystemSettings();
  return {
    name: project.defaultGitUserName ?? sys.defaultGitUserName ?? null,
    email: project.defaultGitUserEmail ?? sys.defaultGitUserEmail ?? null,
  };
}

// Bin retention in ms for a purge job. `SystemSettings.binTtlDays`, when
// set, overrides every bin uniformly; otherwise the job's own env var
// (e.g. PM_BIN_TTL_DAYS) wins; otherwise the built-in fallback.
export async function resolveBinTtlMs(
  envVar: string,
  fallbackDays: number,
): Promise<number> {
  const sys = await getSystemSettings();
  if (sys.binTtlDays != null && sys.binTtlDays > 0) {
    return sys.binTtlDays * 86_400_000;
  }
  const raw = process.env[envVar];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 86_400_000;
  }
  return fallbackDays * 86_400_000;
}
