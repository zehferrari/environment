// ORCH-09/10 — Feature flags for the V2 orchestrator comparison probe.
//
// CURRENT STATE (as of this implementation):
//   The V2 orchestrator is a COMPUTE-ONLY comparison probe. Both shadow and
//   canary modes compute the V2 decision (authorize + guard + decide) and
//   record a comparison activity alongside the actual legacy result. Neither
//   mode executes V2 transitions or procedures. The legacy path remains
//   authoritative for all mutations.
//
// Flag semantics:
//   PM_ORCHESTRATOR_V2_SHADOW=1: enable the comparison probe for ALL
//     projects. The probe computes the V2 prediction before the legacy
//     mutation and records a task.workflow.v2_shadow activity after the
//     legacy completes, with the predicted vs actual status and an explicit
//     matches/differences payload.
//   PM_ORCHESTRATOR_V2_PROJECTS=<slug1>,<slug2>: enable the comparison probe
//     for the allowlisted projects only. Same behavior as shadow — compute
//     and record, no V2 mutations. The activity kind is v2_canary.
//     "*" enables the probe for all projects. This is NOT Phase E — no V2
//     transitions are executed. It is a comparison probe that produces
//     rollout evidence.
//   No flags set: no probe, zero overhead.
//
// FUTURE PHASES (not yet implemented):
//   Phase C: effectful procedure canary — V2 procedures own worktree prep
//     and notifications for allowlisted projects. Repository validation and
//     finalization jobs already carry procedure/step/cycle correlation; this
//     phase still requires rollout ownership and compensation verification.
//   Phase E: V2 owns transitions — legacy paths removed. Requires all
//     entry points migrated and all safety gates replicated in the V2
//     orchestrator.

/** Shadow mode: enable the comparison probe for all projects. */
export function orchestratorShadowEnabled(): boolean {
  return process.env.PM_ORCHESTRATOR_V2_SHADOW === "1";
}

/**
 * Project allowlist for the comparison probe. When set, the probe runs
 * for the allowlisted projects. This is NOT Phase E — no V2 transitions
 * are executed.
 */
export function orchestratorV2Projects(): Set<string> {
  const raw = process.env.PM_ORCHESTRATOR_V2_PROJECTS ?? "";
  if (!raw.trim()) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Check if a project is in the V2 comparison probe allowlist.
 * "*" enables the probe for all projects.
 */
export function isV2EnabledForProject(projectSlug: string): boolean {
  const projects = orchestratorV2Projects();
  if (projects.size === 0) return false;
  if (projects.has("*")) return true;
  return projects.has(projectSlug);
}

/**
 * Check if the V2 comparison probe should compute a decision for this
 * project. Returns true if either shadow mode or canary mode is active.
 * The probe is COMPUTE-ONLY — it never executes V2 transitions.
 */
export function shouldComputeV2Decision(projectSlug: string): boolean {
  return orchestratorShadowEnabled() || isV2EnabledForProject(projectSlug);
}

/**
 * Check if the V2 comparison probe should record a canary activity (vs
 * shadow activity). Both modes compute only; the difference is the
 * activity kind and the project scoping.
 */
export function shouldRecordV2CanaryComparison(projectSlug: string): boolean {
  if (orchestratorShadowEnabled()) return false; // shadow records v2_shadow, not v2_canary
  return isV2EnabledForProject(projectSlug);
}
