// ENV-116 — executable workflow invariants for the "PM Workflow Improvement"
// Epic.
//
// This module is a SPECIFICATION, not behaviour. It defines the invariants the
// Epic's nine items must satisfy, expressed as pure predicates over plain
// record shapes so they can be exercised three ways:
//
//   1. fixture unit tests            (scripts/workflow-invariants-test.ts)
//   2. real rows on a throwaway db   (scripts/workflow-invariants-db-test.ts)
//   3. a read-only monitor snapshot  (lib/workflow-invariants-db.ts)
//
// Deliberately NO Prisma import here: the predicates must stay callable from a
// fixture with no database at all. The live-DB adapter lives next door in
// lib/workflow-invariants-db.ts.
//
// Several of these invariants are RED against current behaviour on purpose —
// they are the Epic's acceptance gate. The known-violated set is recorded in
// lib/workflow-invariants-baseline.json, and an Epic item is only "landed"
// once it can delete its baseline entry. See docs/workflow-invariants.md.

// ------------------------------------------------------------------
// Definitions the schema has no primitive for yet
// ------------------------------------------------------------------

// A run's lease is not a column. It is derived: the most recent proof of life
// (lastEventAt, else streamingAt, else acceptedAt, else createdAt) plus a TTL.
// "Renew or become terminal" is expressed against that, so these invariants
// need no migration to be testable.
//
// Aligned with PM_CHANNEL_JOB_ACCEPTED_TIMEOUT_MS (lib/agents/pm-channel/runs.ts),
// whose default is 30 minutes.
export const WORKFLOW_RUN_LEASE_TTL_MS = 30 * 60 * 1000;

// Every agent turn must end with one of these. There is no implicit sixth
// value and no "unset" — an absent disposition is itself a violation (WFI-005).
export const WORKFLOW_DISPOSITIONS = [
  "continue",
  "waiting_external",
  "ready_for_review",
  "completed",
  "failed",
] as const;

export type WorkflowDisposition = (typeof WORKFLOW_DISPOSITIONS)[number];

export function isWorkflowDisposition(
  value: unknown,
): value is WorkflowDisposition {
  return (
    typeof value === "string" &&
    (WORKFLOW_DISPOSITIONS as readonly string[]).includes(value)
  );
}

// Run statuses that mean "the system still believes this turn is running".
export const ACTIVE_RUN_STATUSES = [
  "queued",
  "accepted",
  "streaming",
  "retryable",
] as const;

// Run statuses that mean the episode is over, successfully or not.
export const TERMINAL_RUN_STATUSES = ["complete", "failed", "canceled"] as const;

