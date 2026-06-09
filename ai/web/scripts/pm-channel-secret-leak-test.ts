import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { createContextGrant } from "@/lib/agents/context-grants";

// Asserts the security invariant that raw capability tokens are never
// persisted in plaintext: ContextGrant stores only a sha256 hash, and the raw
// grant token must not surface in ActivityLog payloads or PmChannelStreamEvent
// payloads. (The grant URL handed in-prompt is by-design: short-lived, scoped,
// and use-limited — that is the intended capability delivery channel.)

function sha256(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function main() {
  const nonce = `leak-${Date.now()}`;
  await db.contextGrant.deleteMany({ where: { turnId: nonce } });

  const { token, grant } = await createContextGrant({
    agentSlug: "asdrubal",
    scopeType: "task",
    scopeId: `task-${nonce}`,
    turnId: nonce,
    maxUses: 1,
  });

  // 1. The persisted row stores the hash, never the raw token.
  const row = await db.contextGrant.findUniqueOrThrow({
    where: { id: grant.id },
    select: { tokenHash: true, agentSlug: true, scopeId: true, includes: true },
  });
  assert.equal(row.tokenHash, sha256(token), "grant must be stored sha256-hashed");
  assert.notEqual(row.tokenHash, token, "stored hash must not equal the raw token");
  const serializedRow = JSON.stringify(row);
  assert.equal(
    serializedRow.includes(token),
    false,
    "no ContextGrant column may contain the raw grant token",
  );

  // 2. No ActivityLog payload may contain the raw token.
  const leakedActivity = await db.activityLog.findFirst({
    where: { payload: { contains: token } },
    select: { id: true, kind: true },
  });
  assert.equal(leakedActivity, null, "raw grant token leaked into an ActivityLog payload");

  // 3. No persisted stream-event payload may contain the raw token.
  const leakedStream = await db.pmChannelStreamEvent.findFirst({
    where: { payload: { contains: token } },
    select: { id: true, kind: true },
  });
  assert.equal(leakedStream, null, "raw grant token leaked into a PmChannelStreamEvent payload");

  await db.contextGrant.deleteMany({ where: { turnId: nonce } });
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log("pm channel secret leak tests passed");
  })
  .catch(async (err) => {
    await db.$disconnect();
    console.error(err);
    process.exit(1);
  });
