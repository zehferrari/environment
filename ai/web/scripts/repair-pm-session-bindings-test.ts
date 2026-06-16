import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planReconciliation,
  applyPlan,
  applySplitPairsOnDisk,
  classifyPair,
  mergeTranscript,
  rekeyRecord,
  inferAgentIdFromStorePath,
  type SessionStore,
} from "./repair-pm-session-bindings.ts";

function makeRecord(
  sessionKey: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: `id-${sessionKey}`,
    sessionKey,
    systemPromptReport: { sessionKey, provider: "claude-cli" },
    ...extra,
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
  assert.equal(plan.splitPairs.length, 0);
  assert.equal(plan.migrations.length, 3);
  const targets = plan.migrations.map((m) => m.to).sort();
  assert.deepEqual(targets, [
    "agent:main:pm:epic:e1:agent:barekbaal",
    "agent:main:pm:task:t1:agent:barekbaal",
    "agent:main:pm:task:t1:agent:barekbaal:turn:x1",
  ]);
}

// --- classifyPair: non-overlapping timelines = split pair (predecessor first) ---
{
  // bare ran 100..200, namespaced sibling started at 300 -> bare is predecessor.
  const bare = makeRecord("pm:task:t1:agent:barekbaal", {
    sessionStartedAt: 100,
    lastInteractionAt: 200,
    sessionFile: "/x/bare.jsonl",
  });
  const ns = makeRecord("agent:main:pm:task:t1:agent:barekbaal", {
    sessionStartedAt: 300,
    lastInteractionAt: 400,
    sessionFile: "/x/ns.jsonl",
  });
  const c = classifyPair(
    "pm:task:t1:agent:barekbaal",
    bare,
    "agent:main:pm:task:t1:agent:barekbaal",
    ns,
  );
  assert.equal(c.kind, "split");
  if (c.kind === "split") {
    assert.equal(c.predecessorKey, "pm:task:t1:agent:barekbaal");
    assert.equal(c.successorKey, "agent:main:pm:task:t1:agent:barekbaal");
  }
}

// --- classifyPair: overlapping timelines = divergent conflict ---
{
  const bare = makeRecord("pm:task:t1:agent:barekbaal", {
    sessionStartedAt: 100,
    lastInteractionAt: 350,
    sessionFile: "/x/bare.jsonl",
  });
  const ns = makeRecord("agent:main:pm:task:t1:agent:barekbaal", {
    sessionStartedAt: 300,
    lastInteractionAt: 400,
    sessionFile: "/x/ns.jsonl",
  });
  const c = classifyPair(
    "pm:task:t1:agent:barekbaal",
    bare,
    "agent:main:pm:task:t1:agent:barekbaal",
    ns,
  );
  assert.equal(c.kind, "conflict");
  if (c.kind === "conflict") assert.equal(c.reason, "overlapping-timelines");
}

// --- classifyPair: missing timeline data = conflict (skipped) ---
{
  const c = classifyPair(
    "pm:task:t1:agent:barekbaal",
    makeRecord("pm:task:t1:agent:barekbaal"),
    "agent:main:pm:task:t1:agent:barekbaal",
    makeRecord("agent:main:pm:task:t1:agent:barekbaal"),
  );
  assert.equal(c.kind, "conflict");
  if (c.kind === "conflict") assert.equal(c.reason, "insufficient-timeline-data");
}

// --- planReconciliation: split pair vs conflict are reported distinctly ---
{
  const store: SessionStore = {
    // split: bare predecessor (1..2), ns successor (3..4)
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal", {
      sessionStartedAt: 1,
      lastInteractionAt: 2,
      sessionFile: "/x/t1-bare.jsonl",
    }),
    "agent:main:pm:task:t1:agent:barekbaal": makeRecord(
      "agent:main:pm:task:t1:agent:barekbaal",
      { sessionStartedAt: 3, lastInteractionAt: 4, sessionFile: "/x/t1-ns.jsonl" },
    ),
    // conflict: overlapping
    "pm:task:t2:agent:barekbaal": makeRecord("pm:task:t2:agent:barekbaal", {
      sessionStartedAt: 10,
      lastInteractionAt: 30,
      sessionFile: "/x/t2-bare.jsonl",
    }),
    "agent:main:pm:task:t2:agent:barekbaal": makeRecord(
      "agent:main:pm:task:t2:agent:barekbaal",
      {
        sessionStartedAt: 20,
        lastInteractionAt: 40,
        sessionFile: "/x/t2-ns.jsonl",
      },
    ),
  };
  const plan = planReconciliation(store, "main");
  assert.equal(plan.migrations.length, 0);
  assert.equal(plan.splitPairs.length, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.splitPairs[0].namespaced, "agent:main:pm:task:t1:agent:barekbaal");
  assert.equal(plan.splitPairs[0].destFile, "/x/t1-ns.jsonl");
  assert.equal(plan.conflicts[0].bare, "pm:task:t2:agent:barekbaal");
  assert.equal(plan.conflicts[0].reason, "overlapping-timelines");
}

