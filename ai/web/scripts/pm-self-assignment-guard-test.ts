// Scratch-DB test for scripts/pm-self-assignment-guard.ts (PH-124 fix):
// the guard must clear ONLY unattributed agent self-writes older than the
// settle window — never engine/reviewer/proposal-apply/human assignments.
//
// Run from ai/web: pnpm exec tsx scripts/pm-self-assignment-guard-test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const webRoot = path.resolve(__dirname, "..");
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-guard-test-"));
const dbPath = path.join(scratchDir, "guard.db");
process.env.DATABASE_URL = `file:${dbPath}`;

function sh(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, {
    cwd: webRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error(res.stdout);
    console.error(res.stderr);
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
  }
}

async function main() {
  // Fresh schema on the scratch DB (never the live DB).
  sh("pnpm", ["exec", "prisma", "db", "push", "--skip-generate"]);

  const { db } = await import("../lib/db");

  const now = Date.now();
  const settled = new Date(now - 5 * 60_000); // well past the 60s settle window
  const fresh = new Date(now - 10_000); // inside the settle window

  // --- fixtures ---------------------------------------------------------
  const karenAgent = await db.agent.create({
    data: { slug: "karen-test", name: "Karen (test)", role: "monitor" },
  });
  const karen = await db.user.create({
    data: {
      username: "karen-test",
      email: "karen-test@example.invalid",
      kind: "agent",
      status: "active",
      agentId: karenAgent.id,
    },
  });
  const agentA = await db.user.create({
    data: { username: "agent-a", email: "agent-a@example.invalid", kind: "agent", status: "active" },
  });
  const agentB = await db.user.create({
    data: { username: "agent-b", email: "agent-b@example.invalid", kind: "agent", status: "active" },
  });
  const human = await db.user.create({
    data: { username: "zeh-test", email: "zeh-test@example.invalid", kind: "human", status: "active", isOwner: true },
  });
  const project = await db.project.create({
    data: { slug: "guard-test", name: "Guard Test" },
  });

  type TaskSeed = {
    key: string;
    assigneeId?: string;
    actingManagerId?: string;
    reporterId?: string;
    activity?: { kind: string; userId: string; payload: Record<string, unknown>; createdAt: Date };
  };
  const seeds: TaskSeed[] = [
    // 1. Engine refill, actor == assignee (the PH-124 pattern): NOT cleared.
    {
      key: "t1-engine-ready-for-review",
      assigneeId: agentA.id,
      activity: {
        kind: "task.assign",
        userId: agentA.id,
        payload: { from: null, to: "agent-a", via: "ready-for-review", epicId: "e", approvedPlanPreserved: false },
        createdAt: settled,
      },
    },
    // 2. Unattributed agent self-write: cleared, with reason logged.
    {
      key: "t2-unattributed-self-write",
      assigneeId: agentA.id,
      activity: {
        kind: "task.assign",
        userId: agentA.id,
        payload: { from: null, to: "agent-a" },
        createdAt: settled,
      },
    },
    // 3. Human actor assigned the agent: NOT cleared.
    {
      key: "t3-human-actor",
      assigneeId: agentA.id,
      activity: {
        kind: "task.assign",
        userId: human.id,
        payload: { from: null, to: "agent-a" },
        createdAt: settled,
      },
    },
    // 4. Proposal-apply payload (legacy shape: proposing agent as userId): NOT cleared.
    {
      key: "t4-proposal-apply",
      assigneeId: agentA.id,
      activity: {
        kind: "task.assign",
        userId: agentA.id,
        payload: { from: null, to: "agent-a", proposalId: "prop-1" },
        createdAt: settled,
      },
    },
    // 5. Unattributed self-write younger than the settle window: NOT cleared.
    {
      key: "t5-settle-window",
      assigneeId: agentA.id,
      activity: {
        kind: "task.assign",
        userId: agentA.id,
        payload: { from: null, to: "agent-a" },
        createdAt: fresh,
      },
    },
    // 6. assignedBy stamp alone attributes the row: NOT cleared.
    {
      key: "t6-assigned-by-stamp",
      assigneeId: agentA.id,
      activity: {
        kind: "task.assign",
        userId: agentA.id,
        payload: { from: null, to: "agent-a", assignedBy: "engine" },
        createdAt: settled,
      },
    },
    // 7. actingManager mirror: unattributed self-write is cleared.
    {
      key: "t7-acting-manager-self-write",
      actingManagerId: agentB.id,
      activity: {
        kind: "task.acting_manager",
        userId: agentB.id,
        payload: { from: null, to: "agent-b" },
        createdAt: settled,
      },
    },
    // 8. Agent reporter: unconditional clear (separate policy, unchanged).
    { key: "t8-agent-reporter", reporterId: agentA.id },
  ];

  const taskIdByKey = new Map<string, string>();
  for (const seed of seeds) {
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: seed.key,
        reporterId: seed.reporterId ?? human.id,
        assigneeId: seed.assigneeId ?? null,
        actingManagerId: seed.actingManagerId ?? null,
      },
    });
    taskIdByKey.set(seed.key, task.id);
    if (seed.activity) {
      await db.activityLog.create({
        data: {
          projectId: project.id,
          taskId: task.id,
          userId: seed.activity.userId,
          kind: seed.activity.kind,
          payload: JSON.stringify(seed.activity.payload),
          createdAt: seed.activity.createdAt,
        },
      });
    }
  }

  // Epic mirror: unattributed self-write cleared, attributed left alone.
  const epic1 = await db.epic.create({
    data: { projectId: project.id, title: "e1-unattributed", actingManagerId: agentB.id, reporterId: human.id },
  });
  await db.activityLog.create({
    data: {
      projectId: project.id,
      userId: agentB.id,
      kind: "epic.acting_manager",
      payload: JSON.stringify({ epicId: epic1.id, from: null, to: "agent-b" }),
      createdAt: settled,
    },
  });
  const epic2 = await db.epic.create({
    data: { projectId: project.id, title: "e2-attributed", actingManagerId: agentB.id, reporterId: human.id },
  });
  await db.activityLog.create({
    data: {
      projectId: project.id,
      userId: agentB.id,
      kind: "epic.acting_manager",
      payload: JSON.stringify({ epicId: epic2.id, from: null, to: "agent-b", via: "epic-manager-workflow" }),
      createdAt: settled,
    },
  });

  await db.$disconnect();

  // --- run the guard end-to-end (same entrypoint the live wrapper execs) --
  const guard = spawnSync("pnpm", ["exec", "tsx", "scripts/pm-self-assignment-guard.ts"], {
    cwd: webRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (guard.status !== 0) {
    console.error(guard.stdout);
    console.error(guard.stderr);
    throw new Error(`guard exited ${guard.status}`);
  }

  // --- assertions -------------------------------------------------------
  const taskByKey = async (key: string) => {
    const id = taskIdByKey.get(key);
    assert(id, `seeded task ${key}`);
    const task = await db.task.findUnique({
      where: { id },
      select: { assigneeId: true, actingManagerId: true, reporterId: true },
    });
    assert(task, `task ${key} still exists`);
    return task;
  };

  assert.equal((await taskByKey("t1-engine-ready-for-review")).assigneeId, agentA.id, "engine ready-for-review assignment survives");
  assert.equal((await taskByKey("t2-unattributed-self-write")).assigneeId, null, "unattributed agent self-write is cleared");
  assert.equal((await taskByKey("t3-human-actor")).assigneeId, agentA.id, "human-actor assignment survives");
  assert.equal((await taskByKey("t4-proposal-apply")).assigneeId, agentA.id, "proposal-apply assignment survives");
  assert.equal((await taskByKey("t5-settle-window")).assigneeId, agentA.id, "row inside settle window is left alone");
  assert.equal((await taskByKey("t6-assigned-by-stamp")).assigneeId, agentA.id, "assignedBy-stamped assignment survives");
  assert.equal((await taskByKey("t7-acting-manager-self-write")).actingManagerId, null, "unattributed actingManager self-write is cleared");
  assert.equal((await taskByKey("t8-agent-reporter")).reporterId, null, "agent reporter still cleared unconditionally");

  const epic1After = await db.epic.findUnique({ where: { id: epic1.id }, select: { actingManagerId: true } });
  const epic2After = await db.epic.findUnique({ where: { id: epic2.id }, select: { actingManagerId: true } });
  assert.equal(epic1After?.actingManagerId, null, "unattributed epic actingManager self-write is cleared");
  assert.equal(epic2After?.actingManagerId, agentB.id, "attributed epic actingManager survives");

  // The guard's own log must carry the reason (rule + matched activity row).
  const t2Id = taskIdByKey.get("t2-unattributed-self-write");
  const t2Row = await db.activityLog.findFirst({
    where: { taskId: t2Id, kind: "task.assign" },
    select: { id: true },
  });
  const guardLog = await db.activityLog.findFirst({
    where: { taskId: t2Id, kind: "pm.self_assignment_guard" },
    select: { payload: true, userId: true },
  });
  assert(guardLog?.payload, "guard logged a pm.self_assignment_guard row for the cleared task");
  assert.equal(guardLog.userId, karen.id, "guard log attributed to the monitor user");
  const parsed = JSON.parse(guardLog.payload) as {
    repairs: Array<{ field: string; reason?: { rule: string; activityId: string; via: string | null } }>;
  };
  const repair = parsed.repairs.find((r) => r.field === "assigneeId");
  assert(repair?.reason, "cleared repair carries a reason");
  assert.equal(repair.reason.rule, "unattributed-agent-self-write", "reason names the rule that fired");
  assert.equal(repair.reason.activityId, t2Row?.id, "reason references the matched task.assign row");
  assert.equal(repair.reason.via, null, "reason records the (absent) via");

  // Untouched tasks must not accrue guard logs (no false-positive noise).
  const t1GuardLog = await db.activityLog.findFirst({
    where: { taskId: taskIdByKey.get("t1-engine-ready-for-review"), kind: "pm.self_assignment_guard" },
  });
  assert.equal(t1GuardLog, null, "no guard log for the surviving engine assignment");

  await db.$disconnect();
  console.log("pm-self-assignment-guard-test: all assertions passed");
}

main()
  .then(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
