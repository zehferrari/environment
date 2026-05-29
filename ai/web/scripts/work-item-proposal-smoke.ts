// Work-item proposal validator smoke (agent planning, Slice 1).
//
// Exercises lib/work-items/proposal.ts::validateProposal and
// lib/agents/work-item-token.ts against a hermetic throwaway sqlite DB,
// mirroring scripts/pm-dispatch-integration.ts. The full Next request /
// grant / auth path on POST /api/agent/projects/[id]/proposals is not in
// scope here (it lands with the apply loop + UI in Slice 3); this script
// pins the change-set rules + temp-ref resolution + token round-trip +
// planId uniqueness so they fail loudly if they drift.
//
// Run with:
//   pnpm tsx scripts/work-item-proposal-smoke.ts
//
// Exit 0 on success, non-zero on any failed check. Hermetic: the temp
// sqlite file is always removed in the finally block.
//
// NB: validateProposal uses the @/lib/db singleton, which binds
// DATABASE_URL at construct time, so the temp URL is set BEFORE the
// dynamic import of lib/db / proposal.ts. Token helpers are pure and may
// be imported statically; the ProposalValidation import is type-only
// (elided at runtime, so it does not trigger the db singleton early).

import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { randomUUID } from "crypto";
import { promisify } from "util";

import {
  createWorkItemGrantToken,
  verifyWorkItemGrantToken,
} from "../lib/agents/work-item-token";
import type { ProposalValidation } from "../lib/work-items/proposal";

const execFileP = promisify(execFile);

