// Single server-side decision point for human access management: invitation,
// project-access edits, and role changes (promote / demote).
//
// Pure by design — no database, no session, no UI. Callers (server actions)
// resolve the viewer, the target user, and the viewer's own project
// memberships, then hand them here; forms never make the decision. Every
// rejection carries a typed reason so tests can assert the exact guard that
// fired instead of parsing prose.
//
// Enforced matrix (see scripts/access-policy-test.ts for every cell):
//   - Owner may invite, grant/revoke access to any project, promote and
//     demote. The owner role itself is never assignable, and the Owner's own
//     status cannot be removed through user management.
//   - Admin may edit Customer targets only, never themselves, never another
//     Admin, never the Owner, and only inside the Admin's own project scope.
//     Only the Owner promotes or demotes.
//   - Customers and browser agent sessions never manage access.

import type { HumanRole } from "@/lib/auth/roles";

export const ACCESS_POLICY_INTENTS = ["invite", "access_edit", "role_change"] as const;
export type AccessPolicyIntent = (typeof ACCESS_POLICY_INTENTS)[number];

export const ACCESS_POLICY_REJECTIONS = [
  "viewer_may_not_manage_access",
  "target_not_human",
  "target_owner_immutable",
  "self_edit_forbidden",
  "target_role_forbidden",
  "role_change_owner_only",
  "owner_role_not_assignable",
  "role_required",
  "out_of_scope_project",
] as const;
export type AccessPolicyRejection = (typeof ACCESS_POLICY_REJECTIONS)[number];

/** A human or agent principal with its resolved human role (if any). */
export type AccessPolicySubject = {
  id: string;
  kind: "human" | "agent";
  role: HumanRole | null;
};

export type AccessPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: AccessPolicyRejection; message: string };

export type AccessPolicyInput = {
  intent: AccessPolicyIntent;
  /** Acting viewer, already authenticated via requireViewer. */
  viewer: AccessPolicySubject;
  /** Project memberships the viewer holds; bounds an Admin's scope. */
  viewerProjectIds: readonly string[];
  /** Existing user being edited; null when inviting a brand-new account. */
  target: AccessPolicySubject | null;
  /** Role the request asks for. "owner" is never assignable. */
  requestedRole: HumanRole | null;
  /** Project ids the request asks for (the target's full new access set). */
  requestedProjectIds: readonly string[];
};

function reject(reason: AccessPolicyRejection, message: string): AccessPolicyDecision {
  return { allowed: false, reason, message };
}

function requestedProjectsAreInScope(
  requestedProjectIds: readonly string[],
  viewerProjectIds: readonly string[],
): boolean {
  if (requestedProjectIds.length === 0) return true;
  const scope = new Set(viewerProjectIds);
  return requestedProjectIds.every((projectId) => scope.has(projectId));
}

/**
 * Evaluate an access-management request against the role/scope matrix.
 * Synchronous and side-effect free: identical inputs always yield the
 * identical decision, which is what keeps the guardrails testable.
 */
export function evaluateAccessPolicy(input: AccessPolicyInput): AccessPolicyDecision {
  const { intent, viewer, viewerProjectIds, target, requestedRole, requestedProjectIds } = input;

  // Only a human Owner or Admin may manage access at all. Customers and
  // browser agent sessions are never access managers.
  if (viewer.kind !== "human" || (viewer.role !== "owner" && viewer.role !== "admin")) {
    return reject(
      "viewer_may_not_manage_access",
      "Only the Mission Control owner or an Admin can manage access.",
    );
  }

  if (intent === "role_change") {
    // The owner role is immutable: never assignable, and the Owner's own
    // status cannot be removed through user management.
    if (requestedRole === "owner") {
      return reject(
        "owner_role_not_assignable",
        "The owner role cannot be granted through user management.",
      );
    }
    if (!requestedRole) {
      return reject("role_required", "A role is required to change someone's role.");
    }
    // Only the Owner promotes or demotes Admins.
    if (viewer.role !== "owner") {
      return reject("role_change_owner_only", "Only the Mission Control owner can promote or demote.");
    }
    if (!target || target.kind !== "human") {
      return reject("target_not_human", "Roles apply to human users only.");
    }
    if (target.role === "owner") {
      return reject(
        "target_owner_immutable",
        "The Mission Control owner's status cannot be removed.",
      );
    }
    return { allowed: true };
  }

  if (intent === "invite") {
    if (requestedRole === "owner") {
      return reject(
        "owner_role_not_assignable",
        "The owner role cannot be granted through user management.",
      );
    }
    if (!requestedRole) {
      return reject("role_required", "A role is required for an invitation.");
    }
    if (viewer.role === "owner") {
      // The Owner may invite Admins or Customers with access to any project.
      return { allowed: true };
    }
    // An Admin invites new accounts as Customers, inside the Admin's scope.
    if (requestedRole !== "customer") {
      return reject(
        "role_change_owner_only",
        "Only the Mission Control owner can grant the Admin role.",
      );
    }
    if (!requestedProjectsAreInScope(requestedProjectIds, viewerProjectIds)) {
      return reject(
        "out_of_scope_project",
        "Access can only be granted within your own project scope.",
      );
    }
    return { allowed: true };
  }

  // intent === "access_edit": grant or revoke project access.
  if (!target || target.kind !== "human") {
    return reject("target_not_human", "Project access applies to human users only.");
  }
  if (target.role === "owner") {
    // Covers the Owner editing themselves too: the capability is immutable.
    return reject(
      "target_owner_immutable",
      "The Mission Control owner has access to every project.",
    );
  }
  if (viewer.role === "owner") {
    // The Owner manages project access for Admins and Customers alike.
    return { allowed: true };
  }
  // Admin guardrails: never self, only Customer targets, only in scope.
  if (target.id === viewer.id) {
    return reject("self_edit_forbidden", "An Admin cannot edit their own access.");
  }
  if (target.role !== "customer") {
    return reject("target_role_forbidden", "An Admin can only manage Customer access.");
  }
  if (!requestedProjectsAreInScope(requestedProjectIds, viewerProjectIds)) {
    return reject(
      "out_of_scope_project",
      "Access can only be granted or revoked within your own project scope.",
    );
  }
  return { allowed: true };
}