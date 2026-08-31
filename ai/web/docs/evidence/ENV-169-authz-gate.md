# ENV-169 — Authorization and end-to-end test gate (Epic acceptance evidence)

- **Task:** 9. Authorization and end-to-end test gate for Owner / Admin / Customer (PM `cmtgp185j0ytsov36y87ip2oq`)
- **Epic:** Client UI: role-based human experience (ENV-160, `cmtglbdv10veiov1utx322f98`)
- **Branch:** `env-169` (worktree `/srv/Code/environment.worktrees/env-169`), baseline `f7610ec` = `origin/client-ui` (published Epic tip containing merges for ENV-161…ENV-168). Changes left uncommitted for PM submission.
- **Date:** 2026-09-01 (agent: carmen)

## Deliverables (all under `ai/web`)

| File | Purpose |
| --- | --- |
| `scripts/lib/authz-scenario-harness.ts` (784 lines) | Throwaway SQLite DB via `prisma migrate deploy` (DATABASE_URL repointed before any `@/lib` import); seeds Owner, Admin granted Project A, second Admin, Customer granted Project A, Customer with no grants, Projects A/B, agent principals, human/agent-authored comments, activities, attachments, notifications, one private Task and one private Epic; in-process authenticated request helpers call real route handlers and core functions — no re-implemented policy. |
| `scripts/authz-matrix-test.ts` (405 lines) | Role × surface authorization matrix across navigation, workspaces, projects, Tasks, Epics, comments, activities, attachments, APIs, search and deep links; each case labels the acceptance-criterion id it proves. |
| `scripts/authz-negative-space-test.ts` (308 lines) | Recursive sentinel sweep of every Customer-visible payload (API JSON, serialized page projections, comments, activities, attachment metadata, search results, stream frames) plus counts/pagination equality against the filtered result set. |
| `scripts/authz-e2e-flows-test.tsx` (~646 lines) | Journeys J1 invitation→token→activation→owner edit/promote/demote with audit trail, J2 Admin guardrail rejections with zero state delta, J3 Customer isolation incl. production `SidebarNav` markup, J4 Owner preview lens (reads + production markup + `PreviewBanner`), J5 active-session revocation (epoch push, identity boundary, next-request denial, re-grant restore). |
| `package.json` | Wires `test:authz-matrix`, `test:authz-negative-space`, `test:authz-e2e`. |

## AC1–AC10 traceability

| AC | Criterion (abridged) | Automated coverage | Result |
| --- | --- | --- | --- |
| 1 | Owner global access; only role that promotes/demotes Admins and administers agents | authz-matrix owner block + role machinery (`setHumanUserRoleCore`) + agent-admin surfaces; e2e J1 promote/demote, J2 non-owner negatives | PASS |
| 2 | Admin manages Customer access only in own scope; self/other-Admin/Owner/out-of-scope rejected server-side | authz-matrix guardrail block on real cores (zero user/member/audit delta + in-scope positive control); e2e J2 | PASS |
| 3 | Admin sees Project A agent activity; cannot discover Project B, its users, work items, activity, counts, attachments | authz-matrix admin-isolation block (pages, APIs, search, direct URLs, counts, attachments) | PASS |
| 4 | Customer uses permitted human-facing views with zero agent navigation/controls | authz-matrix customer block; e2e J3 (zero-agent production markup); `test:customer-role-dom-contract` | PASS |
| 5 | Agent-authored comments/messages/activities/attachments/workflow records absent from Customer HTML, payloads, APIs, streams, searches, notifications, pagination, unread counts | `test:authz-negative-space` (sentinel sweep through the real projection path + counts/pagination equality) | PASS |
| 6 | Direct request for inaccessible/agent-only resource → safe not-found/denied, no metadata leak | authz-matrix deep-link block (no existence oracle) | PASS |
| 7 | Customer-visible content coherent after agent-row removal; shared results via the customer-safe publishing path | negative-space coherence sweeps; `test:customer-publishing`; e2e J3 published-surface legs | PASS |
| 8 | Role/access changes effective immediately across open tabs and new requests | e2e J5 (live policy-changed epoch push, next-request denial, re-grant restore); `test:access-revocation`; `test:auth-session-recovery` | PASS |
| 9 | Automated authz tests across three roles on all surfaces and deep links | `test:authz-matrix` (case labels carry the criterion id) | PASS |
| 10 | E2E tests: invitation/edit flow, Admin guardrails, Customer isolation, Owner preview mode, revocation while session active | `test:authz-e2e` J1–J5 | PASS |