function fail(msg: string): never {
  console.error(`[work-item-proposal] FAIL: ${msg}`);
  process.exit(1);
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(
      `  FAIL ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`,
    );
  }
}
function expectOk(name: string, v: ProposalValidation) {
  check(name, v.ok, v.ok ? undefined : v.results.filter((r) => !r.ok));
}
function expectRootError(name: string, v: ProposalValidation, substr: string) {
  const errs = v.results[0]?.errors ?? [];
  check(name, !v.ok && errs.some((e) => e.includes(substr)), errs);
}
function expectOpError(
  name: string,
  v: ProposalValidation,
  idx: number,
  substr: string,
) {
  const r = v.results[idx];
  check(name, !!r && !r.ok && r.errors.some((e) => e.includes(substr)), r?.errors);
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

async function main(): Promise<void> {
  // Token HMAC needs a secret; this smoke is hermetic, so any stable value
  // works. The token module reads AUTH_SECRET lazily at call time, so this
  // does not change production behaviour. Real envs already set it.
  process.env.AUTH_SECRET ??= "smoke-test-secret";

  const sandbox = await mkdtemp(path.join(tmpdir(), "wip-proposal-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const originalDbUrl = process.env.DATABASE_URL;
  let db: { $disconnect: () => Promise<void> } | undefined;

  try {
    await dbPush(dbUrl);

    // Bind the singleton to the temp DB, THEN import the modules that use it.
    process.env.DATABASE_URL = dbUrl;
    const dbMod = await import("../lib/db");
    const { validateProposal } = await import("../lib/work-items/proposal");
    db = dbMod.db as unknown as { $disconnect: () => Promise<void> };
    const prisma = dbMod.db;

    // --- seed (coding agent + human + project + an epic + two tasks) ---
    const agent = await prisma.agent.create({
      data: { slug: "smokecoder", name: "Smoke Coder", role: "coding" },
    });
    const agentUser = await prisma.user.create({
      data: {
        username: "smokecoder",
        email: "smokecoder@smoke.test",
        kind: "agent",
        agentId: agent.id,
      },
    });
    const human = await prisma.user.create({
      data: { username: "smoke-human", email: "smoke-human@smoke.test", kind: "human" },
    });
    const project = await prisma.project.create({
      data: { slug: "wip-smoke", name: "WIP Smoke" },
    });
    const epic = await prisma.epic.create({
      data: { projectId: project.id, title: "Existing Epic", status: "open" },
    });
    const tDone = await prisma.task.create({
      data: {
        projectId: project.id,
        title: "Done task",
        status: "Done",
        rank: 1,
        statusChangedAt: new Date(),
      },
    });
    const tTodo = await prisma.task.create({
      data: {
        projectId: project.id,
        title: "Todo task",
        status: "To Do",
        rank: 2,
        statusChangedAt: new Date(),
      },
    });

    const actor = { userId: agentUser.id, agentSlug: agent.slug };
    const P = project.id;

    // --- token round-trip ---
    const tok = createWorkItemGrantToken(P, agent.slug, "msg_1");
    check("token verifies", verifyWorkItemGrantToken(P, agent.slug, "msg_1", tok));
    check("token rejects tamper", !verifyWorkItemGrantToken(P, agent.slug, "msg_1", `${tok}x`));
    check("token rejects wrong message", !verifyWorkItemGrantToken(P, agent.slug, "msg_2", tok));

    // --- root-level shape errors ---
    expectRootError("not an array", await validateProposal(P, {} as unknown, actor), "array");
    expectRootError("empty array", await validateProposal(P, [], actor), "empty");

    // --- unknown op ---
    expectOpError("unknown op", await validateProposal(P, [{ op: "frobnicate" }], actor), 0, "unknown op");

    // --- happy path: epic + task under it + subtask under task ---
    expectOk(
      "nested create (epic→task→subtask)",
      await validateProposal(
        P,
        [
          { op: "create_epic", ref: "tmp:e1", title: "Epic One", description: "x" },
          { op: "create_task", ref: "tmp:t1", title: "Task One", epic: "tmp:e1" },
          { op: "create_subtask", ref: "tmp:s1", parent: "tmp:t1", title: "Sub One" },
        ],
        actor,
      ),
    );

    // --- create field rules ---
    expectOpError("epic requires title", await validateProposal(P, [{ op: "create_epic", ref: "tmp:e1" }], actor), 0, "title is required");
    expectOpError("create requires tmp ref", await validateProposal(P, [{ op: "create_task", ref: "t1", title: "X" }], actor), 0, "tmp:");
    expectOpError("undeclared epic ref", await validateProposal(P, [{ op: "create_task", ref: "tmp:t1", title: "X", epic: "tmp:nope" }], actor), 0, "not declared");
    expectOk("link existing epic id", await validateProposal(P, [{ op: "create_task", ref: "tmp:t1", title: "X", epic: epic.id }], actor));
    expectOpError("bogus epic id", await validateProposal(P, [{ op: "create_task", ref: "tmp:t1", title: "X", epic: "c_nope" }], actor), 0, "not found");
    expectOpError("subtask requires parent", await validateProposal(P, [{ op: "create_subtask", ref: "tmp:s1", title: "X" }], actor), 0, "parent");

    // --- duplicate ref ---
    {
      const v = await validateProposal(
        P,
        [
          { op: "create_epic", ref: "tmp:dup", title: "A" },
          { op: "create_epic", ref: "tmp:dup", title: "B" },
        ],
        actor,
      );
      check("duplicate ref flagged", !v.ok && v.results.some((r) => r.errors.some((e) => e.includes("duplicate ref"))), v.results);
    }

    // --- agent guardrails (validated as the agent, not the approver) ---
    expectOpError("self-assign blocked", await validateProposal(P, [{ op: "create_task", ref: "tmp:t1", title: "X", assignee: agent.slug }], actor), 0, "self-assign");
    expectOk("assign to human ok", await validateProposal(P, [{ op: "create_task", ref: "tmp:t1", title: "X", assignee: human.username }], actor));
    expectOpError("self acting-manager blocked", await validateProposal(P, [{ op: "create_task", ref: "tmp:t1", title: "X", actingManager: agent.slug }], actor), 0, "acting manager");
    expectOpError("unknown assignee", await validateProposal(P, [{ op: "create_task", ref: "tmp:t1", title: "X", assignee: "ghost" }], actor), 0, "not an active assignable principal");

    // --- transitions ---
    expectOpError("transition out of Done blocked", await validateProposal(P, [{ op: "update_task", target: tDone.id, status: "Review" }], actor), 0, "Review/Done");
    expectOk("allowed transition To Do→In Progress", await validateProposal(P, [{ op: "update_task", target: tTodo.id, status: "In Progress" }], actor));
    expectOpError("invalid task status", await validateProposal(P, [{ op: "update_task", target: tTodo.id, status: "Frozen" }], actor), 0, "unknown task status");
    expectOpError("update unknown task", await validateProposal(P, [{ op: "update_task", target: "c_nope", status: "In Progress" }], actor), 0, "not found");

    // --- parent + comment rules ---
    expectOpError("self-parent blocked", await validateProposal(P, [{ op: "update_task", target: tTodo.id, parent: tTodo.id }], actor), 0, "own parent");
    expectOk("comment ok", await validateProposal(P, [{ op: "comment_task", target: tTodo.id, body: "hi" }], actor));
    expectOpError("empty comment blocked", await validateProposal(P, [{ op: "comment_task", target: tTodo.id, body: "   " }], actor), 0, "non-empty");

    // --- planId uniqueness (idempotency backstop the endpoint relies on) ---
    const planId = `smoke-${randomUUID()}`;
    await prisma.workItemProposal.create({
      data: { planId, projectId: P, agentSlug: agent.slug, proposedByUserId: agentUser.id, operations: "[]" },
    });
    let dup = false;
    try {
      await prisma.workItemProposal.create({
        data: { planId, projectId: P, agentSlug: agent.slug, proposedByUserId: agentUser.id, operations: "[]" },
      });
    } catch (err) {
      dup = (err as { code?: string }).code === "P2002";
    }
    check("planId unique enforced", dup);

    // --- apply (commitProposal) end-to-end ---
    const { commitProposal } = await import("../lib/work-items/apply");

    const applyOps = [
      { op: "create_epic", ref: "tmp:e", title: "Smoke Epic", description: "from smoke" },
      { op: "create_task", ref: "tmp:t", title: "Smoke Task", epic: "tmp:e", assignee: human.username },
      { op: "create_subtask", ref: "tmp:s", parent: "tmp:t", title: "Smoke Sub" },
      { op: "comment_task", target: tTodo.id, body: "smoke comment" },
    ];
    const applyProposal = await prisma.workItemProposal.create({
      data: {
        planId: `apply-${randomUUID()}`,
        projectId: P,
        agentSlug: agent.slug,
        proposedByUserId: agentUser.id,
        status: "pending",
        operations: JSON.stringify(applyOps),
      },
      select: { id: true },
    });
    const applyResult = await commitProposal(applyProposal.id, human.id);
    check("apply ok", applyResult.ok, applyResult);
    check(
      "apply counts (1 epic, 1 task, 1 subtask, 1 comment)",
      applyResult.counts.epics === 1 &&
        applyResult.counts.tasks === 1 &&
        applyResult.counts.subtasks === 1 &&
        applyResult.counts.comments === 1,
      applyResult.counts,
    );

    const createdEpic = await prisma.epic.findFirst({ where: { projectId: P, title: "Smoke Epic" }, select: { id: true } });
    check("epic created", !!createdEpic);
    const createdTask = await prisma.task.findFirst({
      where: { projectId: P, title: "Smoke Task" },
      select: { id: true, epicId: true, assigneeId: true, status: true },
    });
    check("task created in Backlog", createdTask?.status === "Backlog", createdTask);
    check("task linked to created epic", !!createdTask && createdTask.epicId === createdEpic?.id, createdTask);
    check("task assigned to human", createdTask?.assigneeId === human.id, createdTask);
    const createdSub = await prisma.task.findFirst({
      where: { projectId: P, title: "Smoke Sub" },
      select: { id: true, parentTaskId: true },
    });
    check("subtask parented under task", !!createdSub && createdSub.parentTaskId === createdTask?.id, createdSub);
    const smokeComment = await prisma.comment.findFirst({
      where: { taskId: tTodo.id, body: "smoke comment" },
      select: { userId: true },
    });
    check("comment attributed to agent", smokeComment?.userId === agentUser.id, smokeComment);

    const appliedProposal = await prisma.workItemProposal.findUnique({
      where: { id: applyProposal.id },
      select: { status: true, appliedById: true },
    });
    check(
      "proposal marked applied by approver",
      appliedProposal?.status === "applied" && appliedProposal?.appliedById === human.id,
      appliedProposal,
    );
    const applySummary = await prisma.activityLog.findFirst({
      where: { kind: "workitem.proposal.apply", userId: human.id },
      select: { id: true },
    });
    check("apply summary activity is the human's", !!applySummary);
    const epicCreateActivity = await prisma.activityLog.findFirst({
      where: { kind: "epic.create", userId: agentUser.id },
      select: { id: true },
    });
    check("epic.create activity is the agent's", !!epicCreateActivity);

    const reapply = await commitProposal(applyProposal.id, human.id);
    check("re-apply blocked (already applied)", !reapply.ok && (reapply.error ?? "").includes("already"), reapply);

    const badProposal = await prisma.workItemProposal.create({
      data: {
        planId: `bad-${randomUUID()}`,
        projectId: P,
        agentSlug: agent.slug,
        proposedByUserId: agentUser.id,
        status: "pending",
        operations: JSON.stringify([{ op: "update_task", target: "c_nope", status: "In Progress" }]),
      },
      select: { id: true },
    });
    const badResult = await commitProposal(badProposal.id, human.id);
    check("invalid proposal apply blocked", !badResult.ok && (badResult.error ?? "").includes("Re-validation"), badResult);

    if (failures > 0) fail(`${failures} check(s) failed`);
    console.log(`[work-item-proposal] OK — all checks passed`);
  } finally {
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        // ignore
      }
    }
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
