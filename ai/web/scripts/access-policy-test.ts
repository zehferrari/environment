// ENV-164 step 2 — unit coverage for every allow and deny cell of the
// scoped-access policy matrix (ai/web/lib/users/access-policy.ts).
//
// The policy core is intentionally pure (no database, no session), so this
// suite needs no temp-DB bootstrap: it imports the module directly and
// asserts the typed decision for each matrix cell.

import assert from "node:assert/strict";
import {
  ACCESS_POLICY_REJECTIONS,
  evaluateAccessPolicy,
  type AccessPolicyDecision,
  type AccessPolicyRejection,
  type AccessPolicySubject,
} from "../lib/users/access-policy";

const P_IN_1 = "project-in-1";
const P_IN_2 = "project-in-2";
const P_OUT = "project-out";
const SCOPE: readonly string[] = [P_IN_1, P_IN_2];

const ownerViewer: AccessPolicySubject = { id: "user-owner", kind: "human", role: "owner" };
const adminViewer: AccessPolicySubject = { id: "user-admin", kind: "human", role: "admin" };
const customerViewer: AccessPolicySubject = { id: "user-customer", kind: "human", role: "customer" };
const agentViewer: AccessPolicySubject = { id: "user-agent", kind: "agent", role: null };
const nullRoleViewer: AccessPolicySubject = { id: "user-legacy", kind: "human", role: null };

const customerTarget: AccessPolicySubject = { id: "target-customer", kind: "human", role: "customer" };
const peerAdminTarget: AccessPolicySubject = { id: "target-admin", kind: "human", role: "admin" };
const ownerTarget: AccessPolicySubject = { id: "user-owner", kind: "human", role: "owner" };
const agentTarget: AccessPolicySubject = { id: "target-agent", kind: "agent", role: null };

type PolicyInput = Parameters<typeof evaluateAccessPolicy>[0];

function decide(input: Partial<PolicyInput>): AccessPolicyDecision {
  return evaluateAccessPolicy({
    intent: "access_edit",
    viewer: adminViewer,
    viewerProjectIds: SCOPE,
    target: customerTarget,
    requestedRole: "customer",
    requestedProjectIds: [P_IN_1],
    ...input,
  });
}

function assertAllow(decision: AccessPolicyDecision): void {
  assert.deepEqual(decision, { allowed: true });
}

const exercisedRejections = new Set<AccessPolicyRejection>();

function assertDeny(decision: AccessPolicyDecision, reason: AccessPolicyRejection): void {
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, reason);
  assert.ok(decision.message.length > 0, "rejections must carry a human-readable message");
  exercisedRejections.add(reason);
}

