import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { authorizePmChannelCallback } from "@/lib/agents/pm-channel/callback-auth";
import {
  pmChannelTargetHasDurableReply,
  pmChannelRunTargetKey,
} from "@/lib/agents/pm-channel/runs";
import {
  callPmChannelReply,
  seedDirectAgentMessage,
  addDirectMessage,
  cleanupDirectAgent,
} from "./lib/pm-channel-reply-route-fixture";

const SHARED = "shared-callback-token-AAAAAAAAAAAAAAAA";
const PER_AGENT = "per-agent-token-BBBBBBBBBBBBBBBBBBBB";

// Configure the route's expected bearers before exercising the boundary:
// PM_OPENCLAW_CHANNEL_TOKEN is the shared bearer; the per-agent env key feeds
// resolvePmChannelToken so the per-agent acceptance path is distinct.
const ROUTE_AGENT = "cbroute";
process.env.PM_OPENCLAW_CHANNEL_TOKEN = SHARED;
process.env[`PM_OPENCLAW_CHANNEL_TOKEN_${ROUTE_AGENT.toUpperCase()}`] = PER_AGENT;

// --- Callback bearer auth gate (reply route 401 surface) ---------------------

// Missing/empty bearer is always rejected.
assert.equal(
  authorizePmChannelCallback({ presented: "", expectedShared: SHARED, expectedAgent: PER_AGENT }),
  false,
  "empty bearer must be rejected",
);

// Wrong bearer is rejected.
assert.equal(
  authorizePmChannelCallback({ presented: "totally-wrong", expectedShared: SHARED, expectedAgent: PER_AGENT }),
  false,
  "wrong bearer must be rejected",
);

// A prefix of the real token (length mismatch) is rejected by timing-safe compare.
assert.equal(
  authorizePmChannelCallback({ presented: SHARED.slice(0, -1), expectedShared: SHARED, expectedAgent: PER_AGENT }),
  false,
  "length-mismatched bearer must be rejected",
);

// Correct shared token authorizes.
assert.equal(
  authorizePmChannelCallback({ presented: SHARED, expectedShared: SHARED, expectedAgent: PER_AGENT }),
  true,
  "shared token must authorize",
);

// Correct per-agent token authorizes even when shared is configured.
assert.equal(
  authorizePmChannelCallback({ presented: PER_AGENT, expectedShared: SHARED, expectedAgent: PER_AGENT }),
  true,
  "per-agent token must authorize",
);

// Per-agent token must not authorize when no per-agent secret is configured.
assert.equal(
  authorizePmChannelCallback({ presented: PER_AGENT, expectedShared: SHARED, expectedAgent: null }),
  false,
  "unknown per-agent token must be rejected when no per-agent secret exists",
);

// --- Final-callback idempotency gate (no second visible reply) ---------------
// The reply route short-circuits to { duplicate: true } when a durable reply
// already exists for the target, so a repeated final callback never produces a
// second AgentChatMessage/Comment. Exercise that gate directly.

// --- Route-boundary bearer gate (POST /api/openclaw/pm-channel/reply) --------
// The direct-helper assertions above prove the predicate; this proves the route
// itself returns 401 on missing/wrong bearer and 200 on the correct shared and
// per-agent bearers, by invoking the real handler at the HTTP boundary.

