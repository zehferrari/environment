import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { authorizePmChannelCallback } from "@/lib/agents/pm-channel-callback-auth";
import {
  pmChannelTargetHasDurableReply,
  pmChannelRunTargetKey,
} from "@/lib/agents/pm-channel-runs";

const SHARED = "shared-callback-token-AAAAAAAAAAAAAAAA";
const PER_AGENT = "per-agent-token-BBBBBBBBBBBBBBBBBBBB";

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

async function main() {
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
