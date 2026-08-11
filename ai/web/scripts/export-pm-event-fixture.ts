// ENV-124 — export one task's real event sequence as a committed regression fixture.
//
// The Epic requires that the event sequence behind PH-116 ("9. Outage drill:
// prove the fail-soft contract (E6)") becomes a PERMANENT regression fixture:
// scripts/workflow-regression-fixture-test.ts must be able to replay it years
// from now, on a laptop, with no access to the production database. This script
// is the one-way bridge that produces that file.
//
// Three properties make it a fixture rather than a database dump:
//
//   * READ-ONLY, AND NEVER AGAINST THE LIVE FILE. The exporter opens sqlite in
//     read-only mode and refuses outright to open anything under the live data
//     directory. The intended workflow is `cp` the live db (plus its -wal/-shm
//     sidecars) to a temp dir and point `--db` at the COPY. A sqlite reader
//     that touches a live WAL can checkpoint it; there is no reason to take
//     that risk for a read.
//
//   * REDACTED HARD. The trail carries dispatch envelopes, system prompts and
//     context-grant rows — exactly the places a bearer token, an auth secret or
//     a human's email address lives. Redaction runs on THREE axes: field names
//     matching the secret patterns are replaced wholesale, every remaining
//     string is scanned for token-shaped blobs, and free PROSE is scanned for
//     credentials a human typed into a comment ("reset the password to
//     \"…\"", "cvv: …"), payment card numbers and live gateway identifiers.
//     That third axis exists because PM's richest columns are `body`/`payload`
//     free text, where a secret is disclosed in a sentence and no field name
//     marks it. Placeholders are fixed strings (`[redacted:token]`,
//     `[redacted:email]`, `[redacted:blob]`, `[redacted:credential]`,
//     `[redacted:card]`, `[redacted:payment]`) so a redacted fixture is still
//     byte-stable.
//
//   * DETERMINISTIC. Same database in, byte-identical file out: object keys are
//     emitted in sorted order, rows are sorted by (timestamp, id), DATETIME
//     columns are normalised to ISO-8601, and embedded JSON payload strings are
//     re-serialised with the same stable key order. Re-running the exporter is
//     therefore a no-op in `git diff` unless the source rows actually changed —
//     which is what makes the fixture reviewable.
//
// The schema is DISCOVERED, not assumed. `sqlite_master` and `PRAGMA
// table_info` decide which sections exist and which columns each one carries,
// because production is not always on the same migration as this worktree (at
// time of writing the live db has no TaskExecutionEpisode/TaskExecutionState
// tables at all). A section whose table is missing is recorded in
// `meta.skippedSections` rather than crashing the export.
//
// Usage:
//   cp /srv/Data/pm/wt-main.db{,-wal,-shm} /tmp/pm-copy/
//   npx tsx scripts/export-pm-event-fixture.ts <taskId> \
//     --db=/tmp/pm-copy/wt-main.db --out=patricia-e6-outage-drill
//
// Exit 0 on success, non-zero with a diagnostic on any failure.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SCRIPT = "export-pm-event-fixture";

/** Bumped whenever the emitted shape changes; the replay suite pins it. */
const EXPORT_SCHEMA_VERSION = 2;

/** The task the Epic actually names. Overridable, but this is the fixture. */
const DEFAULT_TASK_ID = "cmrodriti007kovmhq8x6qqls";

/**
 * Paths the exporter refuses to open, live WAL and all. Belt and braces: the
 * read-only flag alone would probably be safe, but "probably" is not a good
 * enough answer for the production PM database.
 */
const FORBIDDEN_DB_PREFIXES = ["/srv/Data/pm"];

