import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "workflow-kernel-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  try {
    await execFileP(
      "pnpm",
      ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
    );
    const { db } = await import("@/lib/db");
    const {
      TaskTransitionRejected,
      applyTaskTransition,
      transitionTask,
    } = await import("@/lib/tasks/transition-kernel");
    const { drainWorkflowOutbox } = await import("@/lib/tasks/workflow-outbox-drain");

    const actor = await db.user.create({
      data: { username: "kernel-owner", email: "kernel@example.invalid", kind: "human" },
    });
    const project = await db.project.create({
      data: { slug: "workflow-kernel", name: "Workflow Kernel" },
    });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Atomic transition",
        status: "To Do",
        approvedOn: new Date(),
        approvedById: actor.id,
      },
    });

    const first = await transitionTask({
      taskId: task.id,
      projectId: project.id,
      actorUserId: actor.id,
      intent: "start",
      from: "To Do",
      to: "In Progress",
      source: "kernel-test",
      idempotencyKey: "start:one",
      expectedVersion: 0,
      effects: [{ type: "board_touch", key: "board-start", payload: {} }],
    });
    assert.equal(first.replayed, false);
    assert.equal(first.transition.workflowVersion, 1);
    const afterFirst = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(afterFirst.status, "In Progress");
    assert.equal(afterFirst.workflowVersion, 1);
    assert.equal(await db.workflowTransition.count({ where: { taskId: task.id } }), 1);
    assert.equal(await db.workflowOutbox.count({ where: { taskId: task.id } }), 1);

    const replay = await transitionTask({
      taskId: task.id,
      projectId: project.id,
      actorUserId: actor.id,
      intent: "start",
      from: "To Do",
      to: "In Progress",
      source: "kernel-test",
      idempotencyKey: "start:one",
      expectedVersion: 0,
      effects: [{ type: "board_touch", key: "board-start", payload: {} }],
    });
    assert.equal(replay.replayed, true);
    assert.equal(await db.workflowTransition.count({ where: { taskId: task.id } }), 1);
    assert.equal(await db.workflowOutbox.count({ where: { taskId: task.id } }), 1);

    await assert.rejects(
      () => transitionTask({
        taskId: task.id,
        projectId: project.id,
        actorUserId: actor.id,
        intent: "submit_review",
        from: "In Progress",
        to: "Review",
        source: "kernel-test",
        idempotencyKey: "review:stale",
        expectedVersion: 0,
      }),
      (error: unknown) => error instanceof TaskTransitionRejected && error.code === "version_conflict",
    );

    const invalid = await db.task.create({
      data: { projectId: project.id, title: "Invalid edge", status: "Backlog" },
    });
    await assert.rejects(
      () => transitionTask({
        taskId: invalid.id,
        projectId: project.id,
        actorUserId: actor.id,
        intent: "accept_review",
        from: "Backlog",
        to: "Done",
        source: "kernel-test",
        idempotencyKey: "invalid-edge",
      }),
      (error: unknown) => error instanceof TaskTransitionRejected && error.code === "invalid_edge",
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: invalid.id } })).status, "Backlog");

    // Operator override is the one intent that may traverse an otherwise
    // illegal edge, but it still runs the full CAS + idempotency + audit
    // machinery: the ledger row records intent "operator_override" so forced
    // moves stay visible in history.
    const override = await transitionTask({
      taskId: invalid.id,
      projectId: project.id,
      actorUserId: actor.id,
      intent: "operator_override",
      from: "Backlog",
      to: "Done",
      source: "kernel-test",
      idempotencyKey: "override:one",
      expectedVersion: 0,
      evidence: { operatorOverride: true },
      effects: [{ type: "board_touch", key: "board:operator_override", payload: {} }],
    });
    assert.equal(override.replayed, false);
    assert.equal(override.transition.intent, "operator_override");
    assert.equal(override.transition.fromStatus, "Backlog");
    assert.equal(override.transition.toStatus, "Done");
    assert.equal(override.transition.workflowVersion, 1);
    const afterOverride = await db.task.findUniqueOrThrow({ where: { id: invalid.id } });
    assert.equal(afterOverride.status, "Done");
    assert.equal(afterOverride.workflowVersion, 1);
    assert.match(override.transition.evidence ?? "", /operatorOverride/);

    const overrideReplay = await transitionTask({
      taskId: invalid.id,
      projectId: project.id,
      actorUserId: actor.id,
      intent: "operator_override",
      from: "Backlog",
      to: "Done",
      source: "kernel-test",
      idempotencyKey: "override:one",
      expectedVersion: 0,
    });
    assert.equal(overrideReplay.replayed, true);
    assert.equal(await db.workflowTransition.count({ where: { taskId: invalid.id } }), 1);

    // Break-glass does not bypass concurrency control: a stale expected
    // version still rejects an override.
    await assert.rejects(
      () => transitionTask({
        taskId: invalid.id,
        projectId: project.id,
        actorUserId: actor.id,
        intent: "operator_override",
        from: "Done",
        to: "Backlog",
        source: "kernel-test",
        idempotencyKey: "override:stale",
        expectedVersion: 0,
      }),
      (error: unknown) => error instanceof TaskTransitionRejected && error.code === "version_conflict",
    );

    // A forced failure after the task CAS proves the status, ledger and outbox
    // share one rollback boundary.
    const rollback = await db.task.create({
      data: { projectId: project.id, title: "Rollback", status: "To Do" },
    });
    await assert.rejects(() => db.$transaction(async (tx) => {
      await applyTaskTransition(tx, {
        taskId: rollback.id,
        projectId: project.id,
        actorUserId: actor.id,
        intent: "start",
        from: "To Do",
        to: "In Progress",
        source: "kernel-test",
        idempotencyKey: "rollback",
        effects: [{ type: "board_touch", key: "never-commit", payload: {} }],
        mutate: async () => { throw new Error("injected crash"); },
      });
    }), /injected crash/);
    const afterRollback = await db.task.findUniqueOrThrow({ where: { id: rollback.id } });
    assert.equal(afterRollback.status, "To Do");
    assert.equal(afterRollback.workflowVersion, 0);
    assert.equal(await db.workflowTransition.count({ where: { taskId: rollback.id } }), 0);
    assert.equal(await db.workflowOutbox.count({ where: { taskId: rollback.id } }), 0);

    // Two pending effects: the first start's board_touch plus the operator
    // override's board_touch — override side effects flow through the same
    // outbox as every other transition.
    const drained = await drainWorkflowOutbox({ limit: 5, workerId: "kernel-test" });
    assert.equal(drained.completed, 2);
    assert.equal(
      (await db.workflowOutbox.findFirstOrThrow({ where: { taskId: task.id } })).status,
      "completed",
    );

    // Expired leases are reclaimable; a one-way dispatching state cannot park
    // an effect forever after worker death.
    await db.workflowOutbox.create({
      data: {
        taskId: rollback.id,
        projectId: project.id,
        aggregateVersion: 0,
        effectType: "board_touch",
        payload: "{}",
        dedupeKey: "expired-lease",
        status: "dispatching",
        attempts: 1,
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    const reclaimed = await drainWorkflowOutbox({ limit: 1, workerId: "replacement-worker" });
    assert.equal(reclaimed.completed, 1);
    assert.equal(
      (await db.workflowOutbox.findUniqueOrThrow({ where: { dedupeKey: "expired-lease" } })).status,
      "completed",
    );

    // Service-layer contract: the browser move paths reach the
    // operator_override intent only behind the explicit opt-in request flag,
    // and reject non-admin actors server-side. moveTaskStatus needs a browser
    // session, so (like the other UI contract tests) the gate is locked in at
    // the source level.
    const readSource = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const rel of [
      "lib/tasks/move-status.ts",
      "app/(app)/workspaces/[slug]/page.tsx",
      "app/(app)/workspaces/(landing)/page.tsx",
    ]) {
      const source = readSource(rel);
      const overrideBranch = source.indexOf("if (options?.operatorOverride) {");
      assert(overrideBranch !== -1, `${rel} must gate the override on the explicit request flag`);
      const adminGuard = source.indexOf('if (actor.kind !== "human" || !actor.isOwner) {', overrideBranch);
      assert(adminGuard !== -1, `${rel} must reject non-admin operator overrides`);
      const intentUse = source.indexOf('intent: "operator_override"', adminGuard);
      assert(intentUse !== -1, `${rel} must route the override through the audited kernel intent`);
      assert.equal(
        source.split('intent: "operator_override"').length,
        2,
        `${rel} must apply the operator_override intent only inside the admin-gated opt-in branch`,
      );
    }
    const boardSource = readSource("app/(app)/projects/[slug]/board-client.tsx");
    assert(
      boardSource.includes("canOperatorOverride && !options?.operatorOverride"),
      "board must offer the override confirm only to admins and never re-prompt a failed override",
    );
    assert(
      boardSource.includes("{ operatorOverride: true }"),
      "board must re-submit with the explicit override flag only after the confirm",
    );

    await db.$disconnect();
    console.log("[workflow-transition-kernel] PASS");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
