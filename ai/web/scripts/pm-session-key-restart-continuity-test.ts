import assert from "node:assert/strict";
import { buildPmOpenClawSessionKey } from "@/lib/agents/auth/session-bindings";
import { canonicalizePmStoreSessionKey } from "../openclaw-pm-channel/session-key.js";

// End-to-end regression coverage for PM route-key namespacing across a gateway
// restart / openclaw.json regeneration.
//
// The bug (pre-ENV-86): the web app emits a BARE PM session key
//   pm:<scope>:<id>:agent:<slug>            (buildPmOpenClawSessionKey)
// and the gateway PM inbound path recorded that key VERBATIM, so PM sessions
// lived outside the agent:<id>: namespace. ENV-86 inserts a canonicalizer on the
// inbound seam (openclaw-pm-channel/index.js: rawSessionKey -> canonicalize ->
// the agent-scoped key used for persistence, routing and dispatch).
//
// The gateway SDK that index.js imports is not present in the web app's
// node_modules, so runPmTurn cannot be driven in-process here. This test instead
// exercises the two REAL importable halves of the seam — the web-app key builder
// and the gateway canonicalizer — and models the one thing the inbound handler
// does between them: scope the bare key under the configured route agent id
// (channels.pm.agentId, default "main"). That is the exact line that regressed.
//
// "Restart / config regeneration" is modeled by re-deriving the persisted store
// key from a freshly-constructed config object (a new gateway boot reading a
// regenerated openclaw.json). Continuity holds iff the store key is identical
// across boots — which is what lets a second turn resume the first turn's
// session instead of forking a new one.

// Mirror of openclaw-pm-channel/index.js resolvePmAccount's agentId resolution.
// (resolvePmAccount itself isn't importable without the gateway SDK.) Kept tiny
// and colocated with the assertions that depend on it so drift is obvious.
function resolveRouteAgentId(cfg: any, accountId = "default"): string {
  const root = cfg?.channels?.pm ?? {};
  const account = accountId === "default" ? {} : root.accounts?.[accountId] ?? {};
  const merged = { ...root, ...account };
  return typeof merged.agentId === "string" && merged.agentId.trim()
    ? merged.agentId.trim()
    : "main";
}

// What the gateway PM inbound path persists for a turn: the bare web key scoped
// under the route agent id. This is the seam under test.
function persistedStoreKey(cfg: any, bareKey: string, accountId?: string): string {
  const agentId = resolveRouteAgentId(cfg, accountId);
  return canonicalizePmStoreSessionKey({ agentId, requestKey: bareKey });
}

type Scope = { scopeType: "direct" | "task" | "epic"; scopeId: string };
const agentSlug = "barekbaal";
const scopes: Scope[] = [
  { scopeType: "direct", scopeId: "asdrubal" },
  { scopeType: "task", scopeId: "cmqgp528a06545r03lj2cg61b" },
  { scopeType: "epic", scopeId: "cmqfxg2yn05j05ragqx8ump2k" },
];

// Two independent gateway boots reading config with the same channels.pm.agentId.
// `bootB` is a regenerated openclaw.json: re-serialized, key order changed, extra
// fields added — the same operative agentId, a genuinely different object.
const bootA = {
  channels: { pm: { enabled: true, agentId: "main", token: "t", callbackToken: "c" } },
};
const bootB = JSON.parse(
  JSON.stringify({
    channels: {
      pm: {
        callbackToken: "c2",
        token: "t2",
        agentId: "main",
        enabled: true,
        defaultTo: "pm:direct",
        accounts: {},
      },
    },
    session: { store: "~/.openclaw" },
  }),
);

for (const { scopeType, scopeId } of scopes) {
  const bareKey = buildPmOpenClawSessionKey({ scopeType, scopeId, agentSlug });
  const expected = `agent:main:pm:${scopeType}:${scopeId.toLowerCase()}:agent:${agentSlug}`;

  // Turn 1 (boot A) and turn 2 after a restart (boot B) must persist to the
  // SAME store key — this is the core regression: both turns land in one session.
  const keyTurn1 = persistedStoreKey(bootA, bareKey);
  const keyTurn2 = persistedStoreKey(bootB, bareKey);

  assert.equal(keyTurn1, expected, `${scopeType}: turn-1 persists under agent-scoped key`);
  assert.equal(
    keyTurn2,
    keyTurn1,
    `${scopeType}: turn-2 after restart/config-regen resumes the same session key`,
  );

  // Regression guard: the persisted key must NOT be the bare web key. The
  // pre-ENV-86 bug recorded the bare key verbatim, which has no agent:<id>:
  // prefix and would fork a separate session. This assertion fails on the bug.
  assert.notEqual(
    keyTurn1,
    bareKey,
    `${scopeType}: bare web key is canonicalized, not recorded verbatim`,
  );
  assert.ok(
    keyTurn1.startsWith("agent:main:pm:"),
    `${scopeType}: persisted key is under the agent PM namespace`,
  );
}

// The store key is a pure function of (route agentId, bare web key): repeated
// boots with the same config are perfectly stable, so any number of restarts
// keep resolving one session.
{
  const bareKey = buildPmOpenClawSessionKey({
    scopeType: "direct",
    scopeId: "asdrubal",
    agentSlug,
  });
  const keys = new Set(
    Array.from({ length: 5 }, () => persistedStoreKey(bootA, bareKey)),
  );
  assert.equal(keys.size, 1, "repeated boots with the same config yield one stable key");
}

// Continuity hazard documented for the rollout notes: if a regenerated
// openclaw.json CHANGES channels.pm.agentId, the persisted key re-homes to the
// new namespace and the prior session no longer resumes. Operators must keep
// channels.pm.agentId stable across config regeneration (or run the reconciler).
{
  const bareKey = buildPmOpenClawSessionKey({
    scopeType: "direct",
    scopeId: "asdrubal",
    agentSlug,
  });
  const renamed = {
    channels: { pm: { enabled: true, agentId: "asdrubal", token: "t", callbackToken: "c" } },
  };
  assert.equal(
    persistedStoreKey(renamed, bareKey),
    `agent:asdrubal:pm:direct:asdrubal:agent:${agentSlug}`,
    "changing channels.pm.agentId re-homes the session (continuity hazard)",
  );
  assert.notEqual(
    persistedStoreKey(renamed, bareKey),
    persistedStoreKey(bootA, bareKey),
    "a changed route agentId breaks continuity with the prior namespace",
  );
}

// Per-account override: a turn routed through a named PM account uses that
// account's agentId, and is stable across restart under that account's namespace.
{
  const cfg = {
    channels: {
      pm: {
        enabled: true,
        agentId: "main",
        accounts: { ops: { agentId: "asdrubal" } },
      },
    },
  };
  const bareKey = buildPmOpenClawSessionKey({
    scopeType: "task",
    scopeId: "T-1",
    agentSlug,
  });
  assert.equal(
    persistedStoreKey(cfg, bareKey, "ops"),
    `agent:asdrubal:pm:task:t-1:agent:${agentSlug}`,
    "named account routes under its own agentId namespace",
  );
  assert.equal(
    persistedStoreKey(cfg, bareKey, "default"),
    `agent:main:pm:task:t-1:agent:${agentSlug}`,
    "default account routes under the root agentId namespace",
  );
}

console.log("pm session-key restart-continuity tests passed");