function fail(message: string): never {
  console.error(`[${SCRIPT}] FAIL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export const REDACTION_PLACEHOLDERS = {
  named: "[redacted:token]",
  token: "[redacted:token]",
  email: "[redacted:email]",
  blob: "[redacted:blob]",
  credential: "[redacted:credential]",
  card: "[redacted:card]",
  payment: "[redacted:payment]",
} as const;

/** A value that is already a placeholder must never be re-redacted. */
const PLACEHOLDER_PREFIX = "[redacted:";

/**
 * Field names whose VALUE is a credential (or PII) regardless of what it looks
 * like. Matched against the leaf key, case-insensitively, including keys nested
 * inside embedded JSON payloads.
 *
 * `auth` is deliberately fenced off from `author`/`authorization`-as-prose:
 * this schema has an `AUTH_SECRET`-shaped world, and a false positive on an
 * author field would silently delete provenance from the fixture.
 */
const SECRET_FIELD_PATTERNS: RegExp[] = [
  /token/i,
  /secret/i,
  /passw/i,
  /bearer/i,
  /credential/i,
  /signature/i,
  /cookie/i,
  /email/i,
  /api_?key/i,
  /authorization/i,
  /(^|[^a-z])auth([^o]|$)/i,
  /key$/i,
];

/**
 * Field names that LOOK like credentials to the pattern list above but are
 * routing identifiers this fixture cannot lose: redacting `sessionKey` would
 * destroy the session-rotation evidence that is the entire point of the outage
 * case, and redacting `targetKey` would break the run lookups on replay.
 *
 * Allowlisted fields skip the NAME rule and the entropy scanners, but they are
 * still run through the high-confidence scanners (JWT / bearer / vendor
 * prefixes / email), so an allowlist entry can never become a leak channel.
 */
const FIELD_ALLOWLIST = new Set(
  [
    "sessionKey",
    "fromSessionKey",
    "toSessionKey",
    "targetKey",
    "dedupeKey",
    "taskKey",
    "projectKey",
    "work_item_key",
    "work_item_key_prefix",
    "openclawSessionKey",
    "openclawSessionId",
    "base_sha",
    "candidate_sha",
    "reviewed_sha",
  ].map((name) => name.toLowerCase()),
);

/** Unambiguous credential shapes. Applied to EVERY string, always. */
const HIGH_CONFIDENCE_SCANNERS: Array<{ kind: keyof typeof REDACTION_PLACEHOLDERS; re: RegExp }> = [
  // JSON Web Tokens — three base64url segments.
  { kind: "token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // `Authorization: Bearer <blob>` in any casing.
  { kind: "token", re: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  // Vendor-prefixed keys (GitHub, Slack, OpenAI, AWS, GitLab, HuggingFace).
  {
    kind: "token",
    re: /\b(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|AKIA|ASIA|glpat-|hf_)[A-Za-z0-9_-]{10,}/g,
  },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

// ---------------------------------------------------------------------------
// Free-text credential disclosure
//
// The name rule and the entropy scanners both assume a secret arrives in a
// field that either announces itself (`token`) or looks random. A human typing
// "if required, reset the password to \"<the actual password>\"" into a comment
// defeats both: the field is `body`, and the literal is short, low-entropy and
// perfectly ordinary-looking. PM's most valuable columns are exactly this kind
// of prose, so the exporter scans it explicitly.
//
// The rules are deliberately anchored — a credential NOUN, then a short
// connector, then the value — rather than "redact anything near the word
// password". Over-broad prose redaction would gut the fixture's evidentiary
// value (this history is three weeks of humans discussing a login failure, so
// the word "password" appears 68 times in sentences that disclose nothing).
// Measured against the committed fixture, these three rules fire on exactly
// the four disclosures below and nothing else.
// ---------------------------------------------------------------------------

/** Nouns whose value, when stated, IS the credential. */
const CREDENTIAL_NOUN = String.raw`pass(?:word|phrase|wd)|passcode|pwd|secret(?:[ _-]?key)?|api[ _-]?key|access[ _-]?key|credentials?|cvv|cvc`;

/** `<noun> to "value"`, `<noun>: 'value'`, `<noun> is \`value\`` — quoted disclosure. */
const CREDENTIAL_QUOTED = new RegExp(
  String.raw`(${CREDENTIAL_NOUN})(\s*[:=]\s*|\s+(?:is|are|was|to|as|of|for|=>)\s+)(["'` +
    "`" +
    String.raw`])((?:(?!\3)[^\n\r]){1,128})\3`,
  "gi",
);

/** `<noun>: value`, `<noun>=value` — bare assignment, value runs to the next delimiter. */
const CREDENTIAL_ASSIGNED = new RegExp(
  String.raw`(${CREDENTIAL_NOUN})(\s*[:=]\s*)([^\s"'` + "`" + String.raw`,;)\]}\\]{3,128})`,
  "gi",
);

/**
 * Payment card numbers. Luhn AND a real issuer prefix are both required: a
 * bare 13-19 digit run that happens to satisfy Luhn is far more likely to be an
 * epoch-millisecond timestamp (which always starts `1`) than a PAN, and eating
 * timestamps would corrupt the trail this fixture exists to preserve.
 */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const CARD_ISSUER_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5)|35)/;

