# V23-43 approval versus review acceptance — 2026-09-22

V23-43 is a standalone task with Asdrubal as reviewer and reporter-only Action
Plan approval disabled. His revision-2 turn explicitly included `approve_plan`.
At 15:56 Brisbane time he chose `accept_plan_review` instead. PM accepted that
action, recorded a wait for another approver and ended his turn, although he was
already the authorized approver. No approval-permission rejection caused this.

The earlier approved-Epic permission change did not prevent this case: the
problem was that an authorized approver still had both acceptance and approval
available, and the server permitted the wrong waiting-state transition.

Compact native and scoped HTTP contracts now expose `accept_plan_review` only
when the reviewer cannot approve. Server authorization independently rejects
acceptance-only requests from approvers with
`approval_required_use_approve_plan`, covering stale grants and other transports.
The rejection records no review acceptance and does not complete the agent's
turn. Approval remains an explicit reviewer decision; acceptance is never
silently converted into approval.

Regression tests exercise reporter-only acceptance, delegated approval,
approved-Epic approval and ordinary standalone approval through the agent API.
Recovery of V23-43 uses a fresh reviewer turn for its existing plan revision;
no reset or implementer resubmission is required.
