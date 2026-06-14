import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { createContextGrant } from "@/lib/agents/context/grants";
import {
  callPmChannelReply,
  seedDirectAgentMessage,
  cleanupDirectAgent,
} from "./lib/pm-channel-reply-route-fixture";

// Asserts the security invariant that raw capability tokens are never
// persisted in plaintext. Two token classes are covered:
//   1. Context-grant tokens: ContextGrant stores only a sha256 hash, and the
//      raw token must not surface in ActivityLog or PmChannelStreamEvent
//      payloads. (The grant URL handed in-prompt is by-design: short-lived,
//      scoped, and use-limited — the intended capability delivery channel.)
//   2. PM-channel callback bearers (shared + per-agent): after an authorized
//      reply persists across the same surfaces, the raw bearer material must
//      not appear in ContextGrant rows, ActivityLog, or PmChannelStreamEvent
//      payloads.

function sha256(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const SHARED_BEARER = "shared-bearer-leak-AAAAAAAAAAAAAAAA";
const PER_AGENT_BEARER = "per-agent-bearer-leak-BBBBBBBBBBBBBBBB";
const LEAK_AGENT = "leakroute";
process.env.PM_OPENCLAW_CHANNEL_TOKEN = SHARED_BEARER;
process.env[`PM_OPENCLAW_CHANNEL_TOKEN_${LEAK_AGENT.toUpperCase()}`] = PER_AGENT_BEARER;

async function assertBearerNeverPersisted(bearer: string, label: string) {
  const grantLeak = await db.contextGrant.findFirst({
    where: { tokenHash: { contains: bearer } },
    select: { id: true },
  });
  assert.equal(grantLeak, null, `${label} bearer leaked into a ContextGrant row`);

  const activityLeak = await db.activityLog.findFirst({
    where: { payload: { contains: bearer } },
    select: { id: true, kind: true },
  });
  assert.equal(activityLeak, null, `${label} bearer leaked into an ActivityLog payload`);

  const streamLeak = await db.pmChannelStreamEvent.findFirst({
    where: { payload: { contains: bearer } },
    select: { id: true, kind: true },
  });
  assert.equal(streamLeak, null, `${label} bearer leaked into a PmChannelStreamEvent payload`);
}

async function bearerLeakChecks() {
  await cleanupDirectAgent(LEAK_AGENT);
  const seeded = await seedDirectAgentMessage(LEAK_AGENT);
  try {
    // Drive an authorized reply with each bearer so the route persists across
    // ActivityLog + PmChannelStreamEvent (and, for the second, short-circuits
    // through the durable-reply path). Both must still leave no bearer behind.
    const shared = await callPmChannelReply({
      target: { kind: "direct", agentSlug: LEAK_AGENT, messageId: seeded.messageId },
      body: "shared bearer reply",
      bearer: SHARED_BEARER,
    });
    assert.equal(shared.status, 200, "shared-bearer reply must persist for the leak scan");
    // Repeat the same target with the per-agent bearer: it authorizes, then the
    // route exercises the duplicate path, persisting a done stream event.
    const perAgent = await callPmChannelReply({
      target: { kind: "direct", agentSlug: LEAK_AGENT, messageId: seeded.messageId },
      body: "per-agent bearer reply",
      bearer: PER_AGENT_BEARER,
    });
    assert.equal(
      (perAgent.json as { duplicate?: boolean; ok?: boolean }).ok,
      true,
      "per-agent-bearer reply must authorize at the route boundary",
    );

    await assertBearerNeverPersisted(SHARED_BEARER, "shared");
    await assertBearerNeverPersisted(PER_AGENT_BEARER, "per-agent");
  } finally {
    await cleanupDirectAgent(LEAK_AGENT);
  }
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

  await bearerLeakChecks();
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
