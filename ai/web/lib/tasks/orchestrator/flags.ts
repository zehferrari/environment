// Phase E retained operator admission control.
//
// Durable task ownership is authoritative. The former shadow/canary
// comparison flags were compute-only rollout scaffolding and are retired.

function parseProjectAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function orchestratorV2MutationProjects(): Set<string> {
  return parseProjectAllowlist(process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS);
}

export function isV2MutationAdmissionEnabledForProject(projectSlug: string): boolean {
  const projects = orchestratorV2MutationProjects();
  return projects.has("*") || projects.has(projectSlug);
}
