// Repair fragmented PM session bindings in an OpenClaw agent session store.
//
// Background: before ENV-86, the gateway recorded inbound PM route session keys
// verbatim, so PM sessions landed in the store under bare keys of the form
//   pm:<scopeType>:<scopeId>:agent:<agentSlug>[:turn:<id>]
// ENV-86 added canonicalization so new inbound PM keys are scoped under the
// route agent namespace:
//   agent:<agentId>:pm:<scopeType>:<scopeId>:agent:<agentSlug>[:turn:<id>]
// That left pre-cutover conversations stranded under the bare key while future
// turns resume under the canonical namespaced key — a fragmented binding.
//
// This tool reconciles a single store's `sessions.json` toward the canonical
// namespaced form, reusing the exact ENV-86 canonicalizer so the target key
// matches what the runtime now produces. It is dry-run by default; pass
// `--apply` to write (after a timestamped backup). It is idempotent: once a key
// is namespaced it is no longer a candidate, so a second run is a clean no-op.
//
// Safety: a bare key is only migrated when its canonical sibling does NOT
// already exist. If both the bare key and its namespaced sibling are present
// (each owns a distinct sessionId/transcript), the histories have diverged and
// the case is reported as a CONFLICT and skipped for manual review — never
// auto-merged.
//
// Usage:
//   tsx scripts/repair-pm-session-bindings.ts --store <path/to/sessions.json> [--agent-id <id>] [--apply] [--json]
//   tsx scripts/repair-pm-session-bindings.ts --store ~/.openclaw/agents/main/sessions/sessions.json
//   tsx scripts/repair-pm-session-bindings.ts --store ~/.openclaw/agents/main/sessions/sessions.json --apply

import fs from "node:fs";
import path from "node:path";
import { canonicalizePmStoreSessionKey } from "../openclaw-pm-channel/session-key.js";

export type SessionRecord = Record<string, unknown>;
export type SessionStore = Record<string, SessionRecord>;

export type Migration = { from: string; to: string };
export type Conflict = { bare: string; namespaced: string };

export type ReconciliationPlan = {
  totalKeys: number;
  barePmKeys: number;
  alreadyNamespaced: number;
  migrations: Migration[];
  conflicts: Conflict[];
};

// A bare PM key is one the runtime would canonicalize into the agent namespace,
// i.e. a `pm:` key not already scoped under `agent:<id>:`.
function isBarePmKey(key: string): boolean {
  return key.startsWith("pm:");
}

function isNamespacedPmKey(key: string): boolean {
  return /^agent:[^:]+:pm:/.test(key);
}

// Update the record's self-referential session key (reporting metadata) so a
// migrated record's embedded key matches its new store key. Only exact matches
// of the old key are rewritten; nothing else in the record is touched.
export function rekeyRecord(
  record: SessionRecord,
  from: string,
  to: string,
): SessionRecord {
  const next: SessionRecord = { ...record };
  if (next.sessionKey === from) next.sessionKey = to;
  const report = next.systemPromptReport;
  if (report && typeof report === "object") {
    const r = report as Record<string, unknown>;
    if (r.sessionKey === from) {
      next.systemPromptReport = { ...r, sessionKey: to };
    }
  }
  return next;
}

export function planReconciliation(
  store: SessionStore,
  agentId: string,
): ReconciliationPlan {
  const keys = Object.keys(store);
  const present = new Set(keys);
  const migrations: Migration[] = [];
  const conflicts: Conflict[] = [];
  let barePmKeys = 0;
  let alreadyNamespaced = 0;

  for (const key of keys) {
    if (isNamespacedPmKey(key)) {
      alreadyNamespaced++;
      continue;
    }
    if (!isBarePmKey(key)) continue;
    barePmKeys++;

    const canonical = canonicalizePmStoreSessionKey({
      agentId,
      requestKey: key,
    });
    // Defensive: canonicalizer should always namespace a bare pm: key.
    if (canonical === key) continue;

    if (present.has(canonical)) {
      conflicts.push({ bare: key, namespaced: canonical });
    } else {
      migrations.push({ from: key, to: canonical });
    }
  }

  return {
    totalKeys: keys.length,
    barePmKeys,
    alreadyNamespaced,
    migrations,
    conflicts,
  };
}

