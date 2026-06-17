// Post-deploy smoke check: scan an OpenClaw agent session store for bare PM
// session keys created AFTER a cutover timestamp.
//
// Background: before ENV-86, the gateway recorded inbound PM route session keys
// verbatim, so PM sessions landed under bare keys of the form
//   pm:<scopeType>:<scopeId>:agent:<agentSlug>[:turn:<id>]
// ENV-86 canonicalizes new inbound PM keys under the route agent namespace
//   agent:<agentId>:pm:<scopeType>:<scopeId>:agent:<agentSlug>[:turn:<id>]
// The ENV-87 reconciler repairs the historical bare keys once. This tool is the
// recurring rollout guard: it answers "are we STILL minting bare pm:* keys after
// the cutover?" — i.e. has the fix actually taken effect in this deployment.
//
// A bare pm:* record whose creation time is at/after the cutover means new PM
// turns are bypassing canonicalization (regression, or the fix is not deployed).
// The tool exits non-zero when any such key is found so it can gate a post-deploy
// smoke run; pre-cutover bare keys (the reconciler's job) are reported but do not
// fail the check.
//
// Usage:
//   tsx scripts/scan-bare-pm-session-keys.ts --store <path/to/sessions.json> --cutover <ISO8601|epochMs> [--json]
//   tsx scripts/scan-bare-pm-session-keys.ts --store ~/.openclaw/agents/main/sessions/sessions.json --cutover 2026-06-17T00:00:00Z

import fs from "node:fs";
import path from "node:path";

export type SessionRecord = Record<string, unknown>;
export type SessionStore = Record<string, SessionRecord>;

// A bare PM key is a `pm:` key not already scoped under `agent:<id>:`. Mirrors
// the reconciler's classification so this guard and the repair tool agree on
// what "bare" means.
export function isBarePmKey(key: string): boolean {
  return key.startsWith("pm:");
}

export function isNamespacedPmKey(key: string): boolean {
  return /^agent:[^:]+:pm:/.test(key);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Creation time of a session record: sessionStartedAt is authoritative; fall
// back to updatedAt so a record missing an explicit start is still datable.
// Returns undefined when neither is present (treated as undatable below).
export function recordCreatedAt(rec: SessionRecord): number | undefined {
  return num(rec.sessionStartedAt) ?? num(rec.updatedAt);
}

export type BareKeyFinding = {
  key: string;
  createdAt: number | undefined;
  postCutover: boolean;
};

export type ScanResult = {
  totalKeys: number;
  barePmKeys: number;
  postCutover: BareKeyFinding[];
  preCutover: BareKeyFinding[];
  undatable: BareKeyFinding[];
};

// Scan a parsed store for bare pm:* keys and bucket each by creation time vs the
// cutover. Pure: no IO. `cutoverMs` is epoch ms; a record at/after it is a
// post-cutover offender. Records with no datable creation time are reported
// separately (cannot be cleared, but should not silently pass).
export function scanStore(store: SessionStore, cutoverMs: number): ScanResult {
  const keys = Object.keys(store);
  const postCutover: BareKeyFinding[] = [];
  const preCutover: BareKeyFinding[] = [];
  const undatable: BareKeyFinding[] = [];
  let barePmKeys = 0;

  for (const key of keys) {
    if (isNamespacedPmKey(key) || !isBarePmKey(key)) continue;
    barePmKeys++;
    const createdAt = recordCreatedAt(store[key]);
    if (createdAt === undefined) {
      undatable.push({ key, createdAt, postCutover: false });
    } else if (createdAt >= cutoverMs) {
      postCutover.push({ key, createdAt, postCutover: true });
    } else {
      preCutover.push({ key, createdAt, postCutover: false });
    }
  }

  return {
    totalKeys: keys.length,
    barePmKeys,
    postCutover,
    preCutover,
    undatable,
  };
}

// Parse a cutover value: epoch ms (all digits) or any Date-parseable string.
export function parseCutover(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid --cutover value: ${value} (use ISO8601 or epoch ms)`);
  }
  return ms;
}

type CliArgs = { store?: string; cutover?: string; json: boolean };

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--store") args.store = argv[++i];
    else if (a.startsWith("--store=")) args.store = a.slice("--store=".length);
    else if (a === "--cutover") args.cutover = argv[++i];
    else if (a.startsWith("--cutover=")) args.cutover = a.slice("--cutover=".length);
  }
  return args;
}

function iso(ms: number | undefined): string {
  return ms === undefined ? "(no timestamp)" : new Date(ms).toISOString();
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.store) {
    console.error(
      "error: --store <path/to/sessions.json> is required\n" +
        "usage: tsx scripts/scan-bare-pm-session-keys.ts --store <path> --cutover <ISO8601|epochMs> [--json]",
    );
    return 2;
  }
  const storePath = path.resolve(args.store);
  if (!fs.existsSync(storePath)) {
    console.error(`error: store not found: ${storePath}`);
    return 2;
  }

  // Default cutover is epoch 0: with no cutover supplied every bare pm:* key is
  // treated as a post-cutover offender, so the check is conservative (fails loud)
  // rather than silently passing.
  const cutoverMs = args.cutover ? parseCutover(args.cutover) : 0;

  let store: SessionStore;
  try {
    store = JSON.parse(fs.readFileSync(storePath, "utf8")) as SessionStore;
  } catch (err) {
    console.error(`error: store is not valid JSON: ${(err as Error).message}`);
    return 2;
  }

  const result = scanStore(store, cutoverMs);
  const failed = result.postCutover.length > 0;

  if (args.json) {
    console.log(
      JSON.stringify(
        { storePath, cutover: iso(cutoverMs), failed, ...result },
        null,
        2,
      ),
    );
    return failed ? 1 : 0;
  }

  console.log(`store:            ${storePath}`);
  console.log(`cutover:          ${iso(cutoverMs)}`);
  console.log(`total keys:       ${result.totalKeys}`);
  console.log(`bare pm keys:     ${result.barePmKeys}`);
  console.log(`post-cutover:     ${result.postCutover.length} (FAIL if > 0)`);
  console.log(`pre-cutover:      ${result.preCutover.length} (reconciler's job)`);
  console.log(`undatable:        ${result.undatable.length}`);
  for (const f of result.postCutover)
    console.log(`  POST-CUTOVER  ${iso(f.createdAt)}  ${f.key}`);
  for (const f of result.undatable) console.log(`  UNDATABLE     ${f.key}`);

  if (failed) {
    console.log(
      `\nFAIL: ${result.postCutover.length} bare pm:* key(s) minted at/after cutover — ` +
        "PM canonicalization is not in effect for new turns.",
    );
  } else {
    console.log("\nOK: no bare pm:* keys created after cutover.");
  }
  return failed ? 1 : 0;
}

// Run as CLI only when invoked directly (not when imported by the test).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /scan-bare-pm-session-keys(\.ts|\.js)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
