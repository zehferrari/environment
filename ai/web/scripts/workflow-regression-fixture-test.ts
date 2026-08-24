// ENV-124 Group B — the permanent regression fixture, replayed.
//
// The Epic requires the event sequence behind PH-116 ("9. Outage drill: prove
// the fail-soft contract (E6)") to become a permanent regression fixture. That
// sequence is real production history: 1237 rows spanning three weeks, a
// compaction failure that killed a turn mid-stream, thirteen blocker rounds,
// and a lease that sat unsettled for two and a half hours until a human noticed.
// scripts/fixtures/patricia-e6-outage-drill.json is that history, exported and
// redacted by scripts/export-pm-event-fixture.ts; this file replays it.
//
// The distinction that makes the suite worth having: it asserts what PM should
// do with that sequence NOW, not what PM did during the outage. Every case
// below states the historical shape (read out of the fixture, so it cannot
// rot) and then drives the CURRENT production writers and the real workflow
// route over the same rows. Where post-Epic behaviour genuinely differs from
// 2026-08-04, the case proves the difference. Where it does not, the case says
// so out loud with a `// FINDING:` note rather than asserting something vacuous.
//
// Structure:
//
//   E1  the fixture itself is intact and carries no secrets
//   E2  the sequence seeds into a throwaway database, row for row
//   E3  the outage turn: a compaction failure retires its poisoned episode
//   E4  the abandoned lease is now reaped by the watchdog, not by a human
//   E5  a blocker round is fail-soft: the task waits, it does not fail
//   E6  the invariant checker can see the outage shape in the replayed history
//
// The fixture is committed, so none of this needs database access — which is
// the whole point: the regression survives the database that produced it.
//
// Run: npx tsx scripts/workflow-regression-fixture-test.ts
// Exit 0 on success, non-zero on the first failed assertion.

import "./lib/next-als-polyfill";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  MINUTE_MS,
  bootScenarioDb,
  createScenarioReporter,
  createScenarioSandbox,
  dispatchWorkflowTurn,
  readRunState,
  readTaskProgress,
  type ScenarioCase,
  type ScenarioReporter,
  type ScenarioWorld,
} from "./lib/workflow-scenario-harness";

const SUITE = "workflow-regression-fixture";
const FIXTURE_PATH = path.join(process.cwd(), "scripts/fixtures/patricia-e6-outage-drill.json");

/** Pinned: a fixture written by a different exporter shape must not silently replay. */
const EXPECTED_EXPORT_SCHEMA_VERSION = 2;

const report: ScenarioReporter = createScenarioReporter(SUITE);

// ---------------------------------------------------------------------------
// Fixture types — the shape scripts/export-pm-event-fixture.ts emits.
// ---------------------------------------------------------------------------

type FixtureValue = string | number | boolean | null;
type FixtureRow = Record<string, FixtureValue>;

interface FixtureMeta {
  exportSchemaVersion: number;
  generator: string;
  sourceTaskId: string;
  sourceTaskKey: string | null;
  sourceTitle: string | null;
  sourceStatus: string | null;
  sourceProjectSlug: string | null;
  sourceEpicId: string | null;
  seedOrder: string[];
  skippedSections: string[];
  rowCounts: Record<string, number>;
  totalRows: number;
  datetimeColumns: Record<string, string[]>;
  tables: Record<string, string>;
  redaction: {
    placeholders: string[];
    allowlistedFields: string[];
    maxStringBySection: Record<string, number>;
    counts: {
      applied: Record<string, number>;
      emitted: Record<string, number>;
    };
  };
}

interface Fixture {
  meta: FixtureMeta;
  sections: Record<string, FixtureRow[]>;
}

// ---------------------------------------------------------------------------
// Fixture readers
//
// Everything the behaviour cases need is DERIVED from the fixture, never
// hard-coded. A re-export with different ids or a different outage instant
// keeps working; a re-export that lost the outage keeps failing.
// ---------------------------------------------------------------------------