// Produce a new store with the plan's migrations applied. Conflicts are left
// untouched. The input store is not mutated.
export function applyPlan(
  store: SessionStore,
  plan: ReconciliationPlan,
): SessionStore {
  const next: SessionStore = { ...store };
  for (const { from, to } of plan.migrations) {
    if (!(from in next)) continue;
    if (to in next) continue; // sibling appeared; treat as conflict, skip
    next[to] = rekeyRecord(next[from], from, to);
    delete next[from];
  }
  return next;
}

// Infer the agent id from a store path of the shape
// `.../agents/<agentId>/sessions/sessions.json`. Returns null if not matched.
export function inferAgentIdFromStorePath(storePath: string): string | null {
  const parts = path.resolve(storePath).split(path.sep);
  const idx = parts.lastIndexOf("agents");
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  return null;
}

function backupSuffix(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

type CliArgs = {
  store?: string;
  agentId?: string;
  apply: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--json") args.json = true;
    else if (a === "--store") args.store = argv[++i];
    else if (a.startsWith("--store=")) args.store = a.slice("--store=".length);
    else if (a === "--agent-id") args.agentId = argv[++i];
    else if (a.startsWith("--agent-id="))
      args.agentId = a.slice("--agent-id=".length);
  }
  return args;
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.store) {
    console.error(
      "error: --store <path/to/sessions.json> is required\n" +
        "usage: tsx scripts/repair-pm-session-bindings.ts --store <path> [--agent-id <id>] [--apply] [--json]",
    );
    return 1;
  }
  const storePath = path.resolve(args.store);
  if (!fs.existsSync(storePath)) {
    console.error(`error: store not found: ${storePath}`);
    return 1;
  }
  const agentId = args.agentId ?? inferAgentIdFromStorePath(storePath);
  if (!agentId) {
    console.error(
      "error: could not infer agent id from store path; pass --agent-id <id>",
    );
    return 1;
  }

  const raw = fs.readFileSync(storePath, "utf8");
  let store: SessionStore;
  try {
    store = JSON.parse(raw) as SessionStore;
  } catch (err) {
    console.error(`error: store is not valid JSON: ${(err as Error).message}`);
    return 1;
  }

  const plan = planReconciliation(store, agentId);

  // In --json mode emit a single machine-readable object and nothing else.
  if (args.json) {
    let backupPath: string | null = null;
    if (args.apply && plan.migrations.length > 0) {
      backupPath = `${storePath}.bak-${backupSuffix()}`;
      fs.copyFileSync(storePath, backupPath);
      const next = applyPlan(store, plan);
      const tmpPath = `${storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fs.renameSync(tmpPath, storePath);
    }
    console.log(
      JSON.stringify(
        {
          agentId,
          storePath,
          applied: args.apply && plan.migrations.length > 0,
          backupPath,
          ...plan,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  {
    console.log(`store:        ${storePath}`);
    console.log(`agentId:      ${agentId}`);
    console.log(`total keys:   ${plan.totalKeys}`);
    console.log(`namespaced:   ${plan.alreadyNamespaced}`);
    console.log(`bare pm keys: ${plan.barePmKeys}`);
    console.log(`migrations:   ${plan.migrations.length}`);
    console.log(`conflicts:    ${plan.conflicts.length}`);
    for (const m of plan.migrations) console.log(`  migrate  ${m.from}  ->  ${m.to}`);
    for (const c of plan.conflicts)
      console.log(`  CONFLICT (skip, manual review)  ${c.bare}  ||  ${c.namespaced}`);
  }

  if (!args.apply) {
    console.log(
      plan.migrations.length > 0
        ? "\ndry-run: no changes written. Re-run with --apply to migrate."
        : "\ndry-run: nothing to migrate.",
    );
    return 0;
  }

  if (plan.migrations.length === 0) {
    console.log("\napply: nothing to migrate; store left unchanged.");
    return 0;
  }

  const backupPath = `${storePath}.bak-${backupSuffix()}`;
  fs.copyFileSync(storePath, backupPath);

  const next = applyPlan(store, plan);
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);

  console.log(`\napply: migrated ${plan.migrations.length} key(s).`);
  console.log(`backup: ${backupPath}`);
  if (plan.conflicts.length > 0) {
    console.log(
      `note: ${plan.conflicts.length} conflict(s) skipped for manual review.`,
    );
  }
  return 0;
}

// Run as CLI only when invoked directly (not when imported by the test).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /repair-pm-session-bindings(\.ts|\.js)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
