import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { resolveProjectBillingRate } from "@/lib/billing/report";

async function main() {
  const workspace = await db.workspace.create({
    data: { slug: "billing-rate-schedule-test", name: "Billing rate schedule test", billingCurrency: "NZD" },
  });
  const project = await db.project.create({
    data: {
      slug: "billing-rate-schedule-test",
      name: "Billing rate schedule test",
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });

  await db.billingRateSchedule.createMany({
    data: [
      { scopeKey: "global", scopeType: "global", startOn: "2026-01-01", amountCents: 10000 },
      { scopeKey: `workspace:${workspace.id}`, scopeType: "workspace", workspaceId: workspace.id, startOn: "2026-02-01", amountCents: 15000 },
      { scopeKey: `project:${project.id}`, scopeType: "project", projectId: project.id, startOn: "2026-03-01", amountCents: 20000 },
    ],
  });

  assert.equal((await resolveProjectBillingRate(project.id, "2025-12-31")).rate, null);
  assert.deepEqual((await resolveProjectBillingRate(project.id, "2026-01-15")).rate, {
    rateCents: 10000,
    currency: "NZD",
    source: "global",
  });
  assert.deepEqual((await resolveProjectBillingRate(project.id, "2026-02-15")).rate, {
    rateCents: 15000,
    currency: "NZD",
    source: "workspace",
  });
  assert.deepEqual((await resolveProjectBillingRate(project.id, "2026-03-15")).rate, {
    rateCents: 20000,
    currency: "NZD",
    source: "project",
  });

  await db.project.delete({ where: { id: project.id } });
  await db.workspace.delete({ where: { id: workspace.id } });
  await db.billingRateSchedule.deleteMany({ where: { scopeKey: "global" } });
  console.log("billing-rate-schedule-test ok");
}

main().finally(() => db.$disconnect());
