# Phase E workflow boundary inventory

Phase E is complete. The machine-readable registry is
`lib/tasks/legacy-workflow-boundary-registry.json`, schema version 3, and its
legacy `boundaries` list must remain empty.

All task workflow mutations enter through a typed command adapter and resolve
one intent executor in `lib/tasks/orchestrator/execute.ts`. The agent task
transport has exactly one call to `submitAuthoritativeAgentWorkflowAction`.
Browser and policy surfaces use their typed command adapters; they do not call
the transition kernel directly.

Repository validation and finalization workers accept only complete schema-v2
identity packets. A callback must match its exact task, workflow cycle,
procedure run, step, job, repository run/version, candidate SHA, and base SHA.
There is no task-search callback fallback and no v1 drain adapter.

`pnpm test:workflow-boundary` is the structural gate. It rejects unregistered
Task/status, review, cycle, procedure, repository, outbox, or direct transition
writers and asserts zero registered legacy boundaries plus one authoritative
agent caller. Named kernel internals are mechanical state engines, not alternate
workflow decision boundaries.

Historical `task.workflow.legacy_boundary.invoked` activity remains readable
only for the final zero-delta observation report. No production writer remains.
