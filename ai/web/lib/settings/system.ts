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
import { DEFAULT_PROFILE_IMAGE_PROMPT, normalizeProfileImagePrompt } from "@/lib/agents/management/profile-image-options";
import { DEFAULT_DEPLOY_REVIEW_PROMPT, normalizeDeployReviewPrompt } from "@/lib/epics/deploy-review";
import { normalizeCurrency } from "@/lib/billing/rate";

export const DONE_TTL_FALLBACK_DAYS = 5;

export interface SystemSettingsValues {
  defaultGitUserName: string | null;
  defaultGitUserEmail: string | null;
  doneTtlDays: number | null;
  binTtlDays: number | null;
  theme: SystemTheme;
  openRouterApiKey: string | null;
  hasOpenRouterApiKey: boolean;
  openRouterReferer: string | null;
  openRouterTitle: string | null;
  profileImagePrompt: string;
  deployReviewPrompt: string;
  integrationDefaults: string | null;
  hourlyRateCents: number | null;
  billingCurrency: string | null;
}

export type SystemTheme = "light" | "dark";

const EMPTY: SystemSettingsValues = {
  defaultGitUserName: null,
  defaultGitUserEmail: null,
  doneTtlDays: null,
  binTtlDays: null,
  theme: "light",
  openRouterApiKey: null,
  hasOpenRouterApiKey: false,
  openRouterReferer: null,
  openRouterTitle: null,
  profileImagePrompt: DEFAULT_PROFILE_IMAGE_PROMPT,
  deployReviewPrompt: DEFAULT_DEPLOY_REVIEW_PROMPT,
  integrationDefaults: null,
  hourlyRateCents: null,
  billingCurrency: null,
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
      openRouterApiKey: true,
      openRouterReferer: true,
      openRouterTitle: true,
      profileImagePrompt: true,
      deployReviewPrompt: true,
      integrationDefaults: true,
      hourlyRateCents: true,
      billingCurrency: true,
    },
  });
  if (!row) return EMPTY;
  return {
    ...row,
    theme: normalizeTheme(row.theme),
    hasOpenRouterApiKey: Boolean(row.openRouterApiKey),
    profileImagePrompt: normalizeProfileImagePrompt(row.profileImagePrompt),
    deployReviewPrompt: normalizeDeployReviewPrompt(row.deployReviewPrompt),
    billingCurrency: normalizeCurrency(row.billingCurrency),
  };
}

export function normalizeTheme(value: unknown): SystemTheme {
  return value === "dark" ? "dark" : "light";
}

async function primaryWorkspaceDefaults(projectId: string | undefined) {
  if (!projectId) return null;
  const link = await db.workspaceProject.findFirst({
    where: { projectId, workspace: { archivedAt: null } },
    orderBy: { createdAt: "asc" },
    select: { workspace: { select: { defaultGitUserName: true, defaultGitUserEmail: true, doneTtlDays: true } } },
  });
  return link?.workspace ?? null;
}

// Automatic archive age (days): project value → workspace value → system value → hardcoded fallback.
export async function resolveDoneTtlDays(
  projectDoneTtlDays: number | null,
  projectId?: string,
): Promise<number> {
  if (projectDoneTtlDays != null) return projectDoneTtlDays;
  const [workspace, sys] = await Promise.all([primaryWorkspaceDefaults(projectId), getSystemSettings()]);
  return workspace?.doneTtlDays ?? sys.doneTtlDays ?? DONE_TTL_FALLBACK_DAYS;
}

// Effective git identity for a project: project value → workspace value → system value → null.
export async function resolveGitIdentity(project: {
  id?: string;
  defaultGitUserName: string | null;
  defaultGitUserEmail: string | null;
}): Promise<{ name: string | null; email: string | null }> {
  const [workspace, sys] = await Promise.all([primaryWorkspaceDefaults(project.id), getSystemSettings()]);
  return {
    name: project.defaultGitUserName ?? workspace?.defaultGitUserName ?? sys.defaultGitUserName ?? null,
    email: project.defaultGitUserEmail ?? workspace?.defaultGitUserEmail ?? sys.defaultGitUserEmail ?? null,
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
