"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth/permissions";
import { parseRateInputToCents } from "@/lib/billing/rate";

type RateScope = { type: "global"; key: "global" }
  | { type: "workspace"; key: string; id: string; slug: string }
  | { type: "project"; key: string; id: string; slug: string };

function validDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Start on must be a valid date.");
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error("Start on must be a valid date.");
  }
  return raw;
}

async function resolveScope(typeRaw: unknown, idRaw: unknown): Promise<RateScope> {
  const type = String(typeRaw ?? "");
  const id = String(idRaw ?? "").trim();
  if (type === "global") return { type: "global", key: "global" };
  if (type === "workspace") {
    const workspace = await db.workspace.findUnique({ where: { id }, select: { id: true, slug: true } });
    if (!workspace) throw new Error("Workspace not found.");
    return { type, id: workspace.id, slug: workspace.slug, key: `workspace:${workspace.id}` };
  }
  if (type === "project") {
    const project = await db.project.findFirst({ where: { id, deletedAt: null }, select: { id: true, slug: true } });
    if (!project) throw new Error("Project not found.");
    return { type, id: project.id, slug: project.slug, key: `project:${project.id}` };
  }
  throw new Error("Invalid billing-rate scope.");
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function syncLegacyCurrentRate(scope: RateScope) {
  const current = await db.billingRateSchedule.findFirst({
    where: { scopeKey: scope.key, startOn: { lte: today() } },
    orderBy: [{ startOn: "desc" }, { createdAt: "desc" }],
    select: { amountCents: true },
  });
  if (scope.type === "global") {
    await db.systemSettings.upsert({
      where: { id: "system" },
      create: { id: "system", hourlyRateCents: current?.amountCents ?? null },
      update: { hourlyRateCents: current?.amountCents ?? null },
    });
  } else if (scope.type === "workspace") {
    await db.workspace.update({ where: { id: scope.id }, data: { hourlyRateCents: current?.amountCents ?? null } });
  } else {
    await db.project.update({ where: { id: scope.id }, data: { hourlyRateCents: current?.amountCents ?? null } });
  }
}

function revalidateScope(scope: RateScope) {
  if (scope.type === "global") revalidatePath("/system/settings");
  if (scope.type === "workspace") {
    revalidatePath(`/workspaces/${scope.slug}/settings`);
    revalidatePath(`/workspaces/${scope.slug}/billing`);
  }
  if (scope.type === "project") {
    revalidatePath(`/projects/${scope.slug}/settings`);
    revalidatePath(`/projects/${scope.slug}/billing`);
  }
}

export async function saveBillingRateScheduleRow(formData: FormData) {
  await requireOwner();
  const scope = await resolveScope(formData.get("scopeType"), formData.get("scopeId"));
  const id = String(formData.get("id") ?? "").trim();
  const startOn = validDate(formData.get("startOn"));
  const amountCents = parseRateInputToCents(formData.get("amount"));
  if (!amountCents) throw new Error("Amount must be greater than zero.");

  if (id) {
    const row = await db.billingRateSchedule.findUnique({ where: { id }, select: { scopeKey: true } });
    if (!row || row.scopeKey !== scope.key) throw new Error("Rate row not found.");
    await db.billingRateSchedule.update({ where: { id }, data: { startOn, amountCents } });
  } else {
    await db.billingRateSchedule.create({
      data: {
        scopeKey: scope.key,
        scopeType: scope.type,
        workspaceId: scope.type === "workspace" ? scope.id : null,
        projectId: scope.type === "project" ? scope.id : null,
        startOn,
        amountCents,
      },
    });
  }
  await syncLegacyCurrentRate(scope);
  revalidateScope(scope);
}

export async function deleteBillingRateScheduleRow(formData: FormData) {
  await requireOwner();
  const scope = await resolveScope(formData.get("scopeType"), formData.get("scopeId"));
  const id = String(formData.get("id") ?? "").trim();
  const row = await db.billingRateSchedule.findUnique({ where: { id }, select: { scopeKey: true } });
  if (!row || row.scopeKey !== scope.key) throw new Error("Rate row not found.");
  await db.billingRateSchedule.delete({ where: { id } });
  await syncLegacyCurrentRate(scope);
  revalidateScope(scope);
}
