// ENV-120 — the deterministic gate in front of a human-blocked state.
//
// Every rule that can refuse a formal blocker is exercised here against pure
// fixtures. If this suite passes, "is this a real blocker?" is a decision the
// code makes the same way every time, not a per-turn judgement call.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES,
  FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS,
  blockerDiagnosticsFingerprint,
  blockerFailureSignature,
  blockerMetadataFromPayload,
  blockerRoundClosesOnGrant,
  classifyBlockerFailure,
  formalBlockerReportFromValue,
  validateFormalBlockerReport,
} from "../lib/tasks/formal-blocker";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const ASSIGNEE = { assigneeIdentifiers: ["barekbaal", "barekbaal-irwin", "user_123"] };

function humanBlocker(overrides: Record<string, unknown> = {}) {
  return {
    blockedOn: "person",
    requestedActor: "@zeh",
    requestedAction: "Add the b@zeh.me account to the Ergon billing portal.",
    evidence: "portal login returns 'account not linked' for b@zeh.me (HTTP 200, no session cookie set)",
    diagnosticsAttempted: ["Retried the documented credentials from the task context verbatim."],
    resumeCondition: "The b@zeh.me account can list bills in the Ergon portal.",
    reporterCanResolve: false,
    ...overrides,
  };
}

function serviceBlocker(overrides: Record<string, unknown> = {}) {
  return {
    blockedOn: "external_service",
    requestedActor: "the release host operator",
    requestedAction: "Restore SSH push access for the PM deploy key.",
    evidence: "git push -> Permission denied (publickey) from release-host:22",
    diagnosticsAttempted: [
      "Confirmed the same key authenticates against the origin remote.",
      "Re-ran the push from a clean agent socket.",
    ],
    resumeCondition: "git push to release-host succeeds for the PM deploy key.",
    reporterCanResolve: false,
    ...overrides,
  };
}

// ---------------- shape validation ----------------

assert.equal(validateFormalBlockerReport(humanBlocker()).ok, true, "a complete report validates");

const shapeCases: [unknown, string][] = [
  [undefined, "missing_report"],
  ["a wall of prose", "missing_report"],
  [humanBlocker({ blockedOn: "vibes" }), "unknown_blocked_on"],
  [humanBlocker({ requestedActor: "   " }), "missing_requested_actor"],
  [humanBlocker({ requestedAction: "" }), "missing_requested_action"],
  [humanBlocker({ evidence: "" }), "missing_evidence"],
  [humanBlocker({ diagnosticsAttempted: [] }), "no_diagnostics_attempted"],
  [humanBlocker({ diagnosticsAttempted: ["", "   "] }), "no_diagnostics_attempted"],
  [humanBlocker({ diagnosticsAttempted: "tried stuff" }), "no_diagnostics_attempted"],
  [humanBlocker({ resumeCondition: "" }), "missing_resume_condition"],
  [humanBlocker({ resumeCondition: "resolved" }), "resume_condition_not_concrete"],
  [humanBlocker({ resumeCondition: "when fixed" }), "resume_condition_not_concrete"],
  [humanBlocker({ resumeCondition: "asap" }), "resume_condition_not_concrete"],
];
for (const [input, expected] of shapeCases) {
  const outcome = validateFormalBlockerReport(input);
  assert.equal(outcome.ok, false, `${expected}: must not validate`);
  assert.equal(outcome.ok === false && outcome.rule, expected, `expected rule ${expected}`);
}

// Duplicate diagnoses collapse: two spellings of one attempt are one attempt.
const deduped = validateFormalBlockerReport(
  humanBlocker({ diagnosticsAttempted: ["Retried  the login", "retried the login", "Checked DNS"] }),
);
assert.equal(deduped.ok, true, "the deduped report still validates");
assert.deepEqual(
  deduped.ok && deduped.report.diagnosticsAttempted,
  ["Retried the login", "Checked DNS"],
  "diagnostics are normalized and deduplicated, so padding the list cannot buy an escalation",
);

// ---------------- self-directed blockers ----------------

for (const actor of ["barekbaal", "@barekbaal", "  BAREKBAAL ", "me", "myself", "self", "the assignee", "user_123"]) {
  const outcome = classifyBlockerFailure(humanBlocker({ requestedActor: actor }), ASSIGNEE);
  assert.equal(outcome.outcome, "reject", `"${actor}" is the assignee, so it cannot be a blocker`);
  assert.equal(
    outcome.outcome === "reject" && outcome.rule,
    "requested_actor_is_assignee",
    `"${actor}" must fire the self-directed rule`,
  );
}