export function isActiveRunStatus(value: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalRunStatus(value: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(value);
}

// Epic item 1. A workflow action is either "continuation-required" — the agent
// is expected to keep working in the same episode — or "episode-terminal", the
// legitimate end of a turn. Settling a run complete on a continuation-required
// action reports success for work that never happened.
export type WorkflowActionClass = "continuation-required" | "episode-terminal";

export const WORKFLOW_ACTION_CLASS: Readonly<
  Record<string, WorkflowActionClass>
> = {
  // Continuation-required: each of these is a step *inside* an episode.
  start: "continuation-required",
  add_subtask: "continuation-required",
  complete_subtask: "continuation-required",
  remove_subtask: "continuation-required",
  clear_blocker: "continuation-required",
  publish_checkpoint: "continuation-required",

  // Episode-terminal: the agent has handed control back to PM or a human.
  ready_for_review: "episode-terminal",
  submit_review: "episode-terminal",
  review_feedback: "episode-terminal",
  review_done: "episode-terminal",
  triage_to_todo: "episode-terminal",
  approve_plan: "episode-terminal",
  assign_after_plan_approval: "episode-terminal",
  request_subtask: "episode-terminal",
  request_task: "episode-terminal",
  flag_blocker: "episode-terminal",
  flag_extra_work_blocker: "episode-terminal",
};

export function workflowActionClass(
  action: string | null | undefined,
): WorkflowActionClass | null {
  if (!action) return null;
  return WORKFLOW_ACTION_CLASS[action] ?? null;
}

export function isContinuationRequiredAction(
  action: string | null | undefined,
): boolean {
  return workflowActionClass(action) === "continuation-required";
}

// ------------------------------------------------------------------
// Snapshot record shapes
// ------------------------------------------------------------------
//
// Timestamps are epoch milliseconds (or null) so fixtures never need Date
// juggling and the predicates stay trivially comparable.
//
// Three fields below do NOT exist on PmChannelRun today:
//   settledByAction, finalResponseText, disposition
// They are exactly what the Epic must make durable. The live-DB adapter
// derives the first two from ActivityLog / durable replies and leaves
// disposition null, which is why WFI-005 is red in the baseline.

export interface RunRecord {
  id: string;
  agentSlug: string;
  taskId: string | null;
  epicId: string | null;
  messageId: string;
  status: string;
  createdAt: number;
  acceptedAt: number | null;
  streamingAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  lastEventAt: number | null;
  /** Workflow action that settled this run, if a workflow action did. */
  settledByAction: string | null;
  /** The turn's durable final response text, if any was persisted. */
  finalResponseText: string | null;
  /** The explicit end-of-turn disposition. Null = never recorded. */
  disposition: string | null;
}

export interface TaskRecord {
  id: string;
  status: string;
  assigneeSlug: string | null;
  approvedOn: number | null;
  /** Count of durable checklist rows (SubTask, kind=implementation). */
  checklistCount: number;
  /**
   * How the checklist was produced. "structured" = the approved plan carried
   * machine-readable steps; "markdown-prose" = the steps were scraped out of
   * rendered Markdown (Epic item 4); "none" = no checklist was derived.
   */
  planStepSource: "structured" | "markdown-prose" | "none";
}

export interface BlockerRecord {
  id: string;
  taskId: string;
  kind: string;
  /** The external actor who must act. Null = never captured. */
  externalActor: string | null;
  /** The concrete, actionable requirement. Null = never captured. */
  requirement: string | null;
  clearedAt: number | null;
}

export interface WorkflowInvariantSnapshot {
  /** Evaluation instant, epoch ms. */
  now: number;
  runs: RunRecord[];
  tasks: TaskRecord[];
  blockers: BlockerRecord[];
}

export function emptySnapshot(now: number): WorkflowInvariantSnapshot {
  return { now, runs: [], tasks: [], blockers: [] };
}

// ------------------------------------------------------------------
// Violations
// ------------------------------------------------------------------
//
// `code` is the stable identity used for baseline matching. Row ids are cuids
// and change every run, so the baseline compares codes and counts, never ids.

export interface InvariantViolation {
  invariantId: string;
  code: string;
  subjectKind: "run" | "task" | "blocker" | "run-group";
  subjectId: string;
  detail: string;
}

export interface InvariantResult {
  ok: boolean;
  violations: InvariantViolation[];
}

export type InvariantScope =
  | "run-lifecycle"
  | "turn-disposition"
  | "blocker"
  | "action-plan";

export interface WorkflowInvariant {
  id: string;
  statement: string;
  scope: InvariantScope;
  /** 1-based index into the Epic description's numbered item list. */
  epicItem: number;
  predicate: (snapshot: WorkflowInvariantSnapshot) => InvariantResult;
}

function result(violations: InvariantViolation[]): InvariantResult {
  return { ok: violations.length === 0, violations };
}

// ------------------------------------------------------------------
// Lease helpers
// ------------------------------------------------------------------

export function runLeaseAnchor(run: RunRecord): number {
  return run.lastEventAt ?? run.streamingAt ?? run.acceptedAt ?? run.createdAt;
}

export function runLeaseExpired(
  run: RunRecord,
  now: number,
  ttlMs: number = WORKFLOW_RUN_LEASE_TTL_MS,
): boolean {
  return now - runLeaseAnchor(run) > ttlMs;
}

/** A run the system genuinely still believes is running right now. */
export function runIsGenuinelyActive(
  run: RunRecord,
  now: number,
  ttlMs: number = WORKFLOW_RUN_LEASE_TTL_MS,
): boolean {
  return isActiveRunStatus(run.status) && !runLeaseExpired(run, now, ttlMs);
}

function runSubject(run: RunRecord): string {
  return run.taskId ?? run.epicId ?? "unscoped";
}

function laneKey(run: RunRecord): string {
  return `${runSubject(run)}|${run.agentSlug}`;
}

/** Runs in the same (subject, agent) lane created strictly after `after`. */
function successorRuns(
  snapshot: WorkflowInvariantSnapshot,
  run: RunRecord,
  after: number,
): RunRecord[] {
  const key = laneKey(run);
  return snapshot.runs.filter(
    (candidate) =>
      candidate.id !== run.id &&
      laneKey(candidate) === key &&
      candidate.createdAt > after,
  );
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

// ------------------------------------------------------------------
// The invariants
// ------------------------------------------------------------------

// WFI-001 — "At most one genuinely active run per task and assignee."
const WFI_001: WorkflowInvariant = {
  id: "WFI-001",
  statement:
    "At most one genuinely active run may exist per (task-or-epic, agent) lane.",
  scope: "run-lifecycle",
  epicItem: 2,
  predicate: (snapshot) => {
    const lanes = new Map<string, RunRecord[]>();
    for (const run of snapshot.runs) {
      if (!runIsGenuinelyActive(run, snapshot.now)) continue;
      const key = laneKey(run);
      const bucket = lanes.get(key);
      if (bucket) bucket.push(run);
      else lanes.set(key, [run]);
    }
    const violations: InvariantViolation[] = [];
    for (const [key, runs] of lanes) {
      if (runs.length <= 1) continue;
      violations.push({
        invariantId: "WFI-001",
        code: "WFI-001/multiple-active-runs",
        subjectKind: "run-group",
        subjectId: key,
        detail: `${runs.length} genuinely active runs in one lane: ${runs
          .map((run) => `${run.id}(${run.status})`)
          .join(", ")}`,
      });
    }
    return result(violations);
  },
};

// WFI-002 — "Every accepted run must either renew its lease or become terminal."
const WFI_002: WorkflowInvariant = {
  id: "WFI-002",
  statement:
    "A run in a non-terminal status must have renewed its lease within the TTL, or have been settled terminal.",
  scope: "run-lifecycle",
  epicItem: 2,
  predicate: (snapshot) => {
    const violations: InvariantViolation[] = [];
    for (const run of snapshot.runs) {
      if (!isActiveRunStatus(run.status)) continue;
      if (!runLeaseExpired(run, snapshot.now)) continue;
      const ageMs = snapshot.now - runLeaseAnchor(run);
      violations.push({
        invariantId: "WFI-002",
        code: "WFI-002/lease-not-renewed",
        subjectKind: "run",
        subjectId: run.id,
        detail: `run is ${run.status} but its lease expired ${Math.round(
          ageMs / 1000,
        )}s ago (TTL ${Math.round(WORKFLOW_RUN_LEASE_TTL_MS / 1000)}s)`,
      });
    }
    return result(violations);
  },
};

// WFI-003 — "A task cannot be considered 'being worked' merely because an old
// run says accepted."
const WFI_003: WorkflowInvariant = {
  id: "WFI-003",
  statement:
    "An In Progress task must not rest its 'work is happening' evidence on a lease-expired non-terminal run that was never superseded.",
  scope: "run-lifecycle",
  epicItem: 2,
  predicate: (snapshot) => {
    const violations: InvariantViolation[] = [];
    const inProgress = new Map(
      snapshot.tasks
        .filter((task) => task.status === "In Progress")
        .map((task) => [task.id, task] as const),
    );
    for (const run of snapshot.runs) {
      if (!run.taskId) continue;
      const task = inProgress.get(run.taskId);
      if (!task) continue;
      if (!isActiveRunStatus(run.status)) continue;
      if (!runLeaseExpired(run, snapshot.now)) continue;
      if (successorRuns(snapshot, run, runLeaseAnchor(run)).length > 0) continue;
      violations.push({
        invariantId: "WFI-003",
        code: "WFI-003/stale-active-run-without-successor",
        subjectKind: "task",
        subjectId: task.id,
        detail: `task is In Progress and its newest run ${run.id} is still ${run.status} with an expired lease and no successor run`,
      });
    }
    return result(violations);
  },
};

// WFI-004 — "start, add subtask, clear blocker, and similar actions cannot
// finish an execution episode."
const WFI_004: WorkflowInvariant = {
  id: "WFI-004",
  statement:
    "A continuation-required workflow action must not be the action that settles a run as a successful terminal outcome.",
  scope: "turn-disposition",
  epicItem: 1,
  predicate: (snapshot) => {
    const violations: InvariantViolation[] = [];
    for (const run of snapshot.runs) {
      if (run.status !== "complete") continue;
      if (!isContinuationRequiredAction(run.settledByAction)) continue;
      const settledAt = run.completedAt ?? runLeaseAnchor(run);
      if (successorRuns(snapshot, run, settledAt).length > 0) continue;
      violations.push({
        invariantId: "WFI-004",
        code: "WFI-004/continuation-action-settled-episode",
        subjectKind: "run",
        subjectId: run.id,
        detail: `run was settled complete by continuation-required action "${run.settledByAction}" and no continuation run followed`,
      });
    }
    return result(violations);
  },
};

// WFI-005 — "Every agent turn must end with an explicit disposition."
const WFI_005: WorkflowInvariant = {
  id: "WFI-005",
  statement:
    "Every terminal run must carry an explicit disposition drawn from the closed disposition enum.",
  scope: "turn-disposition",
  epicItem: 3,
  predicate: (snapshot) => {
    const violations: InvariantViolation[] = [];
    for (const run of snapshot.runs) {
      if (!isTerminalRunStatus(run.status)) continue;
      if (run.status === "canceled") continue; // cancellation is not an agent turn ending
      if (run.disposition == null) {
        violations.push({
          invariantId: "WFI-005",
          code: "WFI-005/missing-disposition",
          subjectKind: "run",
          subjectId: run.id,
          detail: `run is ${run.status} but recorded no disposition`,
        });
        continue;
      }
      if (!isWorkflowDisposition(run.disposition)) {
        violations.push({
          invariantId: "WFI-005",
          code: "WFI-005/unknown-disposition",
          subjectKind: "run",
          subjectId: run.id,
          detail: `run recorded disposition "${run.disposition}", which is outside the closed enum`,
        });
      }
    }
    return result(violations);
  },
};

// WFI-006 — "An empty response is never successful completion."
const WFI_006: WorkflowInvariant = {
  id: "WFI-006",
  statement:
    "A run may not be complete with a successful disposition while its final response is empty and no workflow action stood in for it.",
  scope: "turn-disposition",
  epicItem: 3,
  predicate: (snapshot) => {
    const violations: InvariantViolation[] = [];
    for (const run of snapshot.runs) {
      if (run.status !== "complete") continue;
      if (!isBlank(run.finalResponseText)) continue;
      // A genuine workflow action IS a concrete outcome, so an empty visible
      // reply alongside one is legitimate (PM_SILENT_NO_CONTRIBUTION).
      if (run.settledByAction) continue;
      violations.push({
        invariantId: "WFI-006",
        code: "WFI-006/empty-final-response",
        subjectKind: "run",
        subjectId: run.id,
        detail:
          "run is complete with no durable final response and no workflow action to stand in for it — this is interrupted execution, not completion",
      });
    }
    return result(violations);
  },
};

// WFI-007 — "Every formal blocker must identify an external actor and an
// actionable requirement."
const WFI_007: WorkflowInvariant = {
  id: "WFI-007",
  statement:
    "Every active formal blocker must name an external actor and a concrete actionable requirement as structured data.",
  scope: "blocker",
  epicItem: 6,
  predicate: (snapshot) => {
    const violations: InvariantViolation[] = [];
    for (const blocker of snapshot.blockers) {
      if (blocker.clearedAt != null) continue;
      if (isBlank(blocker.externalActor)) {
        violations.push({
          invariantId: "WFI-007",
          code: "WFI-007/blocker-missing-external-actor",
          subjectKind: "blocker",
          subjectId: blocker.id,
          detail: `blocker on task ${blocker.taskId} names no external actor`,
        });
      }
      if (isBlank(blocker.requirement)) {
        violations.push({
          invariantId: "WFI-007",
          code: "WFI-007/blocker-missing-requirement",
          subjectKind: "blocker",
          subjectId: blocker.id,
          detail: `blocker on task ${blocker.taskId} states no actionable requirement`,
        });
      }
    }
    return result(violations);
  },
};

// WFI-008 — "An approved plan must produce a durable execution checklist
// without parsing prose."
const WFI_008: WorkflowInvariant = {
  id: "WFI-008",
  statement:
    "An approved Action Plan on an assigned task must yield a durable checklist derived from structured plan steps, never from scraped Markdown prose.",
  scope: "action-plan",
  epicItem: 4,
  predicate: (snapshot) => {
    const violations: InvariantViolation[] = [];
    for (const task of snapshot.tasks) {
      if (task.approvedOn == null) continue;
      if (!task.assigneeSlug) continue;
      if (task.planStepSource === "markdown-prose") {
        violations.push({
          invariantId: "WFI-008",
          code: "WFI-008/checklist-parsed-from-prose",
          subjectKind: "task",
          subjectId: task.id,
          detail:
            "approved plan produced its checklist by scraping rendered Markdown instead of reading structured steps",
        });
        continue;
      }
      if (task.checklistCount === 0) {
        violations.push({
          invariantId: "WFI-008",
          code: "WFI-008/plan-without-structured-steps",
          subjectKind: "task",
          subjectId: task.id,
          detail:
            "plan was approved on an assigned task but produced no durable execution checklist",
        });
      }
    }
    return result(violations);
  },
};

export const WORKFLOW_INVARIANTS: readonly WorkflowInvariant[] = [
  WFI_001,
  WFI_002,
  WFI_003,
  WFI_004,
  WFI_005,
  WFI_006,
  WFI_007,
  WFI_008,
];

export function workflowInvariantById(id: string): WorkflowInvariant | null {
  return WORKFLOW_INVARIANTS.find((invariant) => invariant.id === id) ?? null;
}

/** Run every invariant over a snapshot and return the flattened violations. */
export function evaluateWorkflowInvariants(
  snapshot: WorkflowInvariantSnapshot,
): {
  ok: boolean;
  violations: InvariantViolation[];
  byInvariant: Record<string, InvariantViolation[]>;
} {
  const violations: InvariantViolation[] = [];
  const byInvariant: Record<string, InvariantViolation[]> = {};
  for (const invariant of WORKFLOW_INVARIANTS) {
    const outcome = invariant.predicate(snapshot);
    byInvariant[invariant.id] = outcome.violations;
    violations.push(...outcome.violations);
  }
  return { ok: violations.length === 0, violations, byInvariant };
}

// ------------------------------------------------------------------
// Expected-fail baseline
// ------------------------------------------------------------------
//
// The suite is green while the observed violation set matches the recorded
// baseline EXACTLY — same codes, same counts. That gives the Epic a
// regression-sensitive gate today, and forces each fix to delete its baseline
// entry in the same commit that makes the invariant pass (an invariant that
// unexpectedly passes is reported as `unrecorded_pass`, which also fails).

export interface BaselineEntry {
  invariantId: string;
  epicItem: number;
  /** Exact code → expected occurrence count. */
  codes: Record<string, number>;
  note: string;
}

export interface InvariantBaseline {
  scenario: string;
  entries: BaselineEntry[];
}

export interface BaselineDrift {
  kind:
    | "regression"
    | "unrecorded_pass"
    | "count_mismatch"
    | "unknown_baseline_invariant";
  invariantId: string;
  code?: string;
  expected?: number;
  actual?: number;
  detail: string;
}

function countByCode(violations: InvariantViolation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    counts.set(violation.code, (counts.get(violation.code) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compare observed violations against the baseline. Empty drift = suite green.
 * Any new code, missing code, or changed count is drift.
 */
export function compareToBaseline(
  violations: InvariantViolation[],
  baseline: InvariantBaseline,
): BaselineDrift[] {
  const drift: BaselineDrift[] = [];
  const observed = countByCode(violations);
  const expected = new Map<string, { invariantId: string; count: number }>();

  for (const entry of baseline.entries) {
    if (!workflowInvariantById(entry.invariantId)) {
      drift.push({
        kind: "unknown_baseline_invariant",
        invariantId: entry.invariantId,
        detail: `baseline references ${entry.invariantId}, which is not in the registry`,
      });
      continue;
    }
    for (const [code, count] of Object.entries(entry.codes)) {
      expected.set(code, { invariantId: entry.invariantId, count });
    }
  }

  for (const [code, count] of observed) {
    const want = expected.get(code);
    if (!want) {
      drift.push({
        kind: "regression",
        invariantId: code.split("/")[0],
        code,
        actual: count,
        detail: `${count} violation(s) of ${code} are not recorded in the baseline`,
      });
      continue;
    }
    if (want.count !== count) {
      drift.push({
        kind: "count_mismatch",
        invariantId: want.invariantId,
        code,
        expected: want.count,
        actual: count,
        detail: `${code}: baseline expects ${want.count}, observed ${count}`,
      });
    }
  }

  for (const [code, want] of expected) {
    if (observed.has(code)) continue;
    drift.push({
      kind: "unrecorded_pass",
      invariantId: want.invariantId,
      code,
      expected: want.count,
      actual: 0,
      detail: `${code} no longer fires — delete its baseline entry in the same commit that fixed it`,
    });
  }

  return drift;
}