// --- mergeTranscript: predecessor lines precede successor lines ---
{
  assert.deepEqual(mergeTranscript(["a", "b"], ["c", "d"]), ["a", "b", "c", "d"]);
}

// --- applyPlan: migrates, rekeys, does not mutate input ---
{
  const store: SessionStore = {
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal"),
  };
  const plan = planReconciliation(store, "main");
  const next = applyPlan(store, plan);
  assert.ok("pm:task:t1:agent:barekbaal" in store); // input untouched
  assert.ok(!("pm:task:t1:agent:barekbaal" in next));
  const migrated = next["agent:main:pm:task:t1:agent:barekbaal"];
  assert.ok(migrated);
  assert.equal(migrated.sessionKey, "agent:main:pm:task:t1:agent:barekbaal");
  assert.equal(
    (migrated.systemPromptReport as Record<string, unknown>).sessionKey,
    "agent:main:pm:task:t1:agent:barekbaal",
  );
  assert.equal(migrated.sessionId, "id-pm:task:t1:agent:barekbaal");
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

// --- on-disk split-pair merge: merged transcript, backup, bare key dropped ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-repair-"));
  const bareFile = path.join(dir, "bare.jsonl");
  const nsFile = path.join(dir, "ns.jsonl");
  fs.writeFileSync(bareFile, '{"t":1}\n{"t":2}\n');
  fs.writeFileSync(nsFile, '{"t":3}\n{"t":4}\n');

  const store: SessionStore = {
    "pm:task:t1:agent:barekbaal": makeRecord("pm:task:t1:agent:barekbaal", {
      sessionStartedAt: 1,
      lastInteractionAt: 2,
      sessionFile: bareFile,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }),
    "agent:main:pm:task:t1:agent:barekbaal": makeRecord(
      "agent:main:pm:task:t1:agent:barekbaal",
      {
        sessionStartedAt: 3,
        lastInteractionAt: 4,
        sessionFile: nsFile,
        inputTokens: 20,
        outputTokens: 7,
        totalTokens: 27,
      },
    ),
  };
  const plan = planReconciliation(store, "main");
  assert.equal(plan.splitPairs.length, 1);

  const res = applySplitPairsOnDisk(store, plan.splitPairs, {
    suffix: "test",
    now: 9999,
  });
  assert.equal(res.merged.length, 1);
  assert.equal(res.skipped.length, 0);

  // Canonical transcript now holds predecessor then successor lines.
  assert.equal(fs.readFileSync(nsFile, "utf8"), '{"t":1}\n{"t":2}\n{"t":3}\n{"t":4}\n');
  // Backup of the destination transcript retains the pre-merge content.
  assert.equal(fs.readFileSync(`${nsFile}.bak-test`, "utf8"), '{"t":3}\n{"t":4}\n');
  // Predecessor transcript left intact on disk (reversible / no data loss).
  assert.equal(fs.readFileSync(bareFile, "utf8"), '{"t":1}\n{"t":2}\n');

  // Bare key dropped; canonical record metadata folds both sides in.
  assert.ok(!("pm:task:t1:agent:barekbaal" in store));
  const ns = store["agent:main:pm:task:t1:agent:barekbaal"];
  assert.equal(ns.sessionStartedAt, 1);
  assert.equal(ns.lastInteractionAt, 4);
  assert.equal(ns.updatedAt, 9999);
  assert.equal(ns.inputTokens, 30);
  assert.equal(ns.outputTokens, 12);
  assert.equal(ns.totalTokens, 42);

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- on-disk apply (migration): backup, atomic replace, re-run no-op ---
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

  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8")) as SessionStore;
  assert.ok("pm:task:t1:agent:barekbaal" in backup);

  const reloaded = JSON.parse(
    fs.readFileSync(storePath, "utf8"),
  ) as SessionStore;
  assert.ok("agent:main:pm:task:t1:agent:barekbaal" in reloaded);
  assert.equal(planReconciliation(reloaded, "main").migrations.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("repair-pm-session-bindings tests passed");