// ---------------- human classes are never incidents ----------------

for (const blockedOn of ["person", "permission", "decision"]) {
  const outcome = classifyBlockerFailure(humanBlocker({ blockedOn }), ASSIGNEE);
  assert.equal(outcome.outcome, "accept", `${blockedOn} is a human dependency, so it is accepted as a blocker`);
}

// ---------------- recoverable technical failures ----------------

const firstError = classifyBlockerFailure(
  serviceBlocker({
    evidence: "browser.act timed out after 30s waiting for the login form",
    diagnosticsAttempted: ["Took one snapshot of the page."],
  }),
  ASSIGNEE,
);
assert.equal(firstError.outcome, "incident", "a first browser/tool error is an internal incident, not a blocker");
assert.equal(
  firstError.outcome === "incident" && firstError.rule,
  "retry_with_fresh_session",
  "a retryable fault shape names the fresh-session rule",
);

const opaqueFailure = classifyBlockerFailure(
  serviceBlocker({
    evidence: "the vendor API returned an unexpected payload shape",
    diagnosticsAttempted: ["Logged the response body."],
  }),
  ASSIGNEE,
);
assert.equal(opaqueFailure.outcome, "incident", "a single un-diagnosed technical failure stays internal");
assert.equal(
  opaqueFailure.outcome === "incident" && opaqueFailure.rule,
  "recoverable_tool_failure",
  "a non-retryable-shaped single failure names the recoverable rule",
);

// Distinct diagnoses without a prior incident round is still not enough.
assert.equal(
  classifyBlockerFailure(serviceBlocker(), { ...ASSIGNEE, priorDistinctDiagnostics: 0 }).outcome,
  "incident",
  `${FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS} earlier incident round with different evidence is required before escalation`,
);

// A prior round alone is not enough either: THIS report must also be diagnosed.
assert.equal(
  classifyBlockerFailure(
    serviceBlocker({ diagnosticsAttempted: ["Looked at it once."] }),
    { ...ASSIGNEE, priorDistinctDiagnostics: 3 },
  ).outcome,
  "incident",
  `escalation needs ${FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES} distinct diagnoses in the report itself`,
);

// Bounded policy satisfied: distinct diagnoses now, distinct evidence before.
const earned = classifyBlockerFailure(serviceBlocker(), { ...ASSIGNEE, priorDistinctDiagnostics: 1 });
assert.equal(earned.outcome, "accept", "distinct diagnoses after a distinct earlier incident round escalate");

// Elapsed retries can never substitute for distinct evidence: repeating one
// diagnosis produces one fingerprint, so priorDistinctDiagnostics cannot grow.
const repeated = serviceBlocker({ diagnosticsAttempted: ["Re-ran the push.", "re-ran the push"] });
assert.equal(
  classifyBlockerFailure(repeated, { ...ASSIGNEE, priorDistinctDiagnostics: 1 }).outcome,
  "incident",
  "the same diagnosis repeated is one diagnosis, however many times it was retried",
);

// ---------------- fingerprints ----------------

const reportA = formalBlockerReportFromValue(serviceBlocker());
const reportB = formalBlockerReportFromValue(serviceBlocker({ diagnosticsAttempted: ["Checked the host firewall."] }));
assert(reportA && reportB, "both fixtures parse back into reports");
assert.equal(
  blockerFailureSignature(reportA),
  blockerFailureSignature(reportB),
  "the same observed failure keeps one signature across rounds",
);
const reportWithImprovedEvidence = formalBlockerReportFromValue(serviceBlocker({
  evidence: "A fresh browser and an independent host both reproduce ERR_CONNECTION_RESET after TLS succeeds.",
}));
assert(reportWithImprovedEvidence, "the improved-evidence fixture parses back into a report");
assert.equal(
  blockerFailureSignature(reportA),
  blockerFailureSignature(reportWithImprovedEvidence),
  "improving the evidence paragraph must not make the same external dependency look like a new incident",
);
const reportForAnotherOwner = formalBlockerReportFromValue(serviceBlocker({
  requestedActor: "the identity-provider operator",
}));
assert(reportForAnotherOwner, "the different-owner fixture parses back into a report");
assert.notEqual(
  blockerFailureSignature(reportA),
  blockerFailureSignature(reportForAnotherOwner),
  "a different external dependency owner starts a separate incident group",
);
assert.notEqual(
  blockerDiagnosticsFingerprint(reportA),
  blockerDiagnosticsFingerprint(reportB),
  "a different diagnosis is a different fingerprint, which is what earns escalation",
);
assert.equal(
  blockerDiagnosticsFingerprint(reportA),
  blockerDiagnosticsFingerprint(formalBlockerReportFromValue(
    serviceBlocker({ diagnosticsAttempted: [...serviceBlocker().diagnosticsAttempted].reverse() }),
  )!),
  "the fingerprint is order-independent, so reshuffling a list is not new evidence",
);

