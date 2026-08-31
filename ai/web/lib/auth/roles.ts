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

export type ViewerExperience = {
  /** The Customer DOM must contain no internal operations surface at all. */
  customerSafe: boolean;
  /** Project-scoped workflow context is available to Owner and Admin. */
  canViewProjectWorkflow: boolean;
  /** Customer access management is global for Owner and scoped for Admin. */
  canManageCustomerAccess: boolean;
  /** Fleet presence, direct agent chat, and global administration stay Owner-only. */
  canViewGlobalAgentOperations: boolean;
};

const TASK_DETAIL_TABS = [
  "Description",
  "Action Plan",
  "Sub-Tasks",
  "Attachments",
  "Comments",
  "Activities",
  "Development",
  "Changes",
] as const;
const EPIC_DETAIL_TABS = [
  "Description",
  "Action Plan",
  "Tasks",
  "Attachments",
  "Comments",
  "Activities",
  "Development",
  "Changes",
] as const;
const CUSTOMER_HIDDEN_TASK_TABS = new Set([
  "Action Plan",
  "Sub-Tasks",
  "Activities",
  "Development",
  "Changes",
]);
const CUSTOMER_HIDDEN_EPIC_TABS = new Set([
  "Action Plan",
  "Activities",
  "Development",
  "Changes",
]);

/**
 * The client experience is derived once from HumanRole. Components consume
 * these capabilities instead of growing parallel isOwner/non-owner rules.
 */
export function viewerExperienceForRole(role: HumanRole | null): ViewerExperience {
  return {
    customerSafe: role === "customer" || role === null,
    canViewProjectWorkflow: role === "owner" || role === "admin",
    canManageCustomerAccess: role === "owner" || role === "admin",
    canViewGlobalAgentOperations: role === "owner",
  };
}

export function taskDetailTabsForRole(role: HumanRole | null, hasDeployment: boolean): string[] {
  const experience = viewerExperienceForRole(role);
  return TASK_DETAIL_TABS.filter((tab) => (
    (tab !== "Development" || hasDeployment)
    && (!experience.customerSafe || !CUSTOMER_HIDDEN_TASK_TABS.has(tab))
  ));
}

export function epicDetailTabsForRole(role: HumanRole | null, hasDeployment: boolean): string[] {
  const experience = viewerExperienceForRole(role);
  return EPIC_DETAIL_TABS.filter((tab) => (
    (tab !== "Development" || hasDeployment)
    && (!experience.customerSafe || !CUSTOMER_HIDDEN_EPIC_TABS.has(tab))
  ));
}

export function customerSafeWorkflowLabel(status: string, customerSafe: boolean): string {
  return customerSafe && status === "Review" ? "Ready" : status;
}
