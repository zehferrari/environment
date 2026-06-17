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
// `--apply` to write (after timestamped backups). It is idempotent: once a key
// is namespaced it is no longer a candidate, so a second run is a clean no-op.
//
// A bare key falls into one of three classes:
//   * migration  — no canonical sibling exists; the record is simply re-keyed
//                  into the namespaced form (transcript pointer preserved).
//   * split-pair — a canonical sibling exists AND the two conversations do not
//                  overlap in time (one ended before the other began). These
//                  are the same logical thread split at the cutover. We merge
//                  them by concatenating the predecessor transcript ahead of
//                  the successor transcript into the canonical record's
//                  sessionFile (chronological order), preserving both
//                  histories, then drop the bare key. Reversible: the store and
//                  the rewritten transcript are backed up, and the predecessor
//                  transcript file is left on disk untouched.
//   * conflict   — a canonical sibling exists AND the timelines overlap (or
//                  timeline/sessionFile data is missing). The histories are
//                  genuinely divergent and cannot be safely auto-merged, so the
//                  pair is reported and skipped for manual review.
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

// A reconcilable split pair: the bare key and its canonical sibling are the same
// thread split at the cutover (non-overlapping timelines). `predecessorKey` is
// the earlier conversation, `successorKey` the later one. The merged transcript
// is written to `destFile` — always the canonical (namespaced) record's
// sessionFile — so the canonical key keeps resolving to one record.
export type SplitPair = {
  bare: string;
  namespaced: string;
  predecessorKey: string;
  successorKey: string;
  predFile: string;
  succFile: string;
  destFile: string;
};

export type ConflictReason =
  | "overlapping-timelines"
  | "insufficient-timeline-data"
  | "missing-session-file";

export type Conflict = {
  bare: string;
  namespaced: string;
  reason: ConflictReason;
};

export type ReconciliationPlan = {
  totalKeys: number;
  barePmKeys: number;
  alreadyNamespaced: number;
  migrations: Migration[];
  splitPairs: SplitPair[];
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

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Extract a conversation's [start, end] window from a session record. `start`
// is sessionStartedAt; `end` is the last activity, falling back through
// lastInteractionAt -> updatedAt -> start. Returns null if no start is known.
export function recordTimeline(
  rec: SessionRecord,
): { start: number; end: number } | null {
  const start = num(rec.sessionStartedAt);
  if (start === undefined) return null;
  const end = num(rec.lastInteractionAt) ?? num(rec.updatedAt) ?? start;
  return { start, end: Math.max(end, start) };
}

export type PairClassification =
  | {
      kind: "split";
      predecessorKey: string;
      predRec: SessionRecord;
      successorKey: string;
      succRec: SessionRecord;
    }
  | { kind: "conflict"; reason: ConflictReason };

// Decide whether a bare key and its existing canonical sibling are a safe split
// pair (same thread split at the cutover) or a divergent conflict. Pure: relies
// only on record metadata, reads no files.
export function classifyPair(
  bareKey: string,
  bareRec: SessionRecord,
  nsKey: string,
  nsRec: SessionRecord,
): PairClassification {
  const b = recordTimeline(bareRec);
  const n = recordTimeline(nsRec);
  if (!b || !n) return { kind: "conflict", reason: "insufficient-timeline-data" };
  if (!str(bareRec.sessionFile) || !str(nsRec.sessionFile)) {
    return { kind: "conflict", reason: "missing-session-file" };
  }

  const bareIsEarlier = b.start <= n.start;
  const pred = bareIsEarlier
    ? { key: bareKey, rec: bareRec, win: b }
    : { key: nsKey, rec: nsRec, win: n };
  const succ = bareIsEarlier
    ? { key: nsKey, rec: nsRec, win: n }
    : { key: bareKey, rec: bareRec, win: b };

  // Non-overlapping: the predecessor finished before the successor began. Only
  // then can we safely prepend predecessor history without interleaving.
  if (pred.win.end <= succ.win.start) {
    return {
      kind: "split",
      predecessorKey: pred.key,
      predRec: pred.rec,
      successorKey: succ.key,
      succRec: succ.rec,
    };
  }
  return { kind: "conflict", reason: "overlapping-timelines" };
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
  const splitPairs: SplitPair[] = [];
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

    if (!present.has(canonical)) {
      migrations.push({ from: key, to: canonical });
      continue;
    }

    const c = classifyPair(key, store[key], canonical, store[canonical]);
    if (c.kind === "conflict") {
      conflicts.push({ bare: key, namespaced: canonical, reason: c.reason });
      continue;
    }
    splitPairs.push({
      bare: key,
      namespaced: canonical,
      predecessorKey: c.predecessorKey,
      successorKey: c.successorKey,
      predFile: str(c.predRec.sessionFile) as string,
      succFile: str(c.succRec.sessionFile) as string,
      // Merged content always lands in the canonical record's transcript so the
      // canonical key keeps resolving to a single, complete session.
      destFile: str(store[canonical].sessionFile) as string,
    });
  }

  return {
    totalKeys: keys.length,
    barePmKeys,
    alreadyNamespaced,
    migrations,
    splitPairs,
    conflicts,
  };
}

// Produce a new store with the plan's migrations applied. Split pairs and
// conflicts are left untouched here (split pairs are applied on disk separately
// because they touch transcript files). The input store is not mutated.
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

