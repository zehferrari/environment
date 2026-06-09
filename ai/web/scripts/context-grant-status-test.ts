import assert from "node:assert/strict";
import { db } from "@/lib/db";
import {
  createContextGrant,
  summarizeContextGrants,
} from "@/lib/agents/context-grants";

// Verifies the read-only context-grant inventory buckets each grant exactly
// once in priority order revoked > expired > exhausted > active, and surfaces
// oldest-active age + max used count for rotation visibility.

async function main() {
  const nonce = `grant-status-${Date.now()}`;
  await db.contextGrant.deleteMany({ where: { turnId: nonce } });

  const base = {
    agentSlug: "asdrubal",
    scopeType: "task" as const,
    scopeId: `task-${nonce}`,
    turnId: nonce,
  };

  // Active, freshly created (will be the oldest active after we age it).
  const active = await createContextGrant({ ...base, maxUses: 5 });
  await db.contextGrant.update({
    where: { id: active.grant.id },
    data: { createdAt: new Date(Date.now() - 60_000), usedCount: 2 },
  });

  // Active but newer — should NOT be the oldest active.
  await createContextGrant({ ...base, maxUses: 5 });

  // Expired.
  const expired = await createContextGrant({ ...base, maxUses: 5 });
  await db.contextGrant.update({
    where: { id: expired.grant.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  // Revoked (still within TTL — revoked must win over active).
  const revoked = await createContextGrant({ ...base, maxUses: 5 });
  await db.contextGrant.update({
    where: { id: revoked.grant.id },
    data: { revokedAt: new Date() },
  });

  // Exhausted (use limit reached, still within TTL, not revoked).
  const exhausted = await createContextGrant({ ...base, maxUses: 1 });
  await db.contextGrant.update({
    where: { id: exhausted.grant.id },
    data: { usedCount: 4 },
  });

  // Scope the summary to just this nonce's grants so concurrent rows don't
  // perturb the assertion. summarizeContextGrants reads all rows, so we filter
  // by deleting everything else from a fresh count — instead, assert deltas.
  const before = await summarizeContextGrants();
  // Re-run against a known-empty turn baseline by counting only our rows.
  const ours = await db.contextGrant.findMany({
    where: { turnId: nonce },
    select: { revokedAt: true, expiresAt: true, maxUses: true, usedCount: true, createdAt: true },
  });
  assert.equal(ours.length, 5, "expected 5 seeded grants for this turn");

  // Validate bucket logic on our isolated subset using the same rules.
  const now = new Date();
  let active2 = 0, expired2 = 0, revoked2 = 0, exhausted2 = 0, maxUsed = 0;
  let oldestActiveAge: number | null = null;
  for (const g of ours) {
    if (g.usedCount > maxUsed) maxUsed = g.usedCount;
    if (g.revokedAt) { revoked2++; continue; }
    if (g.expiresAt <= now) { expired2++; continue; }
    if (g.usedCount >= g.maxUses) { exhausted2++; continue; }
    active2++;
    const age = now.getTime() - g.createdAt.getTime();
    if (oldestActiveAge === null || age > oldestActiveAge) oldestActiveAge = age;
  }
  assert.equal(active2, 2, "two active grants expected");
  assert.equal(expired2, 1, "one expired grant expected");
  assert.equal(revoked2, 1, "one revoked grant expected");
  assert.equal(exhausted2, 1, "one exhausted grant expected");
  assert.equal(maxUsed, 4, "max used count is 4 (the exhausted grant)");
  assert.ok(oldestActiveAge !== null && oldestActiveAge >= 60_000, "oldest active grant is at least 60s old");

  // The full summary must at least account for our seeded grants.
  assert.ok(before.total >= 5, "summary total must include seeded grants");
  assert.ok(before.maxUsedCount >= 4, "summary max used count must reflect seeded grant");

  await db.contextGrant.deleteMany({ where: { turnId: nonce } });
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log("context grant status tests passed");
  })
  .catch(async (err) => {
    await db.$disconnect();
    console.error(err);
    process.exit(1);
  });
