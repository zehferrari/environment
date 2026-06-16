import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planReconciliation,
  applyPlan,
  rekeyRecord,
  inferAgentIdFromStorePath,
  type SessionStore,
} from "./repair-pm-session-bindings.ts";

function makeRecord(sessionKey: string): Record<string, unknown> {
  return {
    sessionId: `id-${sessionKey}`,
    sessionKey,
    systemPromptReport: { sessionKey, provider: "claude-cli" },
  };
}

// --- planReconciliation: bare-only keys are migrated to the namespaced form ---
{
  const store: SessionStore = {
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal"),
    "pm:task:t1:agent:barekbaal:turn:x1": makeRecord(
      "pm:task:t1:agent:barekbaal:turn:x1",
    ),
    "pm:epic:e1:agent:barekbaal": makeRecord("pm:epic:e1:agent:barekbaal"),
    "agent:main:pm:task:t9:agent:barekbaal": makeRecord(
      "agent:main:pm:task:t9:agent:barekbaal",
    ),
    "main": makeRecord("main"),
  };
  const plan = planReconciliation(store, "main");
  assert.equal(plan.totalKeys, 5);
  assert.equal(plan.alreadyNamespaced, 1);
  assert.equal(plan.barePmKeys, 3);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.migrations.length, 3);
  const targets = plan.migrations.map((m) => m.to).sort();
  assert.deepEqual(targets, [
    "agent:main:pm:epic:e1:agent:barekbaal",
    "agent:main:pm:task:t1:agent:barekbaal",
    "agent:main:pm:task:t1:agent:barekbaal:turn:x1",
  ]);
}

// --- planReconciliation: bare + existing namespaced sibling = conflict, skipped ---
{
  const store: SessionStore = {
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal"),
    "agent:main:pm:task:t1:agent:barekbaal": makeRecord(
      "agent:main:pm:task:t1:agent:barekbaal",
    ),
  };
  const plan = planReconciliation(store, "main");
  assert.equal(plan.migrations.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0], {
    bare: "pm:task:t1:agent:barekbaal",
    namespaced: "agent:main:pm:task:t1:agent:barekbaal",
  });
}

// --- applyPlan: migrates, rekeys, does not mutate input, leaves conflicts ---
{
  const store: SessionStore = {
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal"),
    "pm:task:t2:agent:barekbaal": makeRecord("pm:task:t2:agent:barekbaal"),
    "agent:main:pm:task:t2:agent:barekbaal": makeRecord(
      "agent:main:pm:task:t2:agent:barekbaal",
    ),
  };
  const plan = planReconciliation(store, "main");
  const next = applyPlan(store, plan);

  // Input untouched.
  assert.ok("pm:task:t1:agent:barekbaal" in store);

  // t1 migrated; bare key removed; record rekeyed.
  assert.ok(!("pm:task:t1:agent:barekbaal" in next));
  const migrated = next["agent:main:pm:task:t1:agent:barekbaal"];
  assert.ok(migrated);
  assert.equal(migrated.sessionKey, "agent:main:pm:task:t1:agent:barekbaal");
  assert.equal(
    (migrated.systemPromptReport as Record<string, unknown>).sessionKey,
    "agent:main:pm:task:t1:agent:barekbaal",
  );
  // Transcript pointer preserved.
  assert.equal(migrated.sessionId, "id-pm:task:t1:agent:barekbaal");

  // t2 conflict: both bare and namespaced still present, untouched.
  assert.ok("pm:task:t2:agent:barekbaal" in next);
  assert.ok("agent:main:pm:task:t2:agent:barekbaal" in next);
}

// --- idempotency: re-planning an applied store yields no migrations ---
{
  const store: SessionStore = {
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal"),
  };
  const plan = planReconciliation(store, "main");
  const next = applyPlan(store, plan);
  const replan = planReconciliation(next, "main");
  assert.equal(replan.migrations.length, 0);
  assert.equal(replan.barePmKeys, 0);
}

// --- rekeyRecord only rewrites exact-matching self keys ---
{
  const rec = rekeyRecord(
    { sessionKey: "a", systemPromptReport: { sessionKey: "a" }, other: "a" },
    "a",
    "b",
  );
  assert.equal(rec.sessionKey, "b");
  assert.equal((rec.systemPromptReport as Record<string, unknown>).sessionKey, "b");
  assert.equal(rec.other, "a");
}

// --- inferAgentIdFromStorePath ---
{
  assert.equal(
    inferAgentIdFromStorePath(
      "/home/u/.openclaw/agents/main/sessions/sessions.json",
    ),
    "main",
  );
  assert.equal(
    inferAgentIdFromStorePath(
      "/home/u/.openclaw/agents/google-workspace/sessions/sessions.json",
    ),
    "google-workspace",
  );
  assert.equal(inferAgentIdFromStorePath("/tmp/sessions.json"), null);
}

// --- on-disk apply: writes a backup, atomically replaces, re-run is a no-op ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-repair-"));
  const storePath = path.join(dir, "sessions.json");
  const original: SessionStore = {
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal"),
  };
  fs.writeFileSync(storePath, JSON.stringify(original, null, 2));

  const plan = planReconciliation(original, "main");
  const next = applyPlan(original, plan);
  const backupPath = `${storePath}.bak-test`;
  fs.copyFileSync(storePath, backupPath);
  fs.writeFileSync(storePath, `${JSON.stringify(next, null, 2)}\n`);

  // Backup retains the pre-migration bare key.
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8")) as SessionStore;
  assert.ok("pm:task:t1:agent:barekbaal" in backup);

  // Live store now namespaced; re-plan is a clean no-op.
  const reloaded = JSON.parse(
    fs.readFileSync(storePath, "utf8"),
  ) as SessionStore;
  assert.ok("agent:main:pm:task:t1:agent:barekbaal" in reloaded);
  assert.equal(planReconciliation(reloaded, "main").migrations.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("repair-pm-session-bindings tests passed");