## Regression gate record (run 2026-09-01 on `env-169` @ `f7610ec`)

| Command | Result |
| --- | --- |
| `pnpm typecheck` (tsc --noEmit) | **PASS** (exit 0; 6 initial type errors in the new e2e file were fixed type-only: reader overload → structural `PolicyStreamReader` interface, `rolePermission` optional chaining, `epochBefore` null guard) |
| `pnpm test:authz-e2e` (fresh run) | **PASS** (exit 0, J1–J5 all assertions, reader-cancel teardown verified) |
| 15-suite batch: `test:access-policy`, `test:access-management`, `test:access-revocation`, `test:access-flow`, `test:user-access-control`, `test:human-role-policy`, `test:customer-role-dom-contract`, `test:preview-as-user`, `test:user-lifecycle`, `test:user-lifecycle-controls`, `test:auth-session-recovery`, `test:customer-publishing`, `test:work-item-proposal-authorization`, `test:authz-matrix`, `test:authz-negative-space` | **15/15 PASS** |
| `pnpm test:workflow` (serial aggregate, 51 members) | **47/51 PASS** — 4 pre-existing failures, root-caused below; each reproduced individually |

**Scoped authorization gate is fully green.** The full-repository aggregate is red only on pre-existing items outside this task's scope (next section).

## Pre-existing aggregate failures (out of scope for ENV-169)

All four are deterministic static/runtime assertions against **committed baseline code that ENV-169 never touched** (`git status` clean for these files; zero findings reference the files added by this task):

1. `test:workflow-boundary` — 17 unregistered direct-mutation findings, all in `lib/tasks/hard-reset.ts` (`Task.status`, `workflowOutbox.updateMany/deleteMany`, `taskProcedureStep/Run.updateMany`, `ReviewRun.*`, `taskRepositoryRun.updateMany`, `workflowTransition.deleteMany`, `taskWorkflowCycle.deleteMany`). Last commit to that file: `591a1a8` **PH-182 (2026-08-27)** — pre-dates this Epic.
2. `test:workflow-transition-kernel` — `app/(app)/projects/[slug]/page.tsx must submit the browser override command` (`workflow-transition-kernel-test.ts:251`).
3. `test:workflow-agent-rules` — `app/(app)/projects/[slug]/page.tsx must submit the canonical human override command` (`workflow-agent-rules-test.ts:400`).
4. `test:workflow-watchdog-visibility` — `app/(app)/projects/[slug]/page.tsx maps the execution state onto the board task`.

Last commit to `page.tsx`: `6fb6217` **ENV-165 (2026-08-31)** — the Epic's client-lane rewrite no longer satisfies these pre-existing static workflow contracts. Fixing them means editing PH-182 boundary-registry territory and/or ENV-165 client-lane page wiring — outside this task's approved plan. Raised as a formal PM scope-decision blocker (task comment `cmthvc8k4cow2ov36e6rs3lwo`, 2026-08-31T23:27:41Z) and resolved by the decision owner's acceptance ruling below.

## Dispositions — pre-existing aggregate failures (accepted gate evidence)

**Scope decision (2026-08-31T23:30:38Z): do not absorb. @barekbaal, decision owner — task comment `cmthvg0wycw50ov362neep29q`.** The 47/51 aggregate `test:workflow` record is accepted as the whole-Epic gate evidence with the per-failure dispositions below. The two failing lanes receive their own follow-up tasks, filed by the decision owner:

1. **Restore `app/(app)/projects/[slug]/page.tsx` workflow contracts broken by ENV-165** — Client UI lane; an in-Epic regression already published on `client-ui`; the decision owner treats the Epic as not closable until this is Done.
2. **Register `lib/tasks/hard-reset.ts` direct mutations in the workflow boundary registry (PH-182)** — outside this Epic's lane; not a closure blocker.

Per-failure disposition — each entry records the owning commit and lane, the isolated reproduction, and the evidence of independence from this diff:

- **D1 — `test:workflow-boundary`. Owning commit/lane: `591a1a8` (2026-08-27, subject `PH-182 add hard reset and confirmed worktree discard`), `lib/` boundary-registry lane — `git log -1 -- lib/tasks/hard-reset.ts`, re-verified on this worktree. Isolated reproduction: deterministic single-suite failure on `env-169` @ `f7610ec` (== `origin/client-ui`); 17 unregistered direct-mutation findings, expected `[]`, all in `lib/tasks/hard-reset.ts`; independently reproduced by the decision owner. Independence: every finding sits in a `lib/` file last touched by PH-182; ENV-169's change set is additive-only and modifies no `lib/` file.**
- **D2 — `test:workflow-transition-kernel`. Owning commit/lane: `6fb6217` (2026-08-31, subject `ENV-165 5. Role-aware navigation, landing pages, and customer-safe copy`), Client UI lane — the suite asserts at `workflow-transition-kernel-test.ts:251` that `page.tsx` must submit the browser override command. Isolated reproduction: deterministic single-suite failure on `env-169` @ `f7610ec`; independently reproduced by the decision owner. Independence: the suite statically reads `app/(app)/projects/[slug]/page.tsx`, a component ENV-169 never touches.**
- **D3 — `test:workflow-agent-rules`. Owning commit/lane: `6fb6217` (2026-08-31, ENV-165), Client UI lane — the suite asserts at `workflow-agent-rules-test.ts:400` that `page.tsx` must submit the canonical human override command. Isolated reproduction: deterministic single-suite failure on `env-169` @ `f7610ec`; independently reproduced by the decision owner. Independence: same page component, outside this additive-only diff.**
- **D4 — `test:workflow-watchdog-visibility`. Owning commit/lane: `6fb6217` (2026-08-31, ENV-165), Client UI lane — the suite requires `page.tsx` to map execution state onto the board task. Isolated reproduction: deterministic single-suite failure on `env-169` @ `f7610ec`; independently reproduced by the decision owner. Independence: same page component, outside this additive-only diff.**

Independence evidence (applies to all four): baseline HEAD `f7610ec` == `origin/client-ui` (published Epic tip); `git diff --name-status origin/client-ui...HEAD` is empty — the ENV-169 change set is additive-only working-tree additions (4 new `scripts/` suites, this evidence doc, 3 `ai/web/package.json` script entries); `git status` shows no modification to either implicated file; zero findings reference any file added by this task. The decision owner independently reproduced all four failures and confirmed this provenance before ruling.

For the record, flagged separately by the decision owner: ENV-165 was accepted onto the Epic branch with three of these suites already red — a gate-discipline gap in the merge path, not something ENV-169 introduced.

Per this ruling, the accepted 47/51 record plus these dispositions is the Epic gate evidence for the whole-Epic acceptance requirement; the two failing lanes transfer to their own follow-up tasks.

## Test-quirk dispositions (harness notes)

- **No Notification model** exists in the Prisma schema; unread counters exist only on agent-chat surfaces (absent for Customers by predicate and by navigation). The agent-chat + viewer-stream routes resolve sessions via `headers()/auth()` — the request-ALS class the harness documents as undrivable in-process; that boundary refusal is proven on the drivable agent-only API class by the matrix suite (AC6), and the stream's frame contract is asserted directly against the real stream factory (negative-space suite).
- **requirePublishingViewer** rejection message is not pinned by contract; the e2e matcher asserts `instanceof Error`.
- **Harness boot noise:** a non-fatal `[prisma] failed to apply SQLite runtime pragmas: database is locked` warning can appear at throwaway-DB boot; suites continue and pass.
- **J5 teardown:** the policy stream is drained through a reader obtained before draining and cancelled via `reader.cancel()` (`stream.cancel()` throws `ERR_INVALID_STATE` while the reader holds the lock).
- Scratch file `scripts/__authz-harness-smoke.ts` removed before the gate run.

## How to rerun

```bash
cd ai/web
pnpm typecheck
pnpm test:authz-matrix
pnpm test:authz-negative-space
pnpm test:authz-e2e
for s in access-policy access-management access-revocation access-flow user-access-control human-role-policy customer-role-dom-contract preview-as-user user-lifecycle user-lifecycle-controls auth-session-recovery customer-publishing work-item-proposal-authorization; do pnpm test:$s; done
pnpm test:workflow
```