export const HUMAN_ROLES = ["owner", "admin", "customer"] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];

export const AGENT_VISIBILITY_MODES = ["full", "masked", "hidden"] as const;
export type AgentVisibilityMode = (typeof AGENT_VISIBILITY_MODES)[number];

export type HumanRoleSource = {
  kind: string;
  isOwner: boolean;
  rolePermission?: { name: string } | null;
};

export type OwnerCapabilitySource = {
  kind?: string | null;
  isOwner?: boolean | null;
  status?: string | null;
};

/**
 * `isOwner` is the immutable capability. A RolePermission row can describe it
 * but can never manufacture or revoke it.
 */
export function hasImmutableOwnerCapability<T extends OwnerCapabilitySource>(
  subject: T | null | undefined,
): subject is T & { kind: "human"; isOwner: true } {
  return Boolean(subject?.kind === "human" && subject.isOwner);
}

export function isActiveOwnerPrincipal<T extends OwnerCapabilitySource>(
  subject: T | null | undefined,
): subject is T & { kind: "human"; isOwner: true; status: "active" } {
  return hasImmutableOwnerCapability(subject) && subject?.status === "active";
}

/**
 * Resolve the only three human roles. Missing/legacy non-owner roles fail
 * closed to Customer; agent accounts never receive a human role.
 */
export function resolveHumanRole(subject: HumanRoleSource): HumanRole | null {
  if (subject.kind !== "human") return null;
  if (hasImmutableOwnerCapability(subject)) return "owner";
  return subject.rolePermission?.name === "admin" ? "admin" : "customer";
}

export function agentVisibilityForRole(role: HumanRole | null): AgentVisibilityMode {
  if (role === "owner") return "full";
  if (role === "admin") return "masked";
  return "hidden";
}

export function hasRole(subject: { role: HumanRole | null }, role: HumanRole): boolean {
  return subject.role === role;
}

export function hasOwnerRole(subject: { role: HumanRole | null }): boolean {
  return hasRole(subject, "owner");
}

export function hasAdminRole(subject: { role: HumanRole | null }): boolean {
  return hasRole(subject, "admin");
}

export function hasCustomerRole(subject: { role: HumanRole | null }): boolean {
  return hasRole(subject, "customer");
}
