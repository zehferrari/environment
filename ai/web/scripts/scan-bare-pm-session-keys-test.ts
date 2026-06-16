import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isBarePmKey,
  isNamespacedPmKey,
  parseCutover,
  recordCreatedAt,
  scanStore,
  type SessionStore,
} from "./scan-bare-pm-session-keys.js";

// --- key classification ----------------------------------------------------
assert.ok(isBarePmKey("pm:direct:asdrubal:agent:barekbaal"), "bare pm key detected");
assert.ok(!isBarePmKey("agent:main:pm:direct:x:agent:y"), "namespaced key is not bare");
assert.ok(!isBarePmKey("legacy-room"), "non-pm key is not bare");
assert.ok(isNamespacedPmKey("agent:main:pm:direct:x:agent:y"), "namespaced pm key detected");
assert.ok(!isNamespacedPmKey("pm:direct:x:agent:y"), "bare pm key is not namespaced");

// --- creation time fallback ------------------------------------------------
assert.equal(recordCreatedAt({ sessionStartedAt: 100, updatedAt: 200 }), 100, "prefers sessionStartedAt");
assert.equal(recordCreatedAt({ updatedAt: 200 }), 200, "falls back to updatedAt");
assert.equal(recordCreatedAt({}), undefined, "undatable when neither present");

// --- cutover parsing -------------------------------------------------------
assert.equal(parseCutover("1718582400000"), 1718582400000, "epoch ms parsed");
assert.equal(parseCutover("2026-06-17T00:00:00Z"), Date.parse("2026-06-17T00:00:00Z"), "ISO parsed");
assert.throws(() => parseCutover("not-a-date"), "invalid cutover throws");

// --- scan bucketing --------------------------------------------------------
const cutover = Date.parse("2026-06-17T00:00:00Z");
const store: SessionStore = {
  // namespaced keys are never offenders, regardless of time
  "agent:main:pm:direct:asdrubal:agent:barekbaal": { sessionStartedAt: cutover + 5000 },
  // bare key created BEFORE cutover -> reconciler's job, not a failure
  "pm:direct:old:agent:barekbaal": { sessionStartedAt: cutover - 10000 },
  // bare key created AT/AFTER cutover -> regression offender
  "pm:task:new:agent:barekbaal": { sessionStartedAt: cutover + 1 },
  // bare key with no timestamp -> undatable
  "pm:epic:undated:agent:barekbaal": {},
  // unrelated non-pm key -> ignored entirely
  "agent:main:main": { sessionStartedAt: cutover + 9000 },
};

const result = scanStore(store, cutover);
assert.equal(result.totalKeys, 5, "counts all keys");
assert.equal(result.barePmKeys, 3, "counts only bare pm keys");
assert.equal(result.postCutover.length, 1, "one post-cutover offender");
assert.equal(result.postCutover[0].key, "pm:task:new:agent:barekbaal", "right offender flagged");
assert.equal(result.preCutover.length, 1, "one pre-cutover bare key");
assert.equal(result.undatable.length, 1, "one undatable bare key");

// A record exactly at the cutover is post-cutover (inclusive boundary).
assert.equal(
  scanStore({ "pm:direct:x:agent:y": { sessionStartedAt: cutover } }, cutover).postCutover.length,
  1,
  "cutover boundary is inclusive",
);

// A clean store (all namespaced) has no offenders.
assert.equal(
  scanStore(
    { "agent:main:pm:direct:x:agent:y": { sessionStartedAt: cutover + 1 } },
    cutover,
  ).postCutover.length,
  0,
  "fully namespaced store passes",
);

// --- CLI exit codes (the post-deploy gate contract) ------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-bare-pm-"));
const scriptPath = path.resolve(import.meta.dirname, "scan-bare-pm-session-keys.ts");
const tsx = path.resolve(import.meta.dirname, "../node_modules/.bin/tsx");

function runCli(storeObj: SessionStore, cutoverArg: string): { code: number; out: string } {
  const storeFile = path.join(tmpDir, `store-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(storeFile, JSON.stringify(storeObj));
  try {
    const out = execFileSync(
      tsx,
      [scriptPath, "--store", storeFile, "--cutover", cutoverArg, "--json"],
      { encoding: "utf8" },
    );
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? -1, out: String(err.stdout ?? "") };
  }
}

const cutoverIso = "2026-06-17T00:00:00Z";

// Dirty store -> exit 1 (fails the smoke check).
const dirty = runCli({ "pm:task:new:agent:barekbaal": { sessionStartedAt: cutover + 1 } }, cutoverIso);
assert.equal(dirty.code, 1, "post-cutover bare key exits 1");
assert.equal(JSON.parse(dirty.out).failed, true, "json reports failed=true");

// Clean store -> exit 0.
const clean = runCli(
  { "agent:main:pm:direct:x:agent:y": { sessionStartedAt: cutover + 1 } },
  cutoverIso,
);
assert.equal(clean.code, 0, "clean store exits 0");
assert.equal(JSON.parse(clean.out).failed, false, "json reports failed=false");

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("scan-bare-pm-session-keys tests passed");
