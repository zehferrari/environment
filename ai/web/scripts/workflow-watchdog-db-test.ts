// ENV-123 — the watchdog against real rows.
//
// The fixture suite (scripts/workflow-watchdog-test.ts) proves the detectors
// are internally correct. This one proves the pass BINDS to real column
// semantics: it seeds a throwaway sqlite, runs `runWorkflowWatchdog` against
// it, and asserts the repairs actually landed — the continuation outbox row,
// the settled run, the tripped breaker, the escalation flag — and that a second
// pass over an already-repaired task changes nothing.
//
// Never touches the live pm.db: DATABASE_URL is repointed at a temp file before
// any lib import, per the scripts/workflow-invariants-db-test.ts convention.
//
// Exit 0 on success, non-zero on the first failed assertion.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let checks = 0;

function fail(message: string): never {
  console.error(`[workflow-watchdog-db] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: unknown, label: string): asserts condition {
  checks += 1;
  if (!condition) fail(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// `migrate deploy`, not `db push`: the schema alone omits the raw-SQL partial
// unique indexes the run repairs depend on, so the pushed database diverges
// from the one the watchdog actually runs against. Same convention as
// scripts/pm-channel-lease-lifecycle-test.ts.
async function migrateDeploy(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

const AGENT_SLUG = "watchdogbot";
const MINUTE = 60_000;

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "workflow-watchdog-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  // Pin the breaker budget so the assertions below do not depend on a stray
  // env var in the operator's shell.
  process.env.PM_WATCHDOG_MAX_RECOVERIES = "3";

  try {
    await migrateDeploy(dbUrl);

    const { db } = await import("@/lib/db");
    const { runWorkflowWatchdog } = await import("@/lib/agents/watchdog/run");
    const { WATCHDOG_CONTINUATION_ACTION, watchdogRecoveryBudget } = await import(
      "@/lib/agents/watchdog/repairs"
    );
    const { writeTaskExecutionState } = await import("@/lib/agents/watchdog/state");
    const { WATCHDOG_STALL_GRACE_MS } = await import("@/lib/agents/watchdog/detectors");
    const { WORKFLOW_RUN_LEASE_TTL_MS } = await import("@/lib/workflow-invariants");

    const agent = await db.agent.create({
      data: { slug: AGENT_SLUG, name: "Watchdog Bot", role: "coding" },
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
      data: { username: "watchdog-reporter", email: "wr@example.invalid", kind: "human" },
    });
    const project = await db.project.create({ data: { slug: "watchdog", name: "Watchdog" } });

    const now = Date.now();
    const stalled = new Date(now - WATCHDOG_STALL_GRACE_MS - 5 * MINUTE);
    const leaseDead = new Date(now - WORKFLOW_RUN_LEASE_TTL_MS - 15 * MINUTE);

    async function makeTask(title: string, status: string) {
      return db.task.create({
        data: {
          projectId: project.id,
          title,
          status,
          assigneeId: agentUser.id,
          reporterId: reporter.id,
          approvedOn: stalled,
        },
      });
    }

    async function makeRun(args: {
      taskId: string;
      messageId: string;
      status: string;
      at: Date;
      lastAction?: string | null;
    }) {
      return db.pmChannelRun.create({
        data: {
          targetKey: `task-comment:${AGENT_SLUG}:${args.taskId}:${args.messageId}`,
          kind: "task-comment",
          agentSlug: AGENT_SLUG,
          messageId: args.messageId,
          projectId: project.id,
          taskId: args.taskId,
          sessionKey: "session-a",
          status: args.status,
          createdAt: args.at,
          acceptedAt: args.at,
          lastEventAt: args.at,
          lastAction: args.lastAction ?? null,
          lastActionAt: args.lastAction ? args.at : null,
        },
      });
    }

    // tA — started, then went quiet. The canonical recovery case.
    const tA = await makeTask("Started and went quiet", "In Progress");
    const runA = await makeRun({
      taskId: tA.id,
      messageId: "msg-a",
      status: "completed",
      at: stalled,
      lastAction: "start",
    });

    // tB — a run still claiming to be accepted with a dead lease.
    const tB = await makeTask("Dead lease", "In Progress");
    await makeRun({ taskId: tB.id, messageId: "msg-b", status: "accepted", at: leaseDead });

    // tC — same shape as tA, but its recovery budget is already spent.
    const tC = await makeTask("Budget exhausted", "In Progress");
    await makeRun({
      taskId: tC.id,
      messageId: "msg-c",
      status: "completed",
      at: stalled,
      lastAction: "start",
    });
    await db.taskExecutionState.create({
      data: {
        taskId: tC.id,
        projectId: project.id,
        state: "stalled",
        recoveryCount: watchdogRecoveryBudget(),
        recoveryWindowAt: new Date(now - MINUTE),
      },
    });

    // tD — a healthy Review task the watchdog must leave alone.
    const tD = await makeTask("Waiting on the reviewer", "Review");

    // ---------------- pass 1 ----------------
    const first = await runWorkflowWatchdog();
    assertEqual(first.counts.tasks, 4, "the pass scanned every In Progress and Review task");
    assert(first.counts.findings > 0, "the pass produced findings");
    assert(first.errors.length === 0, `the pass reported no errors: ${first.errors.join("; ")}`);

    // tA — one recovery continuation, through the ENV-118 outbox.
    const contA = await db.pmChannelContinuation.findMany({ where: { taskId: tA.id } });
    assertEqual(contA.length, 1, "exactly one recovery continuation was armed for tA");
    assertEqual(contA[0].action, WATCHDOG_CONTINUATION_ACTION, "it is a watchdog recovery row");
    assertEqual(contA[0].status, "queued", "it is drainable immediately");
    assertEqual(contA[0].runId, runA.id, "it hangs off the lane's newest run");

    const stateA = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: tA.id } });
    assertEqual(stateA.state, "stalled", "tA reads as stalled");
    assertEqual(stateA.reasonCode, "no_active_run", "tA's reason is the highest-priority diagnosis");
    assertEqual(stateA.recoveryAction, "new run queued", "tA's recovery is rendered for the operator");
    assertEqual(stateA.lastDurableAction, "start", "the last durable action is read from the run column");
    assert(stateA.lastDurableActionAt !== null, "the last durable action carries its timestamp");
    assertEqual(stateA.recoveryCount, 1, "tA consumed exactly one unit of recovery budget");

    // tB — the dead run is settled, terminally and with a disposition.
    const settledB = await db.pmChannelRun.findFirstOrThrow({ where: { taskId: tB.id } });
    assertEqual(settledB.status, "timed_out", "the lease-expired run was settled");
    assertEqual(settledB.finishedReason, "watchdog_lease_expired", "the settle names the watchdog");
    assertEqual(settledB.disposition, "failed", "WFI-005: the terminal write recorded a disposition");

    // tC — the breaker opened instead of repairing, and escalated.
    assert(first.breakerOpen >= 1, "the exhausted task hit an open breaker");
    const contC = await db.pmChannelContinuation.findMany({ where: { taskId: tC.id } });
    assertEqual(contC.length, 0, "an open breaker queues no continuation");
    const stateC = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: tC.id } });
    assert(stateC.breakerOpenUntil !== null, "the breaker recorded when it reopens");
    assert(stateC.escalatedAt !== null, "the exhausted task was escalated");
    const taskC = await db.task.findUniqueOrThrow({ where: { id: tC.id } });
    assertEqual(taskC.alertReporter, true, "escalation raises the reporter flag on the board");

    // tD — healthy, untouched.
    const stateD = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: tD.id } });
    assertEqual(stateD.state, "waiting_review", "a Review task reads as waiting_review");
    assertEqual(stateD.recoveryAction, null, "a healthy task records no recovery");
    assertEqual(
      (await db.pmChannelContinuation.count({ where: { taskId: tD.id } })),
      0,
      "a Review task is never pushed a turn",
    );

    // ---------------- pass 2: idempotency ----------------
    const second = await runWorkflowWatchdog();
    assert(second.errors.length === 0, `the second pass reported no errors: ${second.errors.join("; ")}`);
    assertEqual(
      await db.pmChannelContinuation.count({ where: { taskId: tA.id } }),
      1,
      "a second pass does not queue a second continuation for tA",
    );
    assertEqual(
      (await db.pmChannelRun.findUniqueOrThrow({ where: { id: settledB.id } })).finishedAt?.getTime(),
      settledB.finishedAt?.getTime(),
      "a second pass does not re-settle an already-settled run",
    );
    assertEqual(
      (await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: tA.id } })).recoveryCount,
      1,
      "an already-repaired task does not burn more recovery budget",
    );
    assertEqual(
      (await db.activityLog.count({ where: { taskId: tC.id, kind: "task.watchdog.escalated" } })),
      1,
      "escalation is recorded exactly once per episode of trouble",
    );

    // tA is now visibly running again: its continuation owns the next turn.
    const stateA2 = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: tA.id } });
    assertEqual(stateA2.state, "running", "a task with a scheduled continuation reads as running");
    assertEqual(stateA2.reasonCode, "continuation_scheduled", "and says why");

    // ---------------- convergence: the state write is a genuine no-op ----------------
    // tB only recovers on pass 2 (pass 1 settled its dead run, which is what
    // made it look stalled), so the fleet is quiescent from pass 3 onward.
    // The property under test is that a pass which observes nothing new writes
    // nothing at all — the whole point of the no-op short circuit in
    // writeTaskExecutionState, since the watchdog runs on every worker drain.
    await runWorkflowWatchdog();
    const before = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: tA.id } });
    const quiescent = await runWorkflowWatchdog();
    assertEqual(quiescent.stateWrites, 0, "a pass that observes no change writes no state rows");
    const after = await db.taskExecutionState.findUniqueOrThrow({ where: { taskId: tA.id } });
    assertEqual(
      after.updatedAt.getTime(),
      before.updatedAt.getTime(),
      "updatedAt does not churn when nothing observable moved",
    );
    assertEqual(after.state, stateA2.state, "and the state itself is stable");

    // ---------------- the store's own no-op contract ----------------
    const changed = await writeTaskExecutionState({
      taskId: tD.id,
      projectId: project.id,
      state: "idle",
      reasonCode: "no_work_scheduled",
      reasonDetail: "no execution turn is running or scheduled",
    });
    assertEqual(changed, true, "a real change reports that it wrote");
    const unchanged = await writeTaskExecutionState({
      taskId: tD.id,
      projectId: project.id,
      state: "idle",
      reasonCode: "no_work_scheduled",
      reasonDetail: "no execution turn is running or scheduled",
    });
    assertEqual(unchanged, false, "an identical write is a no-op");

    // ---------------- dry run changes nothing ----------------
    await db.pmChannelContinuation.deleteMany({ where: { taskId: tA.id } });
    await db.taskExecutionState.update({
      where: { taskId: tA.id },
      data: { recoveryCount: 0, recoveryWindowAt: null, breakerOpenUntil: null },
    });
    const dry = await runWorkflowWatchdog({ dryRun: true });
    assert(dry.counts.findings > 0, "the dry run still detects");
    assertEqual(dry.repaired, 0, "the dry run repairs nothing");
    assertEqual(
      await db.pmChannelContinuation.count({ where: { taskId: tA.id } }),
      0,
      "the dry run wrote no outbox row",
    );

    console.log(`[workflow-watchdog-db] OK — ${checks} checks passed`);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[workflow-watchdog-db] failed", error);
  process.exit(1);
});