async function main(): Promise<void> {
  // ---- Viewer gate: only a human Owner or Admin manages access at all.
  for (const intent of ["invite", "access_edit", "role_change"] as const) {
    assertDeny(decide({ intent, viewer: customerViewer }), "viewer_may_not_manage_access");
    assertDeny(decide({ intent, viewer: agentViewer }), "viewer_may_not_manage_access");
    // Defensive: a human with an unresolved role fails closed, not open.
    assertDeny(decide({ intent, viewer: nullRoleViewer }), "viewer_may_not_manage_access");
  }

  // ---- Invite.
  // Owner may invite Admins or Customers with access to any project.
  assertAllow(decide({ intent: "invite", viewer: ownerViewer, target: null, requestedRole: "customer", requestedProjectIds: [P_OUT] }));
  assertAllow(decide({ intent: "invite", viewer: ownerViewer, target: null, requestedRole: "admin", requestedProjectIds: [] }));
  // The owner role is never assignable, by anyone.
  assertDeny(decide({ intent: "invite", viewer: ownerViewer, target: null, requestedRole: "owner" }), "owner_role_not_assignable");
  assertDeny(decide({ intent: "invite", viewer: adminViewer, target: null, requestedRole: "owner" }), "owner_role_not_assignable");
  // A role is always required.
  assertDeny(decide({ intent: "invite", viewer: ownerViewer, target: null, requestedRole: null }), "role_required");
  assertDeny(decide({ intent: "invite", viewer: adminViewer, target: null, requestedRole: null }), "role_required");
  // Admin invites new accounts as Customers inside their own scope.
  assertAllow(decide({ intent: "invite", viewer: adminViewer, target: null, requestedRole: "customer", requestedProjectIds: [P_IN_1, P_IN_2] }));
  assertAllow(decide({ intent: "invite", viewer: adminViewer, target: null, requestedRole: "customer", requestedProjectIds: [] }));
  assertDeny(decide({ intent: "invite", viewer: adminViewer, target: null, requestedRole: "customer", requestedProjectIds: [P_IN_1, P_OUT] }), "out_of_scope_project");
  // Only the Owner can grant the Admin role.
  assertDeny(decide({ intent: "invite", viewer: adminViewer, target: null, requestedRole: "admin" }), "role_change_owner_only");

  // ---- Access edit (grant / revoke project access).
  // Owner manages access for Admins and Customers alike, any project.
  assertAllow(decide({ viewer: ownerViewer, requestedProjectIds: [P_OUT] }));
  assertAllow(decide({ viewer: ownerViewer, target: peerAdminTarget, requestedProjectIds: [] }));
  // The Owner's own access is immutable (covers editing themselves).
  assertDeny(decide({ viewer: ownerViewer, target: ownerTarget }), "target_owner_immutable");
  // Non-human and missing targets are rejected.
  assertDeny(decide({ viewer: ownerViewer, target: agentTarget }), "target_not_human");
  assertDeny(decide({ viewer: ownerViewer, target: null }), "target_not_human");
  // Admin edits Customer targets inside scope.
  assertAllow(decide({ viewer: adminViewer, requestedProjectIds: [P_IN_1, P_IN_2] }));
  assertAllow(decide({ viewer: adminViewer, requestedProjectIds: [] }));
  assertDeny(decide({ viewer: adminViewer, requestedProjectIds: [P_OUT] }), "out_of_scope_project");
  // Admin guardrails: never self, never another Admin, never the Owner.
  assertDeny(decide({ viewer: adminViewer, target: { ...adminViewer } }), "self_edit_forbidden");
  assertDeny(decide({ viewer: adminViewer, target: peerAdminTarget }), "target_role_forbidden");
  assertDeny(decide({ viewer: adminViewer, target: ownerTarget }), "target_owner_immutable");
  assertDeny(decide({ viewer: adminViewer, target: agentTarget }), "target_not_human");

  // ---- Role change (promote / demote).
  // Only the Owner promotes or demotes.
  assertAllow(decide({ intent: "role_change", viewer: ownerViewer, target: customerTarget, requestedRole: "admin" }));
  assertAllow(decide({ intent: "role_change", viewer: ownerViewer, target: peerAdminTarget, requestedRole: "customer" }));
  assertDeny(decide({ intent: "role_change", viewer: adminViewer, target: customerTarget, requestedRole: "admin" }), "role_change_owner_only");
  assertDeny(decide({ intent: "role_change", viewer: customerViewer, target: customerTarget, requestedRole: "admin" }), "viewer_may_not_manage_access");
  // The owner role is never assignable and the Owner is immutable.
  assertDeny(decide({ intent: "role_change", viewer: ownerViewer, target: customerTarget, requestedRole: "owner" }), "owner_role_not_assignable");
  assertDeny(decide({ intent: "role_change", viewer: adminViewer, target: customerTarget, requestedRole: "owner" }), "owner_role_not_assignable");
  assertDeny(decide({ intent: "role_change", viewer: ownerViewer, target: ownerTarget, requestedRole: "customer" }), "target_owner_immutable");
  assertDeny(decide({ intent: "role_change", viewer: ownerViewer, target: { ...ownerViewer }, requestedRole: "customer" }), "target_owner_immutable");
  // Role changes need a role and a human target.
  assertDeny(decide({ intent: "role_change", viewer: ownerViewer, target: customerTarget, requestedRole: null }), "role_required");
  assertDeny(decide({ intent: "role_change", viewer: ownerViewer, target: null, requestedRole: "admin" }), "target_not_human");
  assertDeny(decide({ intent: "role_change", viewer: ownerViewer, target: agentTarget, requestedRole: "admin" }), "target_not_human");

  // ---- Completeness: every typed rejection must have been exercised.
  for (const reason of ACCESS_POLICY_REJECTIONS) {
    assert.ok(exercisedRejections.has(reason), `matrix cell untested: ${reason}`);
  }

  console.log("access-policy-test: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});