/**
 * A card-shaped run that a LABEL announces as a card is redacted whether or not
 * it passes Luhn. The outage trail contains mistyped card numbers quoted as
 * evidence ("card number : 5511 2233 4455 6677889  <- typed …"); Luhn rejects
 * those by construction, and leaving a labelled PAN in the fixture because the
 * human fat-fingered it is not a defensible position.
 */
const CARD_LABELLED =
  /((?:cc|card|pan|credit[ _-]?card)(?:\s*(?:number|no\.?|num|#))?\s*[:=]\s*)((?:\d[ -]?){11,19}\d)/gi;

/**
 * Live payment-gateway identifiers pasted into a comment as evidence. The
 * outage trail quotes whole CBA acquirer responses inside fenced code blocks,
 * so the merchant id and receipt number arrive as PROSE — the structural
 * field-name rule never sees them, because the entire JSON response is one
 * string in one `body` column. None of them is required to replay the sequence.
 */
const PAYMENT_IDENTIFIER =
  /(["'`]?)(merchant[ _-]?id|acquirer[ _-]?id|receipt(?:[ _-]?(?:no|number|id))?|transaction[ _-]?(?:id|ref|reference)|payment[ _-]?(?:id|ref|reference)|invoice[ _-]?(?:no|number|id))\1(\s*[:=]\s*)(["'`]?)([A-Za-z0-9_-]{4,64})\4/gi;

/**
 * Long BARE digit runs. The trail quotes gateway receipts, order references and
 * a merchant id as loose prose ("acquirer `CBA_S2I` / merchant `353…`",
 * "receipt <digits>") where no adjacent key names them, so neither the
 * field rule nor `PAYMENT_IDENTIFIER` reaches them. None is required to replay
 * the sequence.
 *
 * The one class of long bare digit run this fixture legitimately needs is an
 * epoch timestamp, so those are excluded by shape: milliseconds (13), micro-
 * seconds (16) and nanoseconds (19) all begin with `1` for any date between
 * 2001 and 2286. Measured against the committed fixture this rule fires on six
 * distinct values, every one of them a payment artefact.
 */
const PAYMENT_NUMERIC_RUN = /(?<![\d.])\d{12,19}(?![\d.])/g;

function isPlausibleEpoch(digits: string): boolean {
  return (
    (digits.length === 13 || digits.length === 16 || digits.length === 19) && digits.startsWith("1")
  );
}

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

/**
 * Generic high-entropy blobs. Only applied to non-allowlisted fields, because
 * these are the rules that would eat a git sha or a routing key.
 *
 * The 32-character floor is chosen so a cuid (25 chars) is never mistaken for
 * a secret — every id in this schema must survive the export intact or the
 * fixture cannot be replayed.
 */
const ENTROPY_SCANNERS: Array<{ kind: keyof typeof REDACTION_PLACEHOLDERS; re: RegExp }> = [
  { kind: "blob", re: /\b[0-9a-f]{32,}\b/g },
  { kind: "blob", re: /\b(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}/g },
];

interface RedactionStats {
  named: number;
  token: number;
  email: number;
  blob: number;
  credential: number;
  card: number;
  payment: number;
  truncated: number;
}

export function newRedactionStats(): RedactionStats {
  return { named: 0, token: 0, email: 0, blob: 0, credential: 0, card: 0, payment: 0, truncated: 0 };
}

/**
 * Strip credentials a human disclosed in prose, plus payment card numbers.
 *
 * Exported so the regression suite can assert the RULE, not just the current
 * fixture bytes: a redaction hole that is only proven closed by "the known
 * literal is absent from the committed file" reopens the moment someone
 * regenerates the fixture from a different task.
 */
export function redactFreeText(value: string, stats: RedactionStats = newRedactionStats()): string {
  let out = value.replace(
    CREDENTIAL_QUOTED,
    (whole: string, noun: string, connector: string, quote: string, secret: string) => {
      if (secret.startsWith(PLACEHOLDER_PREFIX)) return whole;
      stats.credential += 1;
      return `${noun}${connector}${quote}${REDACTION_PLACEHOLDERS.credential}${quote}`;
    },
  );
  out = out.replace(
    CREDENTIAL_ASSIGNED,
    (whole: string, noun: string, connector: string, secret: string) => {
      if (secret.startsWith(PLACEHOLDER_PREFIX)) return whole;
      stats.credential += 1;
      return `${noun}${connector}${REDACTION_PLACEHOLDERS.credential}`;
    },
  );
  out = out.replace(
    PAYMENT_IDENTIFIER,
    (
      whole: string,
      keyQuote: string,
      key: string,
      connector: string,
      valueQuote: string,
      value: string,
    ) => {
      if (value.startsWith("redacted")) return whole;
      stats.payment += 1;
      return `${keyQuote}${key}${keyQuote}${connector}${valueQuote}${REDACTION_PLACEHOLDERS.payment}${valueQuote}`;
    },
  );
  out = out.replace(CARD_LABELLED, (whole: string, label: string, digits: string) => {
    if (digits.startsWith(PLACEHOLDER_PREFIX)) return whole;
    stats.card += 1;
    return `${label}${REDACTION_PLACEHOLDERS.card}`;
  });
  out = out.replace(CARD_CANDIDATE, (whole: string) => {
    const digits = whole.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return whole;
    if (!CARD_ISSUER_PREFIX.test(digits) || !isLuhnValid(digits)) return whole;
    stats.card += 1;
    return REDACTION_PLACEHOLDERS.card;
  });
  return out.replace(PAYMENT_NUMERIC_RUN, (whole: string) => {
    if (isPlausibleEpoch(whole)) return whole;
    stats.payment += 1;
    return REDACTION_PLACEHOLDERS.payment;
  });
}

function fieldIsSecret(field: string): boolean {
  if (FIELD_ALLOWLIST.has(field.toLowerCase())) return false;
  return SECRET_FIELD_PATTERNS.some((re) => re.test(field));
}

/** Scan a string value and replace anything credential-shaped, in place. */
function scanString(value: string, field: string, stats: RedactionStats): string {
  let out = value;
  for (const scanner of HIGH_CONFIDENCE_SCANNERS) {
    out = out.replace(scanner.re, () => {
      stats[scanner.kind] += 1;
      return REDACTION_PLACEHOLDERS[scanner.kind];
    });
  }
  // Prose disclosures and card numbers are unconditional: they are anchored
  // enough to be safe on an allowlisted routing key, and a `sessionKey` is not
  // a licence to leak a password quoted inside it.
  out = redactFreeText(out, stats);
  if (!FIELD_ALLOWLIST.has(field.toLowerCase())) {
    for (const scanner of ENTROPY_SCANNERS) {
      out = out.replace(scanner.re, () => {
        stats[scanner.kind] += 1;
        return REDACTION_PLACEHOLDERS[scanner.kind];
      });
    }
  }
  return out;
}

function truncate(value: string, limit: number, stats: RedactionStats): string {
  if (value.length <= limit) return value;
  stats.truncated += 1;
  return `${value.slice(0, limit)}…[truncated:${value.length}]`;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Redact one value.
 *
 * Strings that parse as JSON are redacted STRUCTURALLY — descending into the
 * object so nested `token` keys are caught by name — and then re-serialised
 * with sorted keys. That is what lets the exporter clean a dispatch envelope
 * without turning it into an opaque blob the replay cannot use.
 */
function redactValue(value: Json, field: string, limit: number, stats: RedactionStats): Json {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, field, limit, stats));
  }

  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = fieldIsSecret(key)
        ? ((stats.named += 1), REDACTION_PLACEHOLDERS.named)
        : redactValue(value[key], key, limit, stats);
    }
    return out;
  }

  // A string. Embedded JSON first, so nested field names get the name rule.
  const trimmed = value.trim();
  if (trimmed.length > 1 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed = JSON.parse(trimmed) as Json;
      const cleaned = redactValue(parsed, field, limit, stats);
      return truncate(stableStringify(cleaned), limit, stats);
    } catch {
      // Not JSON after all — fall through to the plain-string path.
    }
  }
  return truncate(scanString(value, field, stats), limit, stats);
}

