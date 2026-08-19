import { orchestratorV2MutationProjects } from "@/lib/tasks/orchestrator/flags";

export const ROLLOUT_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type RolloutEvidence = {
  schemaVersion: typeof ROLLOUT_EVIDENCE_SCHEMA_VERSION;
  evidenceId: string;
  generatedAt: string;
  targetProjectSlug: string;
  mode: "e2_internal_canary" | "project_cohort";
  syntheticPrivateProject: boolean;
  checks: {
    migrations: boolean;
    typecheck: boolean;
    workflowSuite: boolean;
    phaseESuites: boolean;
    build: boolean;
    lint: boolean;
    procedureHandlerIdempotency: boolean;
    callbackV2Correlation: boolean;
    comparisonParity: boolean;
    doctorInvariants: boolean;
  };
  ownership: {
    backupOwner: string;
    rollbackOwner: string;
    onCallOwner: string;
  };
  artifacts: string[];
};

export type RolloutGate = {
  id: string;
  passed: boolean;
  detail: string;
};

export type RolloutGateReport = {
  ready: boolean;
  evidenceId: string;
  targetProjectSlug: string;
  configuredMutationProjects: string[];
  gates: RolloutGate[];
  stopConditions: readonly string[];
};

export const PHASE_E_STOP_CONDITIONS = [
  "decision_actor_is_mechanical_executor",
  "dual_authoritative_mutation",
  "command_missing_procedure_or_continuation",
  "idempotency_evidence_conflict",
  "stale_callback_mutated_active_cycle",
  "accepted_review_evidence_reused_or_reset",
  "duplicate_mechanical_effect",
  "lost_execution_continuation",
  "rollback_routed_active_v2_to_legacy",
  "doctor_engine_cycle_receipt_contradiction",
] as const;

function boolGate(id: string, passed: boolean, success: string, failure: string): RolloutGate {
  return { id, passed, detail: passed ? success : failure };
}

/**
 * Evaluate the complete effectful-admission preflight. Admission callers must
 * refuse to pin when any gate fails; compute-only flags are intentionally not
 * consulted here.
 */
export function evaluateRolloutGates(
  evidence: RolloutEvidence,
  configuredMutationProjects = orchestratorV2MutationProjects(),
): RolloutGateReport {
  const configured = [...configuredMutationProjects].sort();
  const exactInternalCanaryCohort = evidence.mode !== "e2_internal_canary" || (
    configured.length === 1 &&
    configured[0] === evidence.targetProjectSlug &&
    !configuredMutationProjects.has("*")
  );
  const ownershipRecorded = [
    evidence.ownership.backupOwner,
    evidence.ownership.rollbackOwner,
    evidence.ownership.onCallOwner,
  ].every((value) => value.trim().length > 0);

  const gates: RolloutGate[] = [
    boolGate(
      "target_in_effectful_cohort",
      configuredMutationProjects.has("*") || configuredMutationProjects.has(evidence.targetProjectSlug),
      "The target project is in PM_ORCHESTRATOR_V2_MUTATION_PROJECTS.",
      "The target project is not in PM_ORCHESTRATOR_V2_MUTATION_PROJECTS.",
    ),
    boolGate(
      "single_internal_canary_cohort",
      exactInternalCanaryCohort,
      "The E2 cohort contains exactly one explicit project.",
      "E2 requires exactly one explicit project and forbids the wildcard cohort.",
    ),
    boolGate(
      "synthetic_private_project",
      evidence.mode !== "e2_internal_canary" || evidence.syntheticPrivateProject,
      "The E2 target is recorded as synthetic/private.",
      "E2 admission requires a synthetic/private target project.",
    ),
    boolGate("migrations", evidence.checks.migrations, "Migration validation passed.", "Migration validation is missing or failed."),
    boolGate("typecheck", evidence.checks.typecheck, "Typecheck passed.", "Typecheck is missing or failed."),
    boolGate("workflow_suite", evidence.checks.workflowSuite, "Aggregate workflow suite passed.", "Aggregate workflow suite is missing or failed."),
    boolGate("phase_e_suites", evidence.checks.phaseESuites, "Phase E suites passed.", "Phase E suites are missing or failed."),
    boolGate("build", evidence.checks.build, "Production build passed.", "Production build is missing or failed."),
    boolGate("lint", evidence.checks.lint, "Lint gate passed.", "Lint gate is missing or failed."),
    boolGate(
      "procedure_handler_idempotency",
      evidence.checks.procedureHandlerIdempotency,
      "Every admitted procedure has idempotency evidence.",
      "Procedure-handler idempotency evidence is missing or failed.",
    ),
    boolGate(
      "callback_v2_correlation",
      evidence.checks.callbackV2Correlation,
      "Schema-v2 callback correlation passed.",
      "Schema-v2 callback correlation evidence is missing or failed.",
    ),
    boolGate(
      "comparison_parity",
      evidence.checks.comparisonParity,
      "Comparison telemetry has no unexplained mismatch.",
      "Comparison parity evidence is missing or reports an unexplained mismatch.",
    ),
    boolGate(
      "doctor_invariants",
      evidence.checks.doctorInvariants,
      "Strict doctor reported no blocking Phase E invariant.",
      "Strict doctor evidence is missing or reports a blocking invariant.",
    ),
    boolGate(
      "backup_rollback_ownership",
      ownershipRecorded,
      "Backup, rollback, and on-call ownership are recorded.",
      "Backup, rollback, and on-call ownership must all be recorded.",
    ),
    boolGate(
      "retained_artifacts",
      evidence.artifacts.length > 0,
      "Preflight artifacts are retained.",
      "At least one retained preflight artifact is required.",
    ),
  ];

  return {
    ready: gates.every((gate) => gate.passed),
    evidenceId: evidence.evidenceId,
    targetProjectSlug: evidence.targetProjectSlug,
    configuredMutationProjects: configured,
    gates,
    stopConditions: PHASE_E_STOP_CONDITIONS,
  };
}

export function assertRolloutEvidence(value: unknown): asserts value is RolloutEvidence {
  if (!value || typeof value !== "object") throw new Error("Rollout evidence must be a JSON object.");
  const evidence = value as Partial<RolloutEvidence>;
  if (evidence.schemaVersion !== ROLLOUT_EVIDENCE_SCHEMA_VERSION) throw new Error("Unsupported rollout evidence schemaVersion.");
  if (!evidence.evidenceId || !evidence.targetProjectSlug || !evidence.generatedAt) throw new Error("Rollout evidence identity is incomplete.");
  if (evidence.mode !== "e2_internal_canary" && evidence.mode !== "project_cohort") throw new Error("Rollout evidence mode is invalid.");
  const requiredChecks = [
    "migrations",
    "typecheck",
    "workflowSuite",
    "phaseESuites",
    "build",
    "lint",
    "procedureHandlerIdempotency",
    "callbackV2Correlation",
    "comparisonParity",
    "doctorInvariants",
  ] as const;
  if (!evidence.checks || requiredChecks.some((key) => typeof evidence.checks?.[key] !== "boolean")) {
    throw new Error("Rollout evidence checks must include every required boolean.");
  }
  if (
    !evidence.ownership ||
    [evidence.ownership.backupOwner, evidence.ownership.rollbackOwner, evidence.ownership.onCallOwner]
      .some((owner) => typeof owner !== "string") ||
    !Array.isArray(evidence.artifacts) ||
    evidence.artifacts.some((artifact) => typeof artifact !== "string")
  ) {
    throw new Error("Rollout evidence ownership/artifacts are incomplete.");
  }
}