// ---------------- payload round-trip and backward compatibility ----------------

const persisted = blockerMetadataFromPayload(JSON.stringify({
  action: "flag_blocker",
  commentId: "comment-1",
  blockerReport: serviceBlocker(),
}));
assert.equal(persisted.commentId, "comment-1", "the raising comment id still resolves");
assert.equal(
  persisted.report?.requestedActor,
  "the release host operator",
  "the structured report survives the payload round-trip",
);

const legacy = blockerMetadataFromPayload(JSON.stringify({ action: "flag_blocker", commentId: "old-1" }));
assert.equal(legacy.commentId, "old-1", "a pre-ENV-120 row is still readable");
assert.equal(legacy.report, null, "a pre-ENV-120 row simply carries no report");
assert.equal(
  formalBlockerReportFromValue({ blockedOn: "person", requestedActor: "@zeh" }),
  null,
  "a half-written report never parses into a valid one",
);

// ---------------- permission round closure ----------------

assert.equal(
  blockerRoundClosesOnGrant("reporter_approval"),
  true,
  "a reporter_approval grant IS the whole dependency, so the round closes with it",
);
assert.equal(
  blockerRoundClosesOnGrant("publish_checkpoint"),
  false,
  "a checkpoint round stays resolvable from the active blocker until its attempt settles",
);

// ---------------- the route actually enforces this ----------------

const route = read("lib/tasks/orchestrator/agent-route-adapter.ts");
const intents = read("lib/tasks/orchestrator/intents/index.ts");
assert(
  route.includes("classifyBlockerFailure("),
  "flag_blocker must classify the report rather than trusting the prose comment",
);
assert(
  route.includes('kind: "task.blocker.incident"'),
  "a recoverable failure must land as an internal incident row",
);
assert(
  intents.includes("blockerReport: report"),
  "the accepted report must be persisted on the task.blocker activity row",
);
assert(
  /status: 422/.test(route),
  "a refused blocker answers 422 with the rule that fired",
);

console.log("formal-blocker-validation-test: ok");


const contractDefect = serviceBlocker({
  blockedOn: "dependency",
  requestedActor: "zeh",
  requestedAction: "Fix generateTransactionKey in the v23 repository and redeploy dev_CBA-PaySession; this task owns only the Patricia worktree.",
  evidence: "The browser payment returned gateway HTTP 400 INVALID_REQUEST: transactionid length is 50 characters but must be less than 41.",
  diagnosticsAttempted: [
    "Read CBA-PaySession.js line 126 in origin/greenid-simplekyc: generateTransactionKey concatenates a timestamp and UUID.",
    "Evaluated the source expression locally under node: output length 50; the gateway limit is 40.",
  ],
  resumeCondition: "dev_CBA-PaySession runs the published fix producing transaction IDs of at most 40 characters.",
});
assert.equal(classifyBlockerFailure(contractDefect, ASSIGNEE).outcome, "accept", "a source-proven contract violation does not need another payment attempt");
assert.equal(classifyBlockerFailure({ ...contractDefect, requestedActor: "barekbaal" }, ASSIGNEE).outcome, "reject", "deterministic defects do not waive self-actionability");
assert.equal(classifyBlockerFailure({ ...contractDefect, diagnosticsAttempted: ["Saw the browser error once"] }, ASSIGNEE).outcome, "incident", "a single validation error alone is not diagnosed");
const browserMention = classifyBlockerFailure(serviceBlocker({ evidence: "The browser displayed a vendor validation error", diagnosticsAttempted: ["Read the response"] }), ASSIGNEE);
assert.equal(browserMention.outcome === "incident" && browserMention.rule, "recoverable_tool_failure", "mentioning a browser is not a transient browser failure");
assert.ok(browserMention.outcome === "incident" && !browserMention.guidance.includes("Retry with a fresh session"), "non-transient errors must not demand a fresh side-effecting request");

assert.equal(classifyBlockerFailure({ ...contractDefect, diagnosticsAttempted: [
  "git inspection of CBA-PaySession.js line 126",
  "node evaluation of generateTransactionKey: length 50",
] }, ASSIGNEE).outcome, "accept", "PH-192's actual local-evaluation wording also qualifies without another payment");