// ---------------------------------------------------------------------------
// Deterministic serialisation
// ---------------------------------------------------------------------------

/** JSON.stringify with keys emitted in sorted order at every depth. */
function stableStringify(value: Json, indent = 0, depth = 0): string {
  const pad = indent ? "\n" + " ".repeat(indent * (depth + 1)) : "";
  const padEnd = indent ? "\n" + " ".repeat(indent * depth) : "";

  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${pad}${value
      .map((item) => stableStringify(item, indent, depth + 1))
      .join(`,${pad}`)}${padEnd}]`;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{}";
  return `{${pad}${keys
    .map((key) => `${JSON.stringify(key)}:${indent ? " " : ""}${stableStringify(value[key], indent, depth + 1)}`)
    .join(`,${pad}`)}${padEnd}}`;
}

// ---------------------------------------------------------------------------
// Section definitions
// ---------------------------------------------------------------------------

interface SectionSpec {
  /** Fixture key. Also the seeding order — the replay walks these in order. */
  name: string;
  table: string;
  /** `:taskId` is bound to the exported task id. */
  sql: string;
  /** When present, ONLY these columns are exported (used for identity tables). */
  columns?: string[];
  /** Column the rows are sorted by, before `id`. */
  orderBy: string;
  /**
   * Per-section cap on string length. Dispatch envelopes carry a ~45KB
   * rendered system prompt each; keeping them verbatim would make the fixture
   * a multi-megabyte file whose bulk is a rendering of state the fixture
   * already contains. The cap is recorded in `meta` so the loss is declared.
   */
  maxString: number;
}

const DEFAULT_MAX_STRING = 4000;

const SECTIONS: SectionSpec[] = [
  {
    name: "project",
    table: "Project",
    // Column-allowlisted: Project carries deployment credentials and a default
    // git email that have nothing to do with the event trail.
    columns: ["id", "slug", "name", "work_item_key_prefix", "createdAt", "updatedAt"],
    sql: "SELECT * FROM Project WHERE id = (SELECT projectId FROM Task WHERE id = :taskId)",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "epic",
    table: "Epic",
    columns: [
      "id",
      "projectId",
      "title",
      "work_item_key",
      "status",
      "statusChangedAt",
      "actingManagerId",
      "reporterId",
      "approved_on",
      "branchName",
      "commitPrefix",
      "createdAt",
      "updatedAt",
    ],
    sql: "SELECT * FROM Epic WHERE id = (SELECT epicId FROM Task WHERE id = :taskId)",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    // Tasks the exported task points AT (blocker, parent). Minimal rows, but
    // without them the fixture cannot be replayed under foreign keys.
    name: "relatedTasks",
    table: "Task",
    columns: ["id", "projectId", "title", "work_item_key", "status", "createdAt", "updatedAt"],
    sql: `SELECT * FROM Task WHERE id IN (
            SELECT blockedById FROM Task WHERE id = :taskId
            UNION SELECT parentTaskId FROM Task WHERE id = :taskId
          ) AND id IS NOT NULL`,
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "task",
    table: "Task",
    sql: "SELECT * FROM Task WHERE id = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "childTasks",
    table: "Task",
    columns: ["id", "projectId", "parentTaskId", "title", "status", "createdAt", "updatedAt"],
    sql: "SELECT * FROM Task WHERE parentTaskId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "subTasks",
    table: "SubTask",
    sql: "SELECT * FROM SubTask WHERE taskId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "comments",
    table: "Comment",
    sql: "SELECT * FROM Comment WHERE taskId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "agentChatMessages",
    table: "AgentChatMessage",
    sql: "SELECT * FROM AgentChatMessage WHERE taskId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "activity",
    table: "ActivityLog",
    sql: "SELECT * FROM ActivityLog WHERE taskId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "pmChannelRuns",
    table: "PmChannelRun",
    sql: "SELECT * FROM PmChannelRun WHERE taskId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "pmChannelJobs",
    table: "PmChannelJob",
    sql: "SELECT j.* FROM PmChannelJob j JOIN PmChannelRun r ON r.id = j.runId WHERE r.taskId = :taskId",
    orderBy: "createdAt",
    // The envelope's `systemPrompt` alone is ~45KB per job; 800 chars is
    // enough to prove WHAT was dispatched without shipping 3MB of prompt.
    maxString: 800,
  },
  {
    name: "pmChannelStreamEvents",
    table: "PmChannelStreamEvent",
    sql: "SELECT e.* FROM PmChannelStreamEvent e JOIN PmChannelRun r ON r.id = e.runId WHERE r.taskId = :taskId",
    orderBy: "createdAt",
    maxString: 2000,
  },
  {
    name: "pmEventDeliveries",
    table: "PmEventDelivery",
    sql: "SELECT * FROM PmEventDelivery WHERE taskId = :taskId",
    orderBy: "receivedAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "taskRepositoryRuns",
    table: "task_repository_runs",
    sql: "SELECT * FROM task_repository_runs WHERE task_id = :taskId",
    orderBy: "created_at",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "agentSessionBindings",
    table: "AgentSessionBinding",
    sql: "SELECT * FROM AgentSessionBinding WHERE scopeType = 'task' AND scopeId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "contextGrants",
    table: "ContextGrant",
    // Carries `tokenHash`. Kept deliberately: a fixture that proves the
    // redactor fires on the one genuinely credential-shaped column in the
    // trail is worth more than one that quietly drops the table.
    sql: "SELECT * FROM ContextGrant WHERE scopeType = 'task' AND scopeId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "taskExecutionEpisodes",
    table: "TaskExecutionEpisode",
    sql: "SELECT * FROM TaskExecutionEpisode WHERE taskId = :taskId",
    orderBy: "createdAt",
    maxString: DEFAULT_MAX_STRING,
  },
  {
    name: "taskExecutionState",
    table: "TaskExecutionState",
    sql: "SELECT * FROM TaskExecutionState WHERE taskId = :taskId",
    orderBy: "updatedAt",
    maxString: DEFAULT_MAX_STRING,
  },
];

/**
 * Columns across the exported rows that reference a User. Whatever they point
 * at gets exported as a principal (and its Agent row), so the fixture is
 * referentially closed and replays under foreign keys.
 */
const USER_REFERENCE_COLUMNS = [
  "userId",
  "senderUserId",
  "assigneeId",
  "actingManagerId",
  "reporterId",
  "approved_by",
  "archived_by",
  "deletedById",
  "uploaderId",
  "proposedByUserId",
  "appliedById",
  "rejectedById",
  "requesterUserId",
  "archivedById",
];

/** Identity columns exported for principals — never the hash, never the email. */
const PRINCIPAL_COLUMNS = [
  "id",
  "username",
  "kind",
  "name",
  "is_owner",
  "status",
  "agentId",
  "createdAt",
  "updatedAt",
];

const AGENT_COLUMNS = ["id", "slug", "name", "role", "gatewayPort", "createdAt", "updatedAt"];

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type Row = Record<string, Json>;

interface TableShape {
  columns: string[];
  /** Columns declared DATETIME — normalised to ISO and flagged for the replay. */
  datetimeColumns: string[];
}

function readTableShape(dbh: DatabaseSync, table: string): TableShape | null {
  const exists = dbh
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return null;
  const info = dbh.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
    name: string;
    type: string;
  }>;
  return {
    columns: info.map((column) => column.name),
    datetimeColumns: info
      .filter((column) => String(column.type).toUpperCase() === "DATETIME")
      .map((column) => column.name),
  };
}

/**
 * Normalise a raw sqlite value.
 *
 * Prisma stores DATETIME on sqlite as epoch milliseconds; a fixture full of
 * bare integers is unreadable in review and ambiguous on replay, so every
 * declared DATETIME becomes an ISO-8601 string. `meta` records which columns
 * were converted so the replay can invert it exactly.
 */
function normalise(value: unknown, column: string, shape: TableShape): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return `[redacted:blob]`;
  if (shape.datetimeColumns.includes(column) && typeof value === "number") {
    return new Date(value).toISOString();
  }
  if (shape.datetimeColumns.includes(column) && typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return value as Json;
}

/** Sort key: the section's time column, then id — total and stable. */
function sortRows(rows: Row[], orderBy: string): Row[] {
  return [...rows].sort((a, b) => {
    const at = String(a[orderBy] ?? "");
    const bt = String(b[orderBy] ?? "");
    if (at !== bt) return at < bt ? -1 : 1;
    const ai = String(a.id ?? "");
    const bi = String(b.id ?? "");
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Args {
  taskId: string;
  dbPath: string;
  outName: string;
}

function parseArgs(argv: string[]): Args {
  let taskId = DEFAULT_TASK_ID;
  let dbPath = "";
  let outName = "patricia-e6-outage-drill";
  for (const arg of argv) {
    if (arg.startsWith("--db=")) dbPath = arg.slice("--db=".length);
    else if (arg.startsWith("--out=")) outName = arg.slice("--out=".length).replace(/\.json$/, "");
    else if (arg.startsWith("--")) fail(`unknown flag ${arg}`);
    else taskId = arg;
  }
  if (!dbPath) fail("--db=<path to a COPY of the pm database> is required");
  return { taskId, dbPath, outName };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolved = path.resolve(args.dbPath);
  for (const forbidden of FORBIDDEN_DB_PREFIXES) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}/`)) {
      fail(
        `refusing to open ${resolved}: that is the live PM database. ` +
          `Copy it (with -wal/-shm) to a temp directory and point --db at the copy.`,
      );
    }
  }

  const dbh = new DatabaseSync(resolved, { readOnly: true });
  const stats: RedactionStats = newRedactionStats();

  try {
    const taskShape = readTableShape(dbh, "Task");
    if (!taskShape) fail(`${resolved} has no Task table — is this a PM database?`);
    const taskRow = dbh.prepare("SELECT * FROM Task WHERE id = ?").get(args.taskId) as
      | Record<string, unknown>
      | undefined;
    if (!taskRow) fail(`task ${args.taskId} not found in ${resolved}`);

    const sections: Record<string, Json> = {};
    const rowCounts: Record<string, Json> = {};
    const datetimeColumns: Record<string, Json> = {};
    const skipped: string[] = [];
    const userIds = new Set<string>();

    for (const spec of SECTIONS) {
      const shape = readTableShape(dbh, spec.table);
      if (!shape) {
        // Production is not always on this worktree's migration. Record it.
        skipped.push(`${spec.name} (no table ${spec.table})`);
        continue;
      }

      // `:taskId` may appear several times in one statement (the relatedTasks
      // union does), so it is bound positionally as many times as it occurs.
      const raw = dbh.prepare(spec.sql.replace(/:taskId/g, "?"));
      const placeholders = (spec.sql.match(/:taskId/g) ?? []).length;
      const rows = raw.all(...(Array(placeholders).fill(args.taskId) as string[])) as Array<
        Record<string, unknown>
      >;

      const exportColumns = (spec.columns ?? shape.columns).filter((column) =>
        shape.columns.includes(column),
      );
      const cleaned: Row[] = rows.map((row) => {
        const out: Row = {};
        for (const column of exportColumns) {
          const value = normalise(row[column], column, shape);
          out[column] = fieldIsSecret(column)
            ? ((stats.named += 1), REDACTION_PLACEHOLDERS.named)
            : redactValue(value, column, spec.maxString, stats);
        }
        // Collect referenced principals from the RAW row, before redaction, so
        // an allowlist change can never silently orphan a foreign key.
        for (const column of USER_REFERENCE_COLUMNS) {
          const value = row[column];
          if (typeof value === "string" && value) userIds.add(value);
        }
        return out;
      });

      sections[spec.name] = sortRows(cleaned, spec.orderBy) as unknown as Json;
      rowCounts[spec.name] = cleaned.length;
      datetimeColumns[spec.name] = exportColumns.filter((column) =>
        shape.datetimeColumns.includes(column),
      );
    }

    // ---- principals, derived from every FK the exported rows actually use ----
    const userShape = readTableShape(dbh, "User");
    if (!userShape) fail("no User table");
    const agentShape = readTableShape(dbh, "Agent");
    if (!agentShape) fail("no Agent table");

    const principals: Row[] = [];
    const agentIds = new Set<string>();
    for (const id of [...userIds].sort()) {
      const row = dbh.prepare("SELECT * FROM User WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) continue;
      const out: Row = {};
      for (const column of PRINCIPAL_COLUMNS) {
        if (!userShape.columns.includes(column)) continue;
        out[column] = redactValue(
          normalise(row[column], column, userShape),
          column,
          DEFAULT_MAX_STRING,
          stats,
        );
      }
      principals.push(out);
      if (typeof row.agentId === "string" && row.agentId) agentIds.add(row.agentId);
    }

    const agents: Row[] = [];
    for (const id of [...agentIds].sort()) {
      const row = dbh.prepare("SELECT * FROM Agent WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) continue;
      const out: Row = {};
      for (const column of AGENT_COLUMNS) {
        if (!agentShape.columns.includes(column)) continue;
        out[column] = redactValue(
          normalise(row[column], column, agentShape),
          column,
          DEFAULT_MAX_STRING,
          stats,
        );
      }
      agents.push(out);
    }

    sections.agents = sortRows(agents, "createdAt") as unknown as Json;
    rowCounts.agents = agents.length;
    datetimeColumns.agents = AGENT_COLUMNS.filter((column) =>
      agentShape.datetimeColumns.includes(column),
    );
    sections.principals = sortRows(principals, "createdAt") as unknown as Json;
    rowCounts.principals = principals.length;
    datetimeColumns.principals = PRINCIPAL_COLUMNS.filter((column) =>
      userShape.datetimeColumns.includes(column),
    );

    const totalRows = Object.values(rowCounts).reduce<number>(
      (sum, count) => sum + (count as number),
      0,
    );

    // The seed order the replay must follow: identity, then the task, then the
    // trail. Emitted explicitly so the replay never has to guess.
    const seedOrder = [
      "project",
      "agents",
      "principals",
      "epic",
      "relatedTasks",
      "task",
      "childTasks",
      "subTasks",
      "comments",
      "agentChatMessages",
      "activity",
      "pmChannelRuns",
      "pmChannelJobs",
      "pmChannelStreamEvents",
      "pmEventDeliveries",
      "taskRepositoryRuns",
      "agentSessionBindings",
      "contextGrants",
      "taskExecutionEpisodes",
      "taskExecutionState",
    ].filter((name) => name in sections);

    const projectRow = (sections.project as unknown as Row[])[0];

    // Count what survived into the emitted rows, not what the redactor tried
    // to do — see `meta.redaction.counts` below.
    const emittedText = stableStringify(sections as unknown as Json);
    const occurrences = (needle: string) => emittedText.split(needle).length - 1;
    const emittedCounts: Record<string, Json> = {
      "[redacted:token]": occurrences(REDACTION_PLACEHOLDERS.token),
      "[redacted:email]": occurrences(REDACTION_PLACEHOLDERS.email),
      "[redacted:blob]": occurrences(REDACTION_PLACEHOLDERS.blob),
      "[redacted:credential]": occurrences(REDACTION_PLACEHOLDERS.credential),
      "[redacted:card]": occurrences(REDACTION_PLACEHOLDERS.card),
      "[redacted:payment]": occurrences(REDACTION_PLACEHOLDERS.payment),
      "[truncated:": occurrences("[truncated:"),
    };

    const fixture: Json = {
      meta: {
        exportSchemaVersion: EXPORT_SCHEMA_VERSION,
        generator: `scripts/${SCRIPT}.ts`,
        sourceTaskId: args.taskId,
        sourceTaskKey: (taskRow.work_item_key as string) ?? null,
        sourceTitle: (taskRow.title as string) ?? null,
        sourceStatus: (taskRow.status as string) ?? null,
        sourceProjectSlug: (projectRow?.slug as string) ?? null,
        sourceEpicId: (taskRow.epicId as string) ?? null,
        seedOrder,
        skippedSections: skipped.sort(),
        rowCounts,
        totalRows,
        datetimeColumns,
        tables: Object.fromEntries(
          SECTIONS.filter((spec) => spec.name in sections).map((spec) => [spec.name, spec.table]),
        ),
        redaction: {
          placeholders: [...new Set(Object.values(REDACTION_PLACEHOLDERS))].sort(),
          fieldNamePatterns: SECRET_FIELD_PATTERNS.map((re) => re.source),
          freeTextPatterns: [
            CREDENTIAL_QUOTED.source,
            CREDENTIAL_ASSIGNED.source,
            PAYMENT_IDENTIFIER.source,
            PAYMENT_NUMERIC_RUN.source,
            CARD_LABELLED.source,
            CARD_CANDIDATE.source,
          ],
          allowlistedFields: [...FIELD_ALLOWLIST].sort(),
          maxStringBySection: Object.fromEntries(
            SECTIONS.filter((spec) => spec.name in sections).map((spec) => [
              spec.name,
              spec.maxString,
            ]),
          ),
          counts: {
            // What the redactor DID. Higher than `emitted` by construction:
            // truncation runs after redaction, so a placeholder written past a
            // section's cap is counted here and then trimmed off.
            applied: {
              byFieldName: stats.named,
              tokenShaped: stats.token,
              emailShaped: stats.email,
              entropyBlob: stats.blob,
              proseCredential: stats.credential,
              paymentCard: stats.card,
              paymentIdentifier: stats.payment,
              truncatedStrings: stats.truncated,
            },
            // What actually SURVIVES in the emitted rows. This is the number
            // the replay suite pins, because it is the only one a corrupted or
            // truncated fixture cannot silently satisfy.
            emitted: emittedCounts,
          },
        },
      },
      sections: sections as unknown as Json,
    };

    const outDir = path.join(process.cwd(), "scripts", "fixtures");
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${args.outName}.json`);
    await writeFile(outPath, `${stableStringify(fixture, 2)}\n`, "utf8");

    console.log(
      `[${SCRIPT}] wrote ${outPath} — ${totalRows} rows across ${seedOrder.length} section(s); ` +
        `redactions: ${stats.named} by-name, ${stats.token} token-shaped, ${stats.email} email, ` +
        `${stats.blob} entropy-blob, ${stats.credential} prose-credential, ` +
        `${stats.card} payment-card, ${stats.payment} payment-id, ${stats.truncated} truncated`,
    );
    if (skipped.length > 0) {
      console.log(`[${SCRIPT}] skipped: ${skipped.join(", ")}`);
    }
  } finally {
    dbh.close();
  }
}

// Only export when RUN. The regression suite imports `redactFreeText` from this
// module to assert the redaction rules directly, and an import that opened a
// database would make that impossible.
const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(`[${SCRIPT}] unexpected failure:`, error);
    process.exit(1);
  });
}
