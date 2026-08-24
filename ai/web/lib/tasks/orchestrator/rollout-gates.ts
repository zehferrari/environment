import { orchestratorV2MutationProjects } from "@/lib/tasks/orchestrator/flags";

export const ROLLOUT_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const LEGACY_ROLLOUT_EVIDENCE_SCHEMA_VERSION = 1 as const;

type RolloutChecks = {
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

export type ProductionCohortEvidence = {
  stage: "e3_production_canary" | "e4_project_expansion";
  deployedEpicSha: string;
  taskIdsOrKeys: string[];
  mutationSetting: {
    name: "PM_ORCHESTRATOR_V2_MUTATION_PROJECTS";
    before: string[];
    after: string[];
  };
  comparisonSetting: {
    shadowEnabled: boolean;
    projects: string[];
  };
  approval: {
    taskId: string;
    ownerUsername: string;
    approvedAt: string;
    authorizationCommentId: string;
  };
  observationWindow: {
    startsAt: string;
    minimumMinutes: number;
  };
  rollbackAction: string;
  stopConditions: string[];
  baselineArtifacts: {
    cohortReport: string;
    engineDistribution: string;
    legacyInvocationCounter: string;
    callbackCorrelation: string;
  };
  previousCohortObservation?: {
    evidenceId: string;
    projectSlug: string;
    completedAt: string;
    artifact: string;
  };
};

export type RolloutEvidence = {
  schemaVersion:
    | typeof LEGACY_ROLLOUT_EVIDENCE_SCHEMA_VERSION
    | typeof ROLLOUT_EVIDENCE_SCHEMA_VERSION;
  evidenceId: string;
  generatedAt: string;
  targetProjectSlug: string;
  mode: "e2_internal_canary" | "project_cohort";
  syntheticPrivateProject: boolean;
  checks: RolloutChecks;
  ownership: {
    backupOwner: string;
    rollbackOwner: string;
    onCallOwner: string;
  };
  artifacts: string[];
  productionCohort?: ProductionCohortEvidence;
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

function validTimestamp(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function normalizedUnique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function evaluateObservationWindow(
  evidence: RolloutEvidence,
  now = new Date(),
): { applicable: boolean; complete: boolean; startsAt: string | null; endsAt: string | null; remainingMinutes: number } {
  const window = evidence.productionCohort?.observationWindow;
  if (evidence.mode !== "project_cohort" || !window || !validTimestamp(window.startsAt) || !Number.isFinite(window.minimumMinutes)) {
    return { applicable: false, complete: false, startsAt: null, endsAt: null, remainingMinutes: 0 };
  }
  const startsAtMs = Date.parse(window.startsAt);
  const endsAtMs = startsAtMs + Math.max(0, window.minimumMinutes) * 60_000;
  return {
    applicable: true,
    complete: now.getTime() >= endsAtMs,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    remainingMinutes: Math.max(0, Math.ceil((endsAtMs - now.getTime()) / 60_000)),
  };
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
  const production = evidence.productionCohort;
  const targetTasks = normalizedUnique(production?.taskIdsOrKeys);
  const stopConditions = normalizedUnique(production?.stopConditions);
  const requiredStopConditions = [...PHASE_E_STOP_CONDITIONS];
  const exactStopConditionSet =
    stopConditions.length === requiredStopConditions.length &&
    requiredStopConditions.every((condition) => stopConditions.includes(condition));
  const approvalRecorded = Boolean(
    production?.approval.taskId.trim() &&
    production?.approval.ownerUsername.trim() &&
    production?.approval.authorizationCommentId.trim() &&
    validTimestamp(production?.approval.approvedAt),
  );
  const observationWindowRecorded = Boolean(
    validTimestamp(production?.observationWindow.startsAt) &&
    Number.isInteger(production?.observationWindow.minimumMinutes) &&
    (production?.observationWindow.minimumMinutes ?? 0) > 0,
  );
  const approvalAtMs = Date.parse(production?.approval.approvedAt ?? "");
  const generatedAtMs = Date.parse(evidence.generatedAt);
  const observationStartsAtMs = Date.parse(production?.observationWindow.startsAt ?? "");
  const rolloutTimeOrderValid = [approvalAtMs, generatedAtMs, observationStartsAtMs].every(Number.isFinite) &&
    approvalAtMs <= generatedAtMs && generatedAtMs <= observationStartsAtMs;
  const mutationSettingRecorded = Boolean(
    production?.mutationSetting.name === "PM_ORCHESTRATOR_V2_MUTATION_PROJECTS" &&
    normalizedUnique(production?.mutationSetting.after).includes(evidence.targetProjectSlug) &&
    !normalizedUnique(production?.mutationSetting.after).includes("*")
  );
  const mutationBefore = normalizedUnique(production?.mutationSetting.before);
  const mutationAfter = normalizedUnique(production?.mutationSetting.after);
  const newlyEnabledProjects = mutationAfter.filter((project) => !mutationBefore.includes(project));
  const oneProjectChange =
    newlyEnabledProjects.length === 1 &&
    newlyEnabledProjects[0] === evidence.targetProjectSlug &&
    mutationBefore.every((project) => mutationAfter.includes(project));
  const configuredMatchesApprovedAfter =
    configured.length === mutationAfter.length &&
    configured.every((project, index) => project === [...mutationAfter].sort()[index]);
  const comparisonRecorded = Boolean(
    production?.comparisonSetting.shadowEnabled ||
    normalizedUnique(production?.comparisonSetting.projects).includes(evidence.targetProjectSlug) ||
    normalizedUnique(production?.comparisonSetting.projects).includes("*"),
  );
  const deployedEpicShaRecorded = /^[0-9a-f]{40}$/i.test(production?.deployedEpicSha ?? "");
  const baselineArtifactsRecorded = Boolean(
    production?.baselineArtifacts.cohortReport.trim() &&
    production?.baselineArtifacts.engineDistribution.trim() &&
    production?.baselineArtifacts.legacyInvocationCounter.trim() &&
    production?.baselineArtifacts.callbackCorrelation.trim(),
  );
  const previousObservation = production?.previousCohortObservation;
  const previousObservationRecorded = Boolean(
    previousObservation?.evidenceId.trim() &&
    previousObservation?.projectSlug.trim() &&
    previousObservation?.artifact.trim() &&
    validTimestamp(previousObservation?.completedAt) &&
    previousObservation?.projectSlug !== evidence.targetProjectSlug &&
    Date.parse(previousObservation?.completedAt ?? "") <= approvalAtMs &&
    evidence.artifacts.includes(previousObservation?.artifact ?? ""),
  );

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

  if (evidence.mode === "project_cohort") {
    gates.push(
      boolGate(
        "production_evidence_schema",
        evidence.schemaVersion === ROLLOUT_EVIDENCE_SCHEMA_VERSION && Boolean(production),
        "The production cohort uses the current evidence schema.",
        "Production cohorts require schemaVersion 2 and productionCohort evidence.",
      ),
      boolGate(
        "exact_task_cohort",
        targetTasks.length > 0 && targetTasks.length === (production?.taskIdsOrKeys.length ?? 0),
        "The production cohort names a non-empty exact task set without duplicate selectors.",
        "Production admission requires a non-empty exact taskIdsOrKeys set without duplicate/blank selectors.",
      ),
      boolGate(
        "small_e3_cohort",
        production?.stage !== "e3_production_canary" || targetTasks.length <= 5,
        "The E3 canary is limited to at most five exact tasks.",
        "The E3 production canary may contain at most five exact tasks.",
      ),
      boolGate(
        "effectful_setting_change",
        mutationSettingRecorded,
        "The independent effectful allowlist change is recorded and includes the target project.",
        "Record PM_ORCHESTRATOR_V2_MUTATION_PROJECTS before/after values with the target project in after.",
      ),
      boolGate(
        "one_project_cohort_change",
        oneProjectChange,
        "Exactly one target project is added to the effectful allowlist.",
        "Each E3/E4 round must add exactly the named target project and preserve prior explicit projects.",
      ),
      boolGate(
        "configured_cohort_matches_approval",
        configuredMatchesApprovedAfter,
        "The deployed mutation cohort exactly matches the owner-approved after set.",
        "PM_ORCHESTRATOR_V2_MUTATION_PROJECTS must exactly match productionCohort.mutationSetting.after.",
      ),
      boolGate(
        "comparison_probe_separate",
        comparisonRecorded,
        "Compute-only comparison remains independently enabled for the target.",
        "Record PM_ORCHESTRATOR_V2_SHADOW or PM_ORCHESTRATOR_V2_PROJECTS coverage separately from mutation admission.",
      ),
      boolGate(
        "deployed_epic_sha",
        deployedEpicShaRecorded,
        "The exact deployed Epic SHA is recorded.",
        "Record the deployed 40-character Epic SHA before production admission.",
      ),
      boolGate(
        "owner_go_no_go",
        approvalRecorded,
        "The active-owner go/no-go decision reference is recorded.",
        "Record the owner username, approval timestamp, and authorization comment id.",
      ),
      boolGate(
        "observation_window",
        observationWindowRecorded,
        "The cohort observation window is recorded.",
        "Record a valid startsAt and a positive integer minimumMinutes.",
      ),
      boolGate(
        "rollout_time_order",
        rolloutTimeOrderValid,
        "Owner approval precedes evidence generation and the observation start.",
        "Require approvedAt <= generatedAt <= observationWindow.startsAt; backdated observation is forbidden.",
      ),
      boolGate(
        "rollback_action",
        Boolean(production?.rollbackAction.trim()),
        "The admission rollback action is recorded.",
        "Record the exact rollback action before production admission.",
      ),
      boolGate(
        "complete_stop_condition_set",
        exactStopConditionSet,
        "Every Phase E stop condition is explicitly acknowledged.",
        "The production cohort must name the complete Phase E stop-condition set with no extras.",
      ),
      boolGate(
        "baseline_artifact_set",
        baselineArtifactsRecorded,
        "Cohort, engine, legacy-invocation, and callback baselines are retained.",
        "Record retained cohort report, engine distribution, legacy-invocation counter, and callback-correlation artifacts.",
      ),
      boolGate(
        "previous_cohort_observed",
        production?.stage !== "e4_project_expansion" || previousObservationRecorded,
        "The previous cohort observation is complete (or this is E3).",
        "E4 requires the prior cohort evidence id, project, completion timestamp, and retained artifact.",
      ),
    );
  }

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
  if (
    evidence.schemaVersion !== LEGACY_ROLLOUT_EVIDENCE_SCHEMA_VERSION &&
    evidence.schemaVersion !== ROLLOUT_EVIDENCE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported rollout evidence schemaVersion.");
  }
  if (!evidence.evidenceId || !evidence.targetProjectSlug || !evidence.generatedAt) throw new Error("Rollout evidence identity is incomplete.");
  if (evidence.mode !== "e2_internal_canary" && evidence.mode !== "project_cohort") throw new Error("Rollout evidence mode is invalid.");
  if (evidence.mode === "project_cohort" && evidence.schemaVersion !== ROLLOUT_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Production project cohorts require rollout evidence schemaVersion 2.");
  }
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
  if (evidence.mode === "project_cohort") {
    const production = evidence.productionCohort;
    if (
      !production ||
      (production.stage !== "e3_production_canary" && production.stage !== "e4_project_expansion") ||
      typeof production.deployedEpicSha !== "string" ||
      !isStringArray(production.taskIdsOrKeys) ||
      !production.mutationSetting ||
      production.mutationSetting.name !== "PM_ORCHESTRATOR_V2_MUTATION_PROJECTS" ||
      !isStringArray(production.mutationSetting.before) ||
      !isStringArray(production.mutationSetting.after) ||
      !production.comparisonSetting ||
      typeof production.comparisonSetting.shadowEnabled !== "boolean" ||
      !isStringArray(production.comparisonSetting.projects) ||
      !production.approval ||
      typeof production.approval.taskId !== "string" ||
      typeof production.approval.ownerUsername !== "string" ||
      typeof production.approval.approvedAt !== "string" ||
      typeof production.approval.authorizationCommentId !== "string" ||
      !production.observationWindow ||
      typeof production.observationWindow.startsAt !== "string" ||
      typeof production.observationWindow.minimumMinutes !== "number" ||
      typeof production.rollbackAction !== "string" ||
      !isStringArray(production.stopConditions) ||
      !production.baselineArtifacts ||
      typeof production.baselineArtifacts.cohortReport !== "string" ||
      typeof production.baselineArtifacts.engineDistribution !== "string" ||
      typeof production.baselineArtifacts.legacyInvocationCounter !== "string" ||
      typeof production.baselineArtifacts.callbackCorrelation !== "string" ||
      (production.previousCohortObservation !== undefined && (
        typeof production.previousCohortObservation.evidenceId !== "string" ||
        typeof production.previousCohortObservation.projectSlug !== "string" ||
        typeof production.previousCohortObservation.completedAt !== "string" ||
        typeof production.previousCohortObservation.artifact !== "string"
      ))
    ) {
      throw new Error("Production cohort evidence is incomplete.");
    }
  }
}