/** Parse one activity row's JSON payload, or null if it has none. */
function activityPayload(row: FixtureRow): Record<string, unknown> | null {
  if (typeof row.payload !== "string") return null;
  try {
    return JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rowsOfKind(fixture: Fixture, kind: string): FixtureRow[] {
  return (fixture.sections.activity ?? []).filter((row) => row.kind === kind);
}

/**
 * The moment the outage happened: the `task.chat.stream_error` row PM wrote
 * when the agent's turn died. Everything in E3/E4 is anchored to it.
 */
function outageEvent(fixture: Fixture): { at: string; error: string; messageId: string } {
  const rows = rowsOfKind(fixture, "task.chat.stream_error");
  if (rows.length !== 1) {
    report.fail(`expected exactly one task.chat.stream_error in the fixture, found ${rows.length}`);
  }
  const payload = activityPayload(rows[0]);
  const target = payload?.target as { messageId?: string } | undefined;
  if (typeof payload?.error !== "string" || !target?.messageId) {
    report.fail("the fixture's stream_error row has no error text / target messageId");
  }
  return {
    at: String(rows[0].createdAt),
    error: payload.error as string,
    messageId: target.messageId as string,
  };
}

/**
 * The task's status at a given instant, folded out of the fixture's own
 * `task.move` trail.
 *
 * The fixture's Task row carries the FINAL state (Done). Replaying the outage
 * means rewinding to the state the task was actually in when the turn died,
 * and the audit trail is the only honest source for that.
 */
function statusAt(fixture: Fixture, instantIso: string): string {
  let status = "Backlog";
  for (const row of rowsOfKind(fixture, "task.move")) {
    if (String(row.createdAt) > instantIso) break;
    const payload = activityPayload(row);
    if (typeof payload?.to === "string") status = payload.to;
  }
  return status;
}

/** The permission-scoped blocker the fixture actually contains, if any. */
function permissionBlocker(fixture: Fixture): { scope: string } | null {
  for (const row of rowsOfKind(fixture, "task.blocker")) {
    const request = activityPayload(row)?.permissionRequest as
      | { kind?: string; scope?: string }
      | null
      | undefined;
    if (request?.kind === "reporter_approval" && typeof request.scope === "string") {
      return { scope: request.scope };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof bootScenarioDb>>["db"];

interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
}

/**
 * Introspect the SANDBOX schema.
 *
 * The fixture was exported from production, which is not necessarily on this
 * worktree's migration — the live database has no TaskExecutionEpisode table at
 * all. Columns are therefore intersected rather than assumed, and the drop list
 * is reported so a silently-narrowed replay is visible.
 */
async function targetColumns(db: Db, table: string): Promise<ColumnInfo[]> {
  return (await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`)) as ColumnInfo[];
}

/**
 * Single-column UNIQUE indexes on a table.
 *
 * Needed because redaction is lossy on purpose: `ContextGrant.tokenHash` is a
 * unique column whose every value the exporter (correctly) collapses to one
 * placeholder. Seventy-two identical placeholders violate the index, so the
 * replay re-scatters them deterministically — see `uniquifyRedactions`.
 */
async function uniqueColumns(db: Db, table: string): Promise<Set<string>> {
  const indexes = (await db.$queryRawUnsafe(`PRAGMA index_list("${table}")`)) as Array<{
    name: string;
    unique: number;
  }>;
  const unique = new Set<string>();
  for (const index of indexes) {
    if (!index.unique) continue;
    const columns = (await db.$queryRawUnsafe(`PRAGMA index_info("${index.name}")`)) as Array<{
      name: string;
    }>;
    if (columns.length === 1) unique.add(columns[0].name);
  }
  return unique;
}

/**
 * Give every redacted value in a UNIQUE column its own stable identity.
 *
 * `[redacted:token]` becomes `[redacted:token]#<row id>` — still obviously a
 * placeholder, still deterministic, and no longer a constraint violation. The
 * fixture is not edited: this is the replay compensating for information the
 * fixture deliberately does not have, exactly like the synthesised email below.
 */
function uniquifyRedactions(row: FixtureRow, unique: Set<string>): FixtureRow {
  const out: FixtureRow = { ...row };
  for (const column of unique) {
    const value = out[column];
    if (typeof value === "string" && value.startsWith("[redacted:")) {
      out[column] = `${value}#${String(row.id ?? column)}`;
    }
  }
  return out;
}

interface SeedOutcome {
  inserted: number;
  droppedColumns: string[];
}

/**
 * Insert one fixture section verbatim.
 *
 * Raw INSERT, deliberately: these rows are HISTORY, not behaviour. Replaying
 * them through the production writers would re-derive them from today's code
 * and destroy the very thing the fixture is preserving — what the rows looked
 * like on 2026-08-04. The production writers are driven in E3-E6, where the
 * suite is asserting behaviour rather than restoring a past.
 */
async function seedSection(
  db: Db,
  table: string,
  rows: FixtureRow[],
  datetimeColumns: string[],
  overrides: (row: FixtureRow) => FixtureRow = (row) => row,
): Promise<SeedOutcome> {
  if (rows.length === 0) return { inserted: 0, droppedColumns: [] };
  const info = await targetColumns(db, table);
  const known = new Set(info.map((column) => column.name));
  const unique = await uniqueColumns(db, table);
  const dropped = new Set<string>();

  let inserted = 0;
  for (const raw of rows) {
    const row = uniquifyRedactions(overrides(raw), unique);
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(row)) {
      if (!known.has(column)) {
        dropped.add(column);
        continue;
      }
      columns.push(column);
      // DATETIME round-trip: the exporter normalised epoch-ms to ISO for
      // reviewability, so the replay converts it straight back.
      values.push(
        datetimeColumns.includes(column) && typeof value === "string" ? Date.parse(value) : value,
      );
    }
    const placeholders = columns.map(() => "?").join(", ");
    const quoted = columns.map((column) => `"${column}"`).join(", ");
    await db.$executeRawUnsafe(
      `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`,
      ...values,
    );
    inserted += 1;
  }
  return { inserted, droppedColumns: [...dropped].sort() };
}

// ---------------------------------------------------------------------------
// Secret scanning — the same shapes the exporter redacts, re-checked here so a
// hand-edited fixture cannot reintroduce a credential.
// ---------------------------------------------------------------------------

const SECRET_SHAPES: Array<{ label: string; re: RegExp }> = [
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { label: "bearer header", re: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  {
    label: "vendor api key",
    re: /\b(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|AKIA|ASIA|glpat-|hf_)[A-Za-z0-9_-]{10,}/,
  },
  { label: "email address", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { label: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * The literal that got through the first export (ENV-124 review), pinned as a
 * SHA-256 digest rather than plaintext.
 *
 * Pinning it by value matters — this is the one string we KNOW a human
 * disclosed in a PM comment, so a regenerated fixture that reintroduces it must
 * fail by identity and not merely by a shape rule that could itself be
 * weakened. Writing the plaintext into this file to prove the plaintext is
 * absent from that one would be self-defeating, so the check hashes every token
 * in the fixture instead. Same guarantee, no secret in the repository.
 */
const KNOWN_DISCLOSED_CREDENTIAL_SHA256 =
  "cbc7e205eee75b6212f8087ea6887b765b439100f5661830aba11bdcb710ebf4";

/** Token boundaries a quoted credential can sit between in prose or JSON. */
const TOKEN_SPLIT = /[\s"'`\\,;()[\]{}<>]+/;

/**
 * Shapes that must not survive into any fixture, checked against the PARSED
 * leaf strings rather than the raw file. A raw-byte sweep misses every one of
 * these: in the committed JSON the disclosure reads `password to \"…\"`, and
 * the backslash breaks any regex anchored on a quote.
 */
const PROSE_SECRET_SHAPES: Array<{ label: string; re: RegExp }> = [
  {
    label: "quoted credential disclosure",
    re: /(?:pass(?:word|phrase|wd)|passcode|pwd|secret(?:[ _-]?key)?|api[ _-]?key|access[ _-]?key|credentials?|cvv|cvc)(?:\s*[:=]\s*|\s+(?:is|are|was|to|as|of|for|=>)\s+)(["'`])(?!\[redacted:)(?:(?!\1)[^\n\r]){1,128}\1/i,
  },
  {
    label: "assigned credential",
    re: /(?:pass(?:word|phrase|wd)|passcode|pwd|secret(?:[ _-]?key)?|api[ _-]?key|access[ _-]?key|cvv|cvc)\s*[:=]\s*(?!\[redacted:)[^\s"'`,;)\]}\\]{3,128}/i,
  },
  { label: "labelled card number", re: /(?:cc|card|pan|credit[ _-]?card)(?:\s*(?:number|no\.?|num|#))?\s*[:=]\s*(?:\d[ -]?){11,19}\d/i },
  {
    label: "gateway payment identifier",
    re: /(?:merchant[ _-]?id|acquirer[ _-]?id|receipt(?:[ _-]?(?:no|number|id))?|transaction[ _-]?(?:id|ref|reference)|payment[ _-]?(?:id|ref|reference))["'`]?\s*[:=]\s*["'`]?(?!\[redacted:)[A-Za-z0-9_-]{4,64}/i,
  },
  {
    // Six of these survived the first export: gateway receipts, order refs and
    // a live merchant id, all quoted as bare prose. Epoch timestamps are the
    // only long bare digit run the fixture legitimately needs.
    label: "bare payment digit run",
    re: /(?<![\d.])(?!1\d{12}(?![\d.])|1\d{15}(?![\d.])|1\d{18}(?![\d.]))\d{12,19}(?![\d.])/,
  },
];

const CARD_ISSUER_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5)|35)/;

function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Every string leaf in the fixture, including the ones nested in embedded JSON. */
function collectLeafStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectLeafStrings(JSON.parse(trimmed), out);
      } catch {
        // Not JSON. The plain string is already recorded.
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeafStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectLeafStrings(item, out);
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawFixture = await readFile(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(rawFixture) as Fixture;
  const meta = fixture.meta;

  // ------------------------------------------------------------------
  // E1 — the fixture is intact, self-consistent, and carries no secrets.
  //
  // A regression fixture that silently truncates is worse than no fixture:
  // every later case would replay a shortened history and pass. So the
  // fixture's own `meta` is treated as an assertion, not documentation —
  // counts, totals, declared sections and redaction placeholders all have to
  // agree with the bytes on disk before anything is seeded.
  // ------------------------------------------------------------------
  {
    const c: ScenarioCase = report.case("E1", "the committed fixture is intact and secret-free");

    c.assertEqual(
      meta.exportSchemaVersion,
      EXPECTED_EXPORT_SCHEMA_VERSION,
      "the fixture was written by the exporter shape this suite understands",
    );
    c.assertEqual(meta.generator, "scripts/export-pm-event-fixture.ts", "the generator is named");
    c.assert(meta.sourceTaskId, "the fixture names its source task");
    c.assertIncludes(meta.sourceTitle, "Outage drill", "the fixture is the Epic's outage drill task");
    c.assertEqual(meta.sourceTaskKey, "PH-116", "and it is PH-116 specifically");

    // Counts: every declared section exists, with exactly the declared rows.
    let summed = 0;
    for (const [section, expected] of Object.entries(meta.rowCounts)) {
      const rows = fixture.sections[section];
      c.assert(Array.isArray(rows), `meta declares section ${section} and the fixture carries it`);
      c.assertEqual(rows.length, expected, `section ${section} has its declared row count`);
      summed += rows.length;
    }
    c.assertEqual(summed, meta.totalRows, "the section rows sum to the declared total");
    c.assertEqual(
      Object.keys(fixture.sections).length,
      Object.keys(meta.rowCounts).length,
      "no section exists that meta does not declare",
    );
    for (const section of meta.seedOrder) {
      c.assert(section in fixture.sections, `seedOrder names a real section (${section})`);
    }

    // The trail actually has to contain the events the later cases replay.
    c.assert(meta.rowCounts.activity > 0, "the fixture carries the activity trail");
    c.assert(meta.rowCounts.pmChannelRuns > 0, "the fixture carries the run trail");
    c.assert(meta.rowCounts.pmChannelStreamEvents > 0, "the fixture carries the stream trail");
    c.assertEqual(
      rowsOfKind(fixture, "task.chat.stream_error").length,
      1,
      "the outage itself — the stream error that killed the turn — is in the fixture",
    );

    // Redaction: the emitted placeholder counts are exact, so a fixture that
    // was truncated (or had its placeholders edited out) fails here.
    const sectionsText = JSON.stringify(fixture.sections);
    const emitted = meta.redaction.counts.emitted;
    for (const [placeholder, expected] of Object.entries(emitted)) {
      const found = sectionsText.split(placeholder).length - 1;
      c.assertEqual(found, expected, `"${placeholder}" appears exactly as many times as meta declares`);
    }
    c.assert(
      (emitted["[redacted:token]"] ?? 0) > 0,
      "at least one credential-shaped field was actually redacted — the redactor ran",
    );
    for (const placeholder of meta.redaction.placeholders) {
      c.assert(
        placeholder in emitted,
        `every declared placeholder is accounted for in the emitted counts (${placeholder})`,
      );
    }
    c.assert(
      meta.redaction.counts.applied.byFieldName >= (emitted["[redacted:token]"] ?? 0),
      "the applied count is never smaller than what survived truncation",
    );

    // And an independent sweep of the raw bytes, not just the declared counts.
    for (const shape of SECRET_SHAPES) {
      const match = rawFixture.match(shape.re);
      c.assert(
        match === null,
        `the committed fixture contains no ${shape.label} (found ${JSON.stringify(match?.[0]?.slice(0, 24))})`,
      );
    }

    // ----------------------------------------------------------------
    // Free-text disclosure (ENV-124 review).
    //
    // The first export of this fixture shipped a plaintext password quoted in
    // a task comment. Nothing above catches it: the field is `body`, the value
    // is short and low-entropy, and in the committed JSON the quotes around it
    // are backslash-escaped, so the raw-byte sweep cannot even see the shape.
    // These assertions close that hole on both axes — the known literal by
    // name, the general forms by rule, over the PARSED leaves.
    // ----------------------------------------------------------------
    const leaves = collectLeafStrings(fixture.sections);
    const digested = new Set<string>();
    for (const leaf of leaves) {
      for (const token of leaf.split(TOKEN_SPLIT)) {
        if (token.length >= 6 && token.length <= 64) {
          digested.add(createHash("sha256").update(token).digest("hex"));
        }
      }
    }
    c.assert(
      !digested.has(KNOWN_DISCLOSED_CREDENTIAL_SHA256),
      "the credential a human disclosed in PH-116 is not present in the fixture (pinned by digest)",
    );
    c.assert(leaves.length > 1000, `the leaf sweep actually walked the fixture (${leaves.length} strings)`);
    for (const shape of PROSE_SECRET_SHAPES) {
      const offender = leaves.find((leaf) => shape.re.test(leaf));
      const excerpt = offender?.match(shape.re)?.[0]?.slice(0, 60);
      c.assert(
        offender === undefined,
        `no fixture string carries a ${shape.label} (found ${JSON.stringify(excerpt)})`,
      );
    }

    const survivingPan = leaves
      .flatMap((leaf) => [...leaf.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)].map((m) => m[0]))
      .map((match) => match.replace(/[ -]/g, ""))
      .find(
        (digits) =>
          digits.length >= 13 &&
          digits.length <= 19 &&
          CARD_ISSUER_PREFIX.test(digits) &&
          isLuhnValid(digits),
      );
    c.assert(
      survivingPan === undefined,
      `no payment card number survives into the fixture (found ${JSON.stringify(survivingPan)})`,
    );

    // The rules themselves, not just this file's bytes. A fixture regenerated
    // from a different task must be protected by the same guarantees, so the
    // exporter's redactor is asserted directly.
    const { redactFreeText, REDACTION_PLACEHOLDERS } = await import("./export-pm-event-fixture");
    const DISCLOSURES: Array<{ label: string; input: string; mustKeep?: string }> = [
      {
        // The shape of the disclosure that got through review, with a synthetic
        // value — the real one is pinned by digest above, not written here.
        label: "the disclosure shape that got through review",
        input: 'if required, reset the password to "Synth@1234"',
        mustKeep: "reset the password to",
      },
      { label: "single-quoted password", input: "the password is 'hunter2-correct-horse'" },
      { label: "backtick passphrase", input: "passphrase = `open sesame please`" },
      { label: "bare assignment", input: "password: s3cr3t-value-here" },
      { label: "api key assignment", input: "api_key=AbCdEf123456xyz" },
      { label: "secret key disclosure", input: 'secret key: "zzz-9910-aaa"' },
      { label: "cvv", input: "cvv: 1000" },
      { label: "labelled Luhn-invalid card", input: "card number : 5511 2233 4455 6677889" },
      { label: "bare Mastercard PAN", input: "charge went through on 5511223344556674 fine" },
      { label: "bare Amex PAN", input: "amex 370099887766552 declined" },
      { label: "quoted merchant id", input: '"merchantId":"909100292450927"' },
      { label: "prose receipt number", input: "FAILED / receipt 900122088851" },
    ];
    for (const disclosure of DISCLOSURES) {
      const cleaned = redactFreeText(disclosure.input);
      c.assert(
        cleaned !== disclosure.input && cleaned.includes("[redacted:"),
        `redactFreeText strips ${disclosure.label}`,
      );
      const secret = disclosure.input
        .replace(/^.*?(?:[:=]|\bis\b|\bto\b)\s*/s, "")
        .replace(/["'`]/g, "")
        .trim();
      c.assert(
        secret.length === 0 || !cleaned.includes(secret),
        `the value itself does not survive ${disclosure.label}`,
      );
      if (disclosure.mustKeep) {
        c.assertIncludes(cleaned, disclosure.mustKeep, `the sentence around ${disclosure.label} survives`);
      }
    }

    // The other direction: the redactor must not eat the trail. Prose that
    // merely discusses a password, and the identifiers replay depends on, are
    // left alone — an over-broad rule would quietly gut the fixture instead of
    // failing, which is the failure mode that is hard to notice later.
    const PRESERVED = [
      "the customer login page has empty username/password fields",
      "Username and password do not match or you do not have an account yet.",
      "agent:main:pm:task:cmrodriti007kovmhq8x6qqls:agent:asdrubal",
      "createdAt 2026-08-04T05:33:21.000Z run 1754285601000",
      "$s = $m->prepare(\"UPDATE {$p}users SET password=? WHERE id=$id\");",
    ];
    for (const preserved of PRESERVED) {
      c.assertEqual(redactFreeText(preserved), preserved, `redactFreeText leaves intact: ${preserved.slice(0, 48)}`);
    }

    c.assert(
      REDACTION_PLACEHOLDERS.credential === "[redacted:credential]" &&
        REDACTION_PLACEHOLDERS.card === "[redacted:card]",
      "the free-text placeholders are the stable strings meta declares",
    );
    c.assert(
      (emitted["[redacted:credential]"] ?? 0) > 0 && (emitted["[redacted:card]"] ?? 0) > 0,
      "the free-text redactor actually fired on this history — the hole it closes was real",
    );
  }

  const outage = outageEvent(fixture);
  const statusAtOutage = statusAt(fixture, outage.at);

  const sandbox = await createScenarioSandbox({
    name: SUITE,
    env: {
      // Two attempts makes the retry ladder's BOUND observable in E3 without
      // waiting out a production-length backoff.
      PM_CHANNEL_JOB_MAX_ATTEMPTS: "2",
      PM_CHANNEL_JOB_RETRY_BASE_MS: "1000",
      PM_WATCHDOG_MAX_RECOVERIES: "3",
    },
  });

  try {
    const boot = await bootScenarioDb();
    const { db, actionEffect } = boot;

    const { runWorkflowWatchdog } = await import("@/lib/agents/watchdog/run");
    const {
      claimNextPmChannelJob,
      isRetryablePmChannelTurnFailure,
      retryOrFailPmChannelJobForTurnFailure,
    } = await import("@/lib/agents/pm-channel/jobs");
    const { WORKFLOW_RUN_LEASE_TTL_MS } = await import("@/lib/workflow-invariants");
    const { checkWorkflowInvariants } = await import("@/lib/workflow-invariants-db");

    // ------------------------------------------------------------------
    // E2 — the sequence seeds into a throwaway database, row for row.
    //
    // Fidelity is the precondition for every case after this one. If the
    // replay quietly dropped the runs, E3 would still "pass" against an empty
    // trail. So the seed is read back out of the database and compared to the
    // fixture's declared counts, section by section.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("E2", "the exported event sequence seeds faithfully");

      // Foreign keys stay ON: a fixture that is not referentially closed is a
      // fixture that cannot be replayed, and that should fail loudly here
      // rather than surface as a confusing null three cases later.
      await db.$executeRawUnsafe("PRAGMA foreign_keys = ON");

      const dropped: Record<string, string[]> = {};
      for (const section of meta.seedOrder) {
        const rows = fixture.sections[section] ?? [];
        const table = meta.tables[section] ?? (section === "principals" ? "User" : "Agent");
        const outcome = await seedSection(
          db,
          table,
          rows,
          meta.datetimeColumns[section] ?? [],
          // The exporter never exports an email — that is PII and it is gone
          // for good. `User.email` is NOT NULL, so the replay synthesises a
          // deterministic non-routable address from the username. The fixture
          // being unable to supply one is exactly the property we want.
          table === "User"
            ? (row) => ({ ...row, email: `${String(row.username)}@example.invalid` })
            : undefined,
        );
        if (outcome.droppedColumns.length > 0) dropped[section] = outcome.droppedColumns;
        c.assertEqual(
          outcome.inserted,
          rows.length,
          `section ${section} seeded every row it declares`,
        );
      }

      // A dropped column means production carried a column this worktree's
      // schema no longer has. Harmless for most of the trail, fatal for the
      // rows the behaviour cases read.
      for (const critical of ["task", "pmChannelRuns", "activity"]) {
        c.assertEqual(
          (dropped[critical] ?? []).join(","),
          "",
          `no column was dropped from ${critical} while seeding`,
        );
      }

      // Read the trail back out through Prisma — the same reader production
      // uses — rather than trusting the insert count.
      const taskId = meta.sourceTaskId;
      c.assertEqual(await db.comment.count({ where: { taskId } }), meta.rowCounts.comments, "comments");
      c.assertEqual(
        await db.agentChatMessage.count({ where: { taskId } }),
        meta.rowCounts.agentChatMessages,
        "agent chat messages",
      );
      c.assertEqual(
        await db.activityLog.count({ where: { taskId } }),
        meta.rowCounts.activity,
        "activity rows",
      );
      c.assertEqual(await db.subTask.count({ where: { taskId } }), meta.rowCounts.subTasks, "checklist rows");
      c.assertEqual(
        await db.pmChannelRun.count({ where: { taskId } }),
        meta.rowCounts.pmChannelRuns,
        "channel runs",
      );
      c.assertEqual(
        await db.pmChannelStreamEvent.count({ where: { run: { taskId } } }),
        meta.rowCounts.pmChannelStreamEvents,
        "stream events",
      );

      const task = await db.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { title: true, workItemKey: true, status: true, epicId: true, projectId: true },
      });
      c.assertEqual(task.title, meta.sourceTitle, "the replayed task is the exported task");
      c.assertEqual(task.workItemKey, meta.sourceTaskKey, "and it kept its work item key");
      c.assertEqual(task.status, meta.sourceStatus, "seeded at its exported (final) status");
      c.assertEqual(task.epicId, meta.sourceEpicId, "under its Epic");
    }

    // The cast, derived from the seeded rows rather than restated here.
    const seededTask = await db.task.findUniqueOrThrow({
      where: { id: meta.sourceTaskId },
      select: { id: true, projectId: true, epicId: true, assigneeId: true, reporterId: true },
    });
    const assignee = await db.user.findUniqueOrThrow({
      where: { id: seededTask.assigneeId! },
      select: { id: true, agentId: true },
    });
    const assigneeAgent = await db.agent.findUniqueOrThrow({
      where: { id: assignee.agentId! },
      select: { id: true, slug: true },
    });
    const owner = await db.user.findFirstOrThrow({
      where: { isOwner: true },
      select: { id: true },
    });
    const world: ScenarioWorld = {
      agentSlug: assigneeAgent.slug,
      agentId: assigneeAgent.id,
      agentUserId: assignee.id,
      ownerId: owner.id,
      projectId: seededTask.projectId,
      epicId: seededTask.epicId,
    };

    // Rewind to the outage instant. The fixture's Task row is the FINAL state
    // (Done, under a closed Epic); the outage happened while the task was live.
    // Both values are folded out of the fixture's own audit trail, so this is a
    // replay of history rather than a scenario invented for the test.
    await db.task.update({
      where: { id: seededTask.id },
      data: {
        status: statusAtOutage,
        alertReporter: false,
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
      },
    });
    const replayCycle = await db.taskWorkflowCycle.create({
      data: {
        taskId: seededTask.id,
        sequence: 1,
        status: "open",
        openedWorkflowVersion: 0,
        workflowEngine: "orchestrator_v2",
      },
    });
    await db.task.update({ where: { id: seededTask.id }, data: { activeWorkflowCycleId: replayCycle.id } });
    if (seededTask.epicId) {
      await db.epic.update({ where: { id: seededTask.epicId }, data: { status: "In Progress" } });
    }

    // ------------------------------------------------------------------
    // E3 — the outage turn.
    //
    // What happened on 2026-08-04: the agent's turn died with an OpenClaw
    // auto-compaction failure at 22:48:29. PM logged `task.chat.stream_error`
    // and then did nothing with the turn — the run stayed non-terminal, and the
    // work only resumed because a human posted a comment 28 minutes later.
    //
      // What must happen now: the same error text is CLASSIFIED as a retryable
      // turn failure, but task execution never replays the poisoned transport
      // turn. PM closes that bounded episode, opens exactly one fresh successor,
      // marks the old run failed rather than complete, and preserves durable work.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("E3", "the outage's compaction failure is retried, never settled complete");

      // The historical shape, read out of the fixture so it cannot rot.
      const historicalRun = fixture.sections.pmChannelRuns.find(
        (row) => row.messageId === outage.messageId,
      );
      c.assert(historicalRun, "the run that hit the outage is in the fixture");
      c.assertEqual(
        historicalRun!.failedAt,
        null,
        "history: the run that died was never marked failed",
      );
      c.assert(
        historicalRun!.status !== "failed",
        `history: it settled as ${JSON.stringify(historicalRun!.status)} instead`,
      );
      c.assertEqual(statusAtOutage, "In Progress", "history: the task was live when the turn died");

      // The contract starts with the classifier: production must recognise the
      // REAL error text, not a paraphrase of it.
      c.assert(
        isRetryablePmChannelTurnFailure(outage.error),
        "the exact error string from the outage is classified retryable",
      );

      const turn = await dispatchWorkflowTurn({ boot, world, taskId: seededTask.id });
      const targetKey = `task-comment:${world.agentSlug}:${seededTask.id}:${turn.messageId}`;

      // Take the turn the way the worker does, so the attempt is real: the
      // retry bound is counted in CLAIMS, and a scenario that never claimed
      // would be asserting against a ladder that can never advance.
      const claimedFirst = await claimNextPmChannelJob("replay-e3-worker");
      c.assert(claimedFirst, "the dispatched turn was claimable by a worker");
      c.assertEqual(claimedFirst!.run.targetKey, targetKey, "the worker claimed OUR turn");

      const before = await db.pmChannelJob.findFirstOrThrow({
        where: { run: { targetKey } },
        select: { id: true, attemptCount: true },
      });
      c.assertEqual(before.attemptCount, 1, "the claim counted as the turn's first attempt");
      const progressBefore = await readTaskProgress(db, seededTask.id);

      const first = await retryOrFailPmChannelJobForTurnFailure({
        targetKey,
        error: outage.error,
      });
      c.assertEqual(first, "retried", "task execution continues through a fresh episode");

      const jobs = await db.pmChannelJob.findMany({ where: { run: { targetKey } } });
      c.assertEqual(jobs.length, 1, "the poisoned turn is not duplicated");
      c.assertEqual(jobs[0].id, before.id, "the historical turn identity remains auditable");
      c.assertEqual(jobs[0].status, "failed", "the poisoned transport job is never replayed");

      const run = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { status: true, disposition: true, completedAt: true, finishedReason: true },
      });
      c.assertEqual(run.status, "failed", "the dead transport turn settles terminally");
      c.assertEqual(
        run.disposition,
        "continue",
        "while the task execution records an explicit continuation disposition",
      );
      c.assertEqual(
        run.finishedReason,
        "context_pressure_episode_recovered",
        "the cause and recovery path are auditable",
      );
      c.assertEqual(run.completedAt, null, "nothing about it claims completion");

      const recoveredEpisodes = await db.taskExecutionEpisode.findMany({
        where: { taskId: seededTask.id, agentSlug: world.agentSlug },
        orderBy: { episodeNo: "desc" },
        take: 2,
      });
      c.assertEqual(recoveredEpisodes.length, 2, "one successor episode was opened");
      c.assertEqual(recoveredEpisodes[0].status, "open", "the successor is ready to resume work");
      c.assertEqual(recoveredEpisodes[0].sessionKey, null, "it inherits no poisoned session");
      c.assertEqual(
        recoveredEpisodes[1].closeReason,
        "context_pressure_recovery",
        "the poisoned episode records why it was retired",
      );
      const recoveryContinuations = await db.pmChannelContinuation.findMany({
        where: { run: { targetKey }, action: "context_pressure_recovery" },
      });
      c.assertEqual(recoveryContinuations.length, 1, "exactly one durable recovery turn is queued");

      // Fail-soft means the WORK is untouched. Everything durable the task had
      // banked over three weeks has to survive an interrupted turn.
      const progressAfter = await readTaskProgress(db, seededTask.id);
      c.assertEqual(progressAfter.status, "In Progress", "the task keeps its status across recovery");
      c.assertEqual(
        progressAfter.checklist,
        meta.rowCounts.subTasks,
        "the checklist the fixture carries survives the interrupted turn",
      );
      c.assertEqual(
        progressAfter.comments,
        progressBefore.comments,
        "no durable comment was invented or lost by recovery",
      );
    }

    // ------------------------------------------------------------------
    // E4 — the abandoned lease.
    //
    // The fixture's most expensive fact: after the stream error the run sat
    // non-terminal for two and a half hours. For that whole window the task
    // read as actively being worked, the Epic queue would not advance, and
    // nothing but a human noticing changed that.
    //
    // The stall duration is computed from the fixture rather than asserted as a
    // constant, and it is compared against the CURRENT lease TTL — which is how
    // this case proves the historical row would now be caught rather than
    // merely that some synthetic row is.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("E4", "an abandoned lease is reaped by the watchdog, not by a human");

      const historicalRun = fixture.sections.pmChannelRuns.find(
        (row) => row.messageId === outage.messageId,
      )!;
      const stallMs = Date.parse(String(historicalRun.completedAt)) - Date.parse(outage.at);
      c.assert(stallMs > 0, "the fixture records when the abandoned run was finally settled");
      c.assert(
        stallMs > WORKFLOW_RUN_LEASE_TTL_MS,
        `history: the run sat unsettled for ${Math.round(stallMs / MINUTE_MS)} minutes, past the ` +
          `${Math.round(WORKFLOW_RUN_LEASE_TTL_MS / MINUTE_MS)}-minute lease — today's watchdog would see it`,
      );

      // Re-create that shape as a live lease of exactly the fixture's age.
      const abandonedAt = new Date(Date.now() - stallMs);
      const messageId = `replay-e4-${outage.messageId}`;
      await db.pmChannelRun.create({
        data: {
          targetKey: `task-comment:${world.agentSlug}:${seededTask.id}:${messageId}`,
          kind: "task-comment",
          agentSlug: world.agentSlug,
          messageId,
          projectId: world.projectId,
          taskId: seededTask.id,
          sessionKey: String(historicalRun.sessionKey ?? "replay-e4-session"),
          status: "accepted",
          createdAt: abandonedAt,
          acceptedAt: abandonedAt, admittedAt: abandonedAt,
          lastEventAt: abandonedAt,
        },
      });

      const pass = await runWorkflowWatchdog({ projectId: world.projectId });
      c.assertEqual(pass.errors.length, 0, `the pass reported no errors: ${pass.errors.join("; ")}`);

      const state = await readRunState(db, { taskId: seededTask.id });
      const reaped = state.runs.find((row) => row.messageId === messageId);
      c.assert(reaped, "the abandoned run is still readable after the pass");
      c.assertEqual(reaped!.status, "timed_out", "the dead lease was settled terminally");
      c.assertEqual(
        reaped!.finishedReason,
        "watchdog_lease_expired",
        "the settle names the watchdog, so the two-and-a-half-hour gap has an owner now",
      );
      c.assertEqual(reaped!.disposition, "failed", "the terminal write recorded a disposition");
      c.assertEqual(
        state.active.length,
        0,
        "no run is left claiming the task is actively being worked",
      );

      // The operator strip is what a human would have had to notice manually.
      const progress = await readTaskProgress(db, seededTask.id);
      c.assert(progress.executionState, "the ENV-123 operator strip was written");
      c.assert(
        progress.executionState!.state !== "running",
        `the task no longer reads as running (got ${progress.executionState!.state})`,
      );
      c.assertEqual(
        progress.checklist,
        meta.rowCounts.subTasks,
        "reaping the lease did not touch the task's durable work",
      );
    }

    // ------------------------------------------------------------------
    // E5 — a blocker round is fail-soft.
    //
    // The fixture contains thirteen flag/clear cycles, every one of them
    // balanced: the task never once failed on a blocker, it waited. One of
    // those rounds is a scoped reporter-permission request, and that exact
    // request is what this case replays through the real route.
    //
    // The contract being protected: raising a blocker pauses the work without
    // ending the episode. Status holds, the reporter alert is raised, and the
    // action classifies as `wait` — not `finish`, which would let a blocked
    // task look like a delivered one.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("E5", "a blocker round pauses the work instead of failing it");

      const flagged = rowsOfKind(fixture, "task.blocker").length;
      const cleared = rowsOfKind(fixture, "task.blocker.cleared").length;
      c.assert(flagged > 0, "history: the drill really did hit blockers");
      c.assertEqual(cleared, flagged, "history: every blocker round was closed, none was abandoned");

      c.assertEqual(
        actionEffect.workflowActionEffect("flag_blocker"),
        "wait",
        "a blocker waits on somebody else — it neither continues nor finishes the episode",
      );

      const permission = permissionBlocker(fixture);
      c.assert(permission, "the fixture carries the drill's reporter-permission blocker");

      const turn = await dispatchWorkflowTurn({ boot, world, taskId: seededTask.id });
      const raised = await turn.post("flag_blocker", {
        comment:
          "Replay of the drill's permission round: the stubbed payment endpoint cannot be " +
          "swapped without the reporter's explicit authorization.",
        permissionKind: "reporter_approval",
        permissionScope: permission!.scope,
      });
      c.assertEqual(raised.status, 202, `the permission blocker was accepted: ${JSON.stringify(raised.body)}`);
      c.assertEqual(raised.body.flagged, "blocker", "the route reports a raised blocker");

      const blocked = await readTaskProgress(db, seededTask.id);
      c.assertEqual(blocked.status, "In Progress", "a blocked task stays In Progress — Review is for finished work");
      c.assertEqual(blocked.alertReporter, true, "the reporter alert is raised, so a human is actually woken");

      const blockedState = await readRunState(db, { taskId: seededTask.id });
      const blockerRun = blockedState.runs.find((row) => row.messageId === turn.messageId);
      c.assert(blockerRun, "the blocker turn's run is readable");
      c.assertEqual(blockerRun!.lastAction, "flag_blocker", "the run records the action the turn took");

      // ...and the round closes, which is what the fixture's 13/13 proves.
      const clearTurn = await dispatchWorkflowTurn({ boot, world, taskId: seededTask.id });
      const clearedResponse = await clearTurn.post("clear_blocker", {
        comment: "Replay: the reporter granted the scoped permission, so the drill resumes.",
      });
      c.assertEqual(clearedResponse.status, 202, "a fresh authorized turn clears the blocker after external action");
      const resumed = await readTaskProgress(db, seededTask.id);
      c.assertEqual(resumed.alertReporter, false, "clearing the blocker lowers the reporter alert");
      c.assertEqual(resumed.status, "In Progress", "and the task resumes where it was");
      c.assertEqual(
        resumed.checklist,
        meta.rowCounts.subTasks,
        "a full blocker round changes no durable work",
      );
    }

    // ------------------------------------------------------------------
    // E6 — the invariant checker can see the outage in the replayed history.
    //
    // The fixture's whole value is that it is a KNOWN-BAD trail. PM's invariant
    // monitor is the surface that is supposed to notice trails like it, so this
    // case runs the real monitor over the replayed rows and pins what it sees.
    //
    // It is also a read-only contract test: the monitor is on the operator path
    // and must never mutate the history it is inspecting.
    // ------------------------------------------------------------------
    {
      const c: ScenarioCase = report.case("E6", "the monitor reads the replayed outage without mutating it");

      const before = {
        runs: await db.pmChannelRun.count(),
        tasks: await db.task.count(),
        activity: await db.activityLog.count(),
        comments: await db.comment.count(),
        checklist: await db.subTask.count(),
      };
      const observed = await checkWorkflowInvariants({ projectId: world.projectId, now: Date.now(), sinceMs: 365 * 24 * 60 * 60 * 1000 });
      const after = {
        runs: await db.pmChannelRun.count(),
        tasks: await db.task.count(),
        activity: await db.activityLog.count(),
        comments: await db.comment.count(),
        checklist: await db.subTask.count(),
      };
      c.assertEqual(
        JSON.stringify(after),
        JSON.stringify(before),
        "the monitor wrote nothing while inspecting three weeks of production history",
      );

      c.assert(
        observed.counts.runs >= meta.rowCounts.pmChannelRuns,
        `the monitor scanned the whole replayed run trail (${observed.counts.runs} runs)`,
      );

      // What the monitor actually says about this trail. Reported rather than
      // pinned to a golden list: the fixture is real history and the invariant
      // set is still growing, so a hard-coded expectation here would be a
      // maintenance tax that proves nothing about fail-soft.
      const codes = [...new Set(observed.violations.map((violation) => violation.code))].sort();
      console.log(
        `[${SUITE}] E6 monitor over the replayed PH-116 trail: ` +
          `${observed.violations.length} violation(s) across ${codes.length} code(s)` +
          (codes.length > 0 ? `: ${codes.join(", ")}` : ""),
      );

      // FINDING (ENV-124): the monitor cannot see ANY of this history.
      //
      // ENV-117 renamed the run vocabulary — "complete" became "completed",
      // "canceled" became "cancelled" — and added "timed_out"/"superseded".
      // The rename was applied to the WRITERS but never backfilled onto rows
      // already in the database. Every one of the fixture's 72 production runs
      // still carries the old spelling, so `isActiveRunStatus` and
      // `isTerminalRunStatus` both return false for all of them: the
      // run-lifecycle invariants (WFI-001..WFI-006) skip the entire trail,
      // including the outage run that sat unsettled for two and a half hours.
      //
      // The assertions below pin that as CURRENT behaviour rather than
      // pretending the monitor caught it. The consequence is real and worth
      // stating plainly: the detection proven in E3/E4 is forward-looking — a
      // turn that dies TODAY is classified and reaped, but the pre-ENV-117 rows
      // sitting in production right now are invisible to both the monitor and
      // (for the same reason) the watchdog's active-lease scan. Backfilling the
      // rename onto historical rows is not in ENV-124's scope; this is the gap.
      const CURRENT_RUN_VOCABULARY = new Set([
        "queued",
        "accepted",
        "streaming",
        "completed",
        "failed",
        "timed_out",
        "cancelled",
        "superseded",
      ]);
      const legacyRuns = fixture.sections.pmChannelRuns.filter(
        (row) => !CURRENT_RUN_VOCABULARY.has(String(row.status)),
      );
      c.assertEqual(
        legacyRuns.length,
        meta.rowCounts.pmChannelRuns,
        "every production run in the fixture predates the ENV-117 status rename",
      );

      const outageRunId = String(
        fixture.sections.pmChannelRuns.find((row) => row.messageId === outage.messageId)!.id,
      );
      const outageRunViolations = observed.violations.filter(
        (violation) => violation.subjectId === outageRunId,
      );
      c.assertEqual(
        outageRunViolations.length,
        0,
        "current behaviour: the historical outage run is reported by no invariant at all",
      );
      console.log(
        `[${SUITE}] E6 FINDING: all ${legacyRuns.length} production runs use the pre-ENV-117 ` +
          `vocabulary (complete/canceled), so the run-lifecycle invariants skip them entirely — ` +
          `the abandoned outage run is reported 0 times.`,
      );
    }

    report.ok();
  } finally {
    await sandbox.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(`[${SUITE}] unexpected failure:`, error);
  process.exit(1);
});
