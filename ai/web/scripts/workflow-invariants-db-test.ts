// ENV-116 — workflow invariants against real rows.
//
// The fixture suite (scripts/workflow-invariants-test.ts) proves the predicates
// are internally correct. This one proves they BIND to real column semantics:
// it seeds a canonical "current behaviour" scenario on a throwaway sqlite —
// using the production writers wherever one exists — then evaluates the live-DB
// adapter and asserts the observed violations match
// lib/workflow-invariants-baseline.json exactly, code for code and count for
// count.
//
// Never touches the live pm.db: DATABASE_URL is repointed at a temp file before
// any lib import, per the scripts/pm-acceptance-baseline-test.ts convention.
//
// Exit 0 on success, non-zero on the first failed assertion.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { InvariantBaseline } from "@/lib/workflow-invariants";

const execFileP = promisify(execFile);

let checks = 0;

function fail(msg: string): never {
  console.error(`[workflow-invariants-db] FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, label: string): asserts cond {
  checks += 1;
  if (!cond) fail(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  checks += 1;
  if (actual !== expected) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    [
      "prisma",
      "db",
      "push",
      "--skip-generate",
      "--accept-data-loss",
      "--schema=prisma/schema.prisma",
    ],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

const AGENT_SLUG = "invariantbot";
const MINUTE = 60_000;

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "workflow-invariants-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;

  // Hermetic env must be set BEFORE importing any lib (@/lib/db reads it at
  // module-eval time).
  process.env.DATABASE_URL = dbUrl;

  try {
    await dbPush(dbUrl);

    const { db } = await import("@/lib/db");
    const {
      recordPmChannelRunEvent,
      recordPmChannelRunQueued,
      recordPmChannelRunWorkflowAction,
    } = await import("@/lib/agents/pm-channel/runs");
    const { runWorkflowActionAtomically } = await import(
      "@/lib/agents/workflow/transactional-action"
    );
    // ENV-118: production routes every continuation-required action through the
    // atomic primitive; the standalone recorder now refuses them outright. The
    // task.move above stands in for the domain mutation this scenario is not
    // exercising, so the callback is deliberately empty.
    const recordAction = async (args: {
      taskId: string;
      agentSlug: string;
      messageId: string;
      action: string;
    }) => (await runWorkflowActionAtomically(args, async () => {})).result;
    const { createActionPlanSubtasksForTask, extractActionPlanSteps } =
      await import("@/lib/tasks/action-plan-subtasks");
    const { loadWorkflowInvariantSnapshot, checkWorkflowInvariants } =
      await import("@/lib/workflow-invariants-db");
    const { compareToBaseline, evaluateWorkflowInvariants, WORKFLOW_RUN_LEASE_TTL_MS } =
      await import("@/lib/workflow-invariants");
    const BASELINE = JSON.parse(
      await readFile(
        path.join(process.cwd(), "lib/workflow-invariants-baseline.json"),
        "utf8",
      ),
    ) as InvariantBaseline;

    // ---------------- fixtures ----------------
    const agent = await db.agent.create({
      data: { slug: AGENT_SLUG, name: "Invariant Bot", role: "coding" },
    });
    const agentUser = await db.user.create({
      data: {
        username: AGENT_SLUG,
        email: `${AGENT_SLUG}@example.invalid`,
        kind: "agent",
        agentId: agent.id,
      },
    });
    const reporter = await db.user.create({
      data: { username: "reporter", email: "reporter@example.invalid", kind: "human" },
    });
    const project = await db.project.create({
      data: { slug: "invariants", name: "Invariants" },
    });

    const now = Date.now();
    const stale = new Date(now - WORKFLOW_RUN_LEASE_TTL_MS - 15 * MINUTE);

    // T1 — the continuation-required-action case (Epic items 1 and 4).
    const t1 = await db.task.create({
      data: {
        projectId: project.id,
        title: "Continuation action task",
        status: "In Progress",
        assigneeId: agentUser.id,
        reporterId: reporter.id,
        approvedOn: new Date(now - 20 * MINUTE),
      },
    });

    // Presentation remains Markdown, but the approved workflow source is a
    // structured ActionPlan with immutable steps.
    const planBody = [
      "## Action Plan",
      "",
      "### Deliverables",
      "1. Add the invariant registry module with stable ids",
      "2. Wire the fixture test suite into package.json",
      "3. Record the expected-fail baseline as JSON",
      "",
      "### Verification",
      "- typecheck and lint stay green",
    ].join("\n");
    await db.agentChatMessage.create({
      data: {
        projectId: project.id,
        taskId: t1.id,
        agentSlug: AGENT_SLUG,
        senderUserId: agentUser.id,
        body: planBody,
        originChannel: "chat",
      },
    });

    const stepTitles = extractActionPlanSteps(planBody);
    await db.actionPlan.create({
      data: {
        taskId: t1.id,
        summary: "Exercise the invariant registry and its validation suite.",
        status: "approved",
        authorId: agentUser.id,
        approvedOn: new Date(now - 20 * MINUTE),
        approvedById: reporter.id,
        contentHash: "workflow-invariants-structured-plan",
        steps: {
          create: stepTitles.map((title, rank) => ({
            stepId: `step-${rank + 1}`,
            title,
            acceptanceCriteria: JSON.stringify([`Complete: ${title}`]),
            rank,
          })),
        },
      },
    });

    // Production writer: checklist rows retain ActionPlanStep provenance.
    const seeded = await createActionPlanSubtasksForTask({
      taskId: t1.id,
      approvedAt: new Date(now - 20 * MINUTE),
      approvedById: reporter.id,
    });
    assertEqual(seeded.reason, "created", "the real seeder produced a checklist");
    assert(seeded.created > 0, "the real seeder produced at least one step");
    assertEqual(stepTitles.length, seeded.created, "checklist size matches structured plan steps");

    // Production writer: queue a run, then settle it with `start`.
    const t1Target = {
      kind: "task-comment" as const,
      agentSlug: AGENT_SLUG,
      taskId: t1.id,
      messageId: "msg-t1-start",
    };
    await recordPmChannelRunQueued({
      target: t1Target,
      kind: "task-comment",
      projectId: project.id,
    });
    // The route logs the move (payload carries the action) and then settles the
    // run. Mirrored here because moveTaskStatus is private to the route module.
    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: t1.id,
        userId: agentUser.id,
        kind: "task.move",
        payload: JSON.stringify({
          from: "To Do",
          to: "In Progress",
          via: "agent-workflow",
          action: "start",
        }),
      },
    });
    const startResult = await recordAction({
      taskId: t1.id,
      agentSlug: AGENT_SLUG,
      messageId: t1Target.messageId,
      action: "start",
    });
    assertEqual(startResult.actionEffect, "continue", "`start` continues the episode");
    assertEqual(startResult.turnComplete, false, "`start` does not complete the turn");

    // ENV-118: `start` must NOT settle the run. It renews the lease, records
    // the continuation intent, and leaves the episode open.
    const startedRun = await db.pmChannelRun.findFirst({
      where: { taskId: t1.id },
      select: { id: true, status: true, completedAt: true, disposition: true, settledByAction: true },
    });
    assert(startedRun, "the started run exists");
    assertEqual(
      startedRun.status,
      "queued",
      "ENV-118: `start` leaves the run active instead of settling it complete",
    );
    assertEqual(startedRun.completedAt, null, "an unsettled run carries no completedAt");
    assertEqual(startedRun.disposition, "continue", "`start` records the continue disposition");
    assertEqual(
      startedRun.settledByAction,
      null,
      "settledByAction is written only when an action actually settles the run",
    );
    assertEqual(
      await db.pmChannelContinuation.count({ where: { runId: startedRun.id, status: "armed" } }),
      1,
      "`start` armed a continuation in the same transaction as the run write",
    );

    // T2 — the stale-lease case (Epic item 2). Left accepted, never renewed.
    const t2 = await db.task.create({
      data: {
        projectId: project.id,
        title: "Stale lease task",
        status: "In Progress",
        assigneeId: agentUser.id,
        reporterId: reporter.id,
      },
    });
    await db.pmChannelRun.create({
      data: {
        targetKey: `task-comment:${AGENT_SLUG}:${t2.id}:msg-t2`,
        kind: "task-comment",
        agentSlug: AGENT_SLUG,
        messageId: "msg-t2",
        projectId: project.id,
        taskId: t2.id,
        status: "accepted",
        createdAt: stale,
        acceptedAt: stale, admittedAt: stale,
        lastEventAt: stale,
      },
    });

    // T3 — the empty-completion case (Epic item 3). A turn that produced an
    // explicit silent reply and took no workflow action, yet settled complete.
    const t3 = await db.task.create({
      data: {
        projectId: project.id,
        title: "Empty completion task",
        status: "Review",
        assigneeId: agentUser.id,
        reporterId: reporter.id,
      },
    });
    const t3Target = {
      kind: "task-comment" as const,
      agentSlug: AGENT_SLUG,
      taskId: t3.id,
      messageId: "msg-t3",
    };
    await recordPmChannelRunQueued({
      target: t3Target,
      kind: "task-comment",
      projectId: project.id,
    });
    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: t3.id,
        userId: agentUser.id,
        kind: "task.comment.silent",
        targetAgent: AGENT_SLUG,
        payload: JSON.stringify({
          agentSlug: AGENT_SLUG,
          inReplyToMessageId: "msg-t3",
        }),
      },
    });
    // Production writer: the durable silent reply makes `done` a legitimate
    // settle, so the run ends complete with the `completed` disposition and no
    // workflow action behind it — the exact shape WFI-006 objects to.
    await recordPmChannelRunEvent({ target: t3Target, event: "done" });

    // T4 — the formal blocker case (Epic item 6). ENV-120 makes flag_blocker
    // persist a validated structured report alongside the prose comment, so
    // the canonical row now carries the external actor and the requirement.
    const t4 = await db.task.create({
      data: {
        projectId: project.id,
        title: "Blocked task",
        status: "In Progress",
        assigneeId: agentUser.id,
        reporterId: reporter.id,
      },
    });
    const blockerComment = await db.comment.create({
      data: {
        taskId: t4.id,
        userId: agentUser.id,
        body: "Cannot proceed: the deploy host refuses the push and I have no way in.",
      },
    });
    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: t4.id,
        userId: agentUser.id,
        kind: "task.blocker",
        targetAgent: AGENT_SLUG,
        payload: JSON.stringify({
          commentId: blockerComment.id,
          action: "flag_blocker",
          blockerReport: {
            blockedOn: "external_service",
            requestedActor: "the deploy host operator",
            requestedAction: "Restore SSH push access for the PM deploy key on the release host.",
            evidence: "git push -> Permission denied (publickey) from release-host:22",
            diagnosticsAttempted: [
              "Retried the push with a fresh session and a regenerated agent socket.",
              "Confirmed the same key authenticates against the origin remote.",
            ],
            resumeCondition: "git push to release-host succeeds for the PM deploy key.",
            reporterCanResolve: false,
          },
        }),
      },
    });

    // ---------------- snapshot fidelity ----------------
    const snapshot = await loadWorkflowInvariantSnapshot({
      projectId: project.id,
      now,
    });

    assertEqual(snapshot.runs.length, 3, "adapter loaded every run");
    const runByTask = new Map(snapshot.runs.map((run) => [run.taskId, run] as const));

    const t1Run = runByTask.get(t1.id);
    assert(t1Run, "adapter loaded the T1 run");
    assertEqual(
      t1Run.settledByAction,
      null,
      "a continuation-required action settles nothing, so no settling action is reported",
    );
    assertEqual(
      t1Run.disposition,
      "continue",
      "the adapter reads the disposition column ENV-118 added",
    );

    const t2Run = runByTask.get(t2.id);
    assert(t2Run, "adapter loaded the T2 run");
    assertEqual(t2Run.status, "accepted", "the stale run is still non-terminal");
    assertEqual(
      t2Run.lastEventAt,
      stale.getTime(),
      "adapter converted lastEventAt to epoch ms",
    );

    const t3Run = runByTask.get(t3.id);
    assert(t3Run, "adapter loaded the T3 run");
    assertEqual(
      t3Run.finalResponseText,
      "",
      "an explicit silent turn reads back as an empty final response",
    );
    assertEqual(t3Run.settledByAction, null, "the silent turn took no workflow action");
    assertEqual(
      t3Run.disposition,
      "completed",
      "a turn settled by its own stream events records the `completed` disposition",
    );

    const t1Task = snapshot.tasks.find((task) => task.id === t1.id);
    assert(t1Task, "adapter loaded T1");
    assertEqual(t1Task.assigneeSlug, AGENT_SLUG, "assignee resolves to an agent slug");
    assertEqual(
      t1Task.planStepSource,
      "structured",
      "an approved plan's checklist retains structured step provenance",
    );
    assert(t1Task.checklistCount > 0, "T1 carries the seeded checklist");

    assertEqual(snapshot.blockers.length, 1, "adapter loaded the active blocker");
    assertEqual(snapshot.blockers[0].taskId, t4.id, "the blocker belongs to T4");
    assertEqual(
      snapshot.blockers[0].externalActor,
      "the deploy host operator",
      "the adapter reads the external actor out of the structured report",
    );
    assertEqual(
      snapshot.blockers[0].requirement,
      "Restore SSH push access for the PM deploy key on the release host.",
      "the adapter reads the actionable requirement out of the structured report",
    );

    // ---------------- baseline match ----------------
    const evaluated = evaluateWorkflowInvariants(snapshot);
    const drift = compareToBaseline(evaluated.violations, BASELINE);
    if (drift.length > 0) {
      for (const item of drift) {
        console.error(`[workflow-invariants-db] drift(${item.kind}) ${item.detail}`);
      }
      fail(
        `observed violations diverge from lib/workflow-invariants-baseline.json (${drift.length} drift item(s))`,
      );
    }
    checks += 1;

    assertEqual(
      evaluated.byInvariant["WFI-001"].length,
      0,
      "WFI-001 already holds and must stay out of the baseline",
    );
    assert(
      !evaluated.ok,
      "the canonical scenario is red on purpose — it is the Epic's acceptance gate",
    );

    // Every baseline entry must name a real Epic item and fire at least once.
    for (const entry of BASELINE.entries) {
      const codes = Object.keys(entry.codes);
      assert(codes.length > 0, `${entry.invariantId} baseline entry lists codes`);
      for (const code of codes) {
        assert(
          code.startsWith(`${entry.invariantId}/`),
          `baseline code ${code} is namespaced under ${entry.invariantId}`,
        );
      }
      assert(
        entry.epicItem >= 1 && entry.epicItem <= 9,
        `${entry.invariantId} baseline entry maps to an Epic item`,
      );
    }

    // ---------------- the monitor surface is read-only ----------------
    const before = {
      runs: await db.pmChannelRun.count(),
      tasks: await db.task.count(),
      activity: await db.activityLog.count(),
      checklist: await db.subTask.count(),
      comments: await db.comment.count(),
    };
    const report = await checkWorkflowInvariants({ projectId: project.id, now });
    const after = {
      runs: await db.pmChannelRun.count(),
      tasks: await db.task.count(),
      activity: await db.activityLog.count(),
      checklist: await db.subTask.count(),
      comments: await db.comment.count(),
    };
    assertEqual(
      JSON.stringify(after),
      JSON.stringify(before),
      "checkWorkflowInvariants wrote nothing",
    );
    assertEqual(report.counts.runs, 3, "the report counts the scanned runs");
    assertEqual(
      report.violations.length,
      evaluated.violations.length,
      "the monitor surface and a direct evaluation agree",
    );
    assert(!report.ok, "the monitor reports the current-behaviour violations");

    console.log(`[workflow-invariants-db] OK — ${checks} assertions passed`);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("[workflow-invariants-db] unexpected failure:", error);
  process.exit(1);
});
