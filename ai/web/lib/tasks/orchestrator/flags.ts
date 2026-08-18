// ORCH-10 — Feature flags for incremental orchestrator rollout.
//
// Phases (§17):
//   Phase A: schema and dual-write (ORCH-01) — always on.
//   Phase B: shadow decisions — PM_ORCHESTRATOR_V2_SHADOW=1. For each
//     current workflow action, compute the V2 decision and record a bounded
//     comparison activity/metric without running V2 effects.
//   Phase C: procedure canary — PM_ORCHESTRATOR_V2_PROJECTS=<slug1>,<slug2>.
//     Enable procedures for the allowlisted projects.
//   Phase D: production project canary — add a low-risk production project.
//   Phase E: default on and contract — remove legacy paths.
//
// These flags gate the orchestrator's submitWorkflowCommand so the legacy
// paths remain authoritative until the flags are enabled. The procedure
// runner and cycle dual-write (ORCH-01) are always active — they are
// additive and do not change existing behavior.

/** Shadow mode: compute V2 decisions alongside legacy paths for comparison. */
export function orchestratorShadowEnabled(): boolean {
  return process.env.PM_ORCHESTRATOR_V2_SHADOW === "1";
}

/**
 * Project allowlist for the procedure canary. When set, only tasks in the
 * listed project slugs use the V2 procedure engine for their workflow
 * transitions. Other projects continue using the legacy paths.
 */
export function orchestratorV2Projects(): Set<string> {
  const raw = process.env.PM_ORCHESTRATOR_V2_PROJECTS ?? "";
  if (!raw.trim()) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Check if a project is in the V2 canary allowlist. When the allowlist is
 * empty, V2 is NOT enabled for any project (legacy paths remain
 * authoritative). When the allowlist contains "*", V2 is enabled for all
 * projects (phase E: default on).
 */
export function isV2EnabledForProject(projectSlug: string): boolean {
  const projects = orchestratorV2Projects();
  if (projects.size === 0) return false;
  if (projects.has("*")) return true;
  return projects.has(projectSlug);
}

/**
 * Check if the orchestrator should run V2 effects for a given project, or
 * just shadow (compute + compare without effects).
 *
 * In shadow mode (PM_ORCHESTRATOR_V2_SHADOW=1), V2 decisions are computed
 * and recorded as comparison activities, but legacy paths remain
 * authoritative.
 *
 * In canary mode (PM_ORCHESTRATOR_V2_PROJECTS set), V2 effects run for
 * allowlisted projects only.
 */
export function shouldRunV2Effects(projectSlug: string): boolean {
  if (orchestratorShadowEnabled()) return false;
  return isV2EnabledForProject(projectSlug);
}

/**
 * Should the orchestrator compute a V2 decision (shadow or canary)?
 * Returns true if either shadow mode or canary mode is active for this
 * project.
 */
export function shouldComputeV2Decision(projectSlug: string): boolean {
  return orchestratorShadowEnabled() || isV2EnabledForProject(projectSlug);
}