function readJsonlLines(file: string): string[] {
  const raw = fs.readFileSync(file, "utf8");
  return raw.split("\n").filter((line) => line.length > 0);
}

// Merge two transcripts: predecessor lines precede successor lines. Because a
// split pair is non-overlapping by construction, simple concatenation yields a
// chronologically ordered transcript.
export function mergeTranscript(
  predLines: string[],
  succLines: string[],
): string[] {
  return [...predLines, ...succLines];
}

export type SplitPairResult = {
  merged: SplitPair[];
  skipped: { pair: SplitPair; reason: string }[];
};

// Apply split-pair merges, mutating `store` in place and rewriting transcript
// files on disk. For each pair: back up the destination transcript, write the
// chronologically merged transcript to it, fold predecessor metadata into the
// canonical record, and drop the bare key. The predecessor's own transcript
// file is never deleted, so the operation is reversible from the backups.
export function applySplitPairsOnDisk(
  store: SessionStore,
  splitPairs: SplitPair[],
  opts: { suffix: string; now?: number } = { suffix: backupSuffix() },
): SplitPairResult {
  const result: SplitPairResult = { merged: [], skipped: [] };
  const now = opts.now ?? Date.now();

  for (const sp of splitPairs) {
    if (!fs.existsSync(sp.predFile) || !fs.existsSync(sp.succFile)) {
      result.skipped.push({ pair: sp, reason: "transcript-file-missing" });
      continue;
    }
    const predLines = readJsonlLines(sp.predFile);
    const succLines = readJsonlLines(sp.succFile);
    const merged = mergeTranscript(predLines, succLines);

    // Back up the destination transcript before overwriting.
    const backupPath = `${sp.destFile}.bak-${opts.suffix}`;
    fs.copyFileSync(sp.destFile, backupPath);

    const tmpPath = `${sp.destFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${merged.join("\n")}\n`, "utf8");
    fs.renameSync(tmpPath, sp.destFile);

    // Fold predecessor/successor metadata into the surviving canonical record so
    // its window and cost roll-up reflect the merged transcript.
    const ns = store[sp.namespaced];
    const bareRec = store[sp.bare];
    if (ns && bareRec) {
      const a = recordTimeline(ns);
      const b = recordTimeline(bareRec);
      if (a && b) {
        ns.sessionStartedAt = Math.min(a.start, b.start);
        ns.lastInteractionAt = Math.max(a.end, b.end);
      }
      ns.updatedAt = now;
      for (const f of ["inputTokens", "outputTokens", "totalTokens"]) {
        const sum = (num(ns[f]) ?? 0) + (num(bareRec[f]) ?? 0);
        if (num(ns[f]) !== undefined || num(bareRec[f]) !== undefined) ns[f] = sum;
      }
    }
    delete store[sp.bare];
    result.merged.push(sp);
  }
  return result;
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
  const willWrite =
    args.apply && (plan.migrations.length > 0 || plan.splitPairs.length > 0);

  // In --json mode emit a single machine-readable object and nothing else.
  if (args.json) {
    let backupPath: string | null = null;
    let splitResult: SplitPairResult | null = null;
    if (willWrite) {
      const suffix = backupSuffix();
      backupPath = `${storePath}.bak-${suffix}`;
      fs.copyFileSync(storePath, backupPath);
      let next = applyPlan(store, plan);
      splitResult = applySplitPairsOnDisk(next, plan.splitPairs, { suffix });
      const tmpPath = `${storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fs.renameSync(tmpPath, storePath);
    }
    console.log(
      JSON.stringify(
        {
          agentId,
          storePath,
          applied: willWrite,
          backupPath,
          mergedSplitPairs: splitResult?.merged.length ?? 0,
          skippedSplitPairs: splitResult?.skipped ?? [],
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
    console.log(`split-pairs:  ${plan.splitPairs.length}`);
    console.log(`conflicts:    ${plan.conflicts.length} (skipped for manual review)`);
    for (const m of plan.migrations)
      console.log(`  migrate    ${m.from}  ->  ${m.to}`);
    for (const sp of plan.splitPairs)
      console.log(
        `  split-pair merge ${sp.predecessorKey}  +  ${sp.successorKey}  ->  ${sp.namespaced}`,
      );
    for (const c of plan.conflicts)
      console.log(
        `  CONFLICT (skip: ${c.reason})  ${c.bare}  ||  ${c.namespaced}`,
      );
  }

  if (!args.apply) {
    console.log(
      plan.migrations.length > 0 || plan.splitPairs.length > 0
        ? "\ndry-run: no changes written. Re-run with --apply to reconcile."
        : "\ndry-run: nothing to reconcile.",
    );
    return 0;
  }

  if (!willWrite) {
    console.log("\napply: nothing to reconcile; store left unchanged.");
    return 0;
  }

  const suffix = backupSuffix();
  const backupPath = `${storePath}.bak-${suffix}`;
  fs.copyFileSync(storePath, backupPath);

  let next = applyPlan(store, plan);
  const splitResult = applySplitPairsOnDisk(next, plan.splitPairs, { suffix });
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);

  console.log(
    `\napply: migrated ${plan.migrations.length} key(s); merged ${splitResult.merged.length} split-pair(s).`,
  );
  console.log(`backup: ${backupPath}`);
  for (const s of splitResult.skipped)
    console.log(`  split-pair skipped (${s.reason}): ${s.pair.namespaced}`);
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