async function routeBoundaryTests() {
  await cleanupDirectAgent(ROUTE_AGENT);
  const seeded = await seedDirectAgentMessage(ROUTE_AGENT);
  const secondMessageId = await addDirectMessage(ROUTE_AGENT, seeded.ownerUserId);
  const target = { kind: "direct", agentSlug: ROUTE_AGENT, messageId: seeded.messageId };

  try {
    // Missing bearer => 401 at the route boundary.
    const missing = await callPmChannelReply({ target, body: "reply", bearer: null });
    assert.equal(missing.status, 401, "route must reject a missing bearer with 401");

    // Wrong bearer => 401.
    const wrong = await callPmChannelReply({ target, body: "reply", bearer: "totally-wrong" });
    assert.equal(wrong.status, 401, "route must reject a wrong bearer with 401");

    // Correct shared bearer => 200, and a reply is actually persisted.
    const shared = await callPmChannelReply({ target, body: "shared reply", bearer: SHARED });
    assert.equal(shared.status, 200, "route must accept the shared bearer with 200");
    assert.equal(
      (shared.json as { ok?: boolean }).ok,
      true,
      "shared-bearer route call must persist a reply",
    );

    // Correct per-agent bearer => 200 on a fresh target (a second message id so
    // the durable-reply idempotency gate does not short-circuit it).
    const perAgentTarget = { kind: "direct", agentSlug: ROUTE_AGENT, messageId: secondMessageId };
    const perAgent = await callPmChannelReply({
      target: perAgentTarget,
      body: "per-agent reply",
      bearer: PER_AGENT,
    });
    assert.equal(perAgent.status, 200, "route must accept the per-agent bearer with 200");
    assert.equal(
      (perAgent.json as { ok?: boolean }).ok,
      true,
      "per-agent-bearer route call must persist a reply",
    );
  } finally {
    await cleanupDirectAgent(ROUTE_AGENT);
  }
}

async function main() {
  await routeBoundaryTests();

  const nonce = `cbauth-${Date.now()}`;
  const target = {
    kind: "direct" as const,
    agentSlug: "asdrubal",
    messageId: nonce,
  };

  await db.activityLog.deleteMany({
    where: { targetAgent: "asdrubal", payload: { contains: `"inReplyToMessageId":"${nonce}"` } },
  });

  // Before any reply is recorded the gate is open (callback would persist).
  assert.equal(
    await pmChannelTargetHasDurableReply(target),
    false,
    "fresh target must not report a durable reply",
  );

  // Simulate the first successful reply persisting its audit row.
  await db.activityLog.create({
    data: {
      kind: "agent.direct_chat.reply",
      targetAgent: "asdrubal",
      payload: JSON.stringify({
        driver: "openclaw-pm-channel",
        inReplyToMessageId: nonce,
        agentSlug: "asdrubal",
      }),
    },
  });

  // Now a second identical final callback must see the durable reply and skip.
  assert.equal(
    await pmChannelTargetHasDurableReply(target),
    true,
    "second callback must detect the durable reply and short-circuit",
  );

  // A silent reply for the same message also counts as durable (no re-entry).
  const silentNonce = `${nonce}-silent`;
  const silentTarget = { kind: "direct" as const, agentSlug: "asdrubal", messageId: silentNonce };
  await db.activityLog.create({
    data: {
      kind: "agent.direct_chat.silent",
      targetAgent: "asdrubal",
      payload: JSON.stringify({
        driver: "openclaw-pm-channel",
        inReplyToMessageId: silentNonce,
        agentSlug: "asdrubal",
        reason: "no_new_information",
      }),
    },
  });
  assert.equal(
    await pmChannelTargetHasDurableReply(silentTarget),
    true,
    "a recorded silent reply must also short-circuit duplicate callbacks",
  );

  // An unrelated message id is unaffected (gate is keyed on inReplyToMessageId).
  assert.equal(
    await pmChannelTargetHasDurableReply({ kind: "direct", agentSlug: "asdrubal", messageId: `${nonce}-other` }),
    false,
    "durable-reply gate must be scoped per message id",
  );

  // Target key shape sanity (used to key the run/idempotency lookups).
  assert.equal(pmChannelRunTargetKey(target), `direct:asdrubal:${nonce}`);

  await db.activityLog.deleteMany({
    where: { targetAgent: "asdrubal", payload: { contains: `"inReplyToMessageId":"${nonce}"` } },
  });
  await db.activityLog.deleteMany({
    where: { targetAgent: "asdrubal", payload: { contains: `"inReplyToMessageId":"${silentNonce}"` } },
  });
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log("pm channel callback auth + idempotency tests passed");
  })
  .catch(async (err) => {
    await db.$disconnect();
    console.error(err);
    process.exit(1);
  });
