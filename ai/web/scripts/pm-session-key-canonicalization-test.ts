import assert from "node:assert/strict";
import { canonicalizePmStoreSessionKey } from "../openclaw-pm-channel/session-key.js";

// PM keys produced by buildPmOpenClawSessionKey (lib/agents/auth/session-bindings.ts):
//   pm:<scopeType>:<scopeId>:agent:<agentSlug>   where scopeType ∈ direct|task|epic
const directKey = "pm:direct:asdrubal:agent:barekbaal";
const taskKey = "pm:task:cmqgp5286064w5r03zpc89m9m:agent:barekbaal";
const epicKey = "pm:epic:cmqfxg2yn05j05ragqx8ump2k:agent:barekbaal";

// Inbound PM direct/task/epic keys are scoped under the runtime route agent id.
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: directKey }),
  "agent:main:pm:direct:asdrubal:agent:barekbaal",
  "direct PM key is scoped under agent:<id>",
);
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: taskKey }),
  "agent:main:pm:task:cmqgp5286064w5r03zpc89m9m:agent:barekbaal",
  "task PM key is scoped under agent:<id>",
);
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: epicKey }),
  "agent:main:pm:epic:cmqfxg2yn05j05ragqx8ump2k:agent:barekbaal",
  "epic PM key is scoped under agent:<id>",
);

// The scoping agent id is the runtime route agent id, not a fixed "main".
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "asdrubal", requestKey: directKey }),
  "agent:asdrubal:pm:direct:asdrubal:agent:barekbaal",
  "non-default route agent id is honored",
);

// Already agent-scoped keys are NOT double-prefixed (idempotent).
const scoped = "agent:main:pm:task:cmqgp5286064w5r03zpc89m9m:agent:barekbaal";
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: scoped }),
  scoped,
  "already-scoped key is returned unchanged",
);
for (const key of [directKey, taskKey, epicKey, scoped]) {
  const once = canonicalizePmStoreSessionKey({ agentId: "main", requestKey: key });
  const twice = canonicalizePmStoreSessionKey({ agentId: "main", requestKey: once });
  assert.equal(twice, once, `canonicalization is idempotent for ${key}`);
}

// A key already carrying a (different) agent scope is re-homed to that scope's
// id, never stacked behind a second agent: segment.
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: "agent:asdrubal:pm:direct:x:agent:y" }),
  "agent:asdrubal:pm:direct:x:agent:y",
  "existing agent scope is preserved, not double-prefixed",
);

// Bare / non-PM legacy keys are scoped but otherwise left intact (not rebuilt),
// so unrelated session paths keep their identity under the agent namespace.
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: "legacy-room-123" }),
  "agent:main:legacy-room-123",
  "bare legacy key is scoped without reshaping",
);

// The "main"/empty sentinels resolve to the agent main session key.
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: "main" }),
  "agent:main:main",
  "'main' resolves to the agent main key",
);
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: "" }),
  "agent:main:main",
  "empty key resolves to the agent main key",
);
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "main", requestKey: undefined }),
  "agent:main:main",
  "missing key resolves to the agent main key",
);

// Route agent id is normalized (lowercased / sanitized) to a valid id.
assert.equal(
  canonicalizePmStoreSessionKey({ agentId: "Main", requestKey: directKey }),
  "agent:main:pm:direct:asdrubal:agent:barekbaal",
  "route agent id is normalized to lowercase",
);

console.log("pm session-key canonicalization tests passed");
