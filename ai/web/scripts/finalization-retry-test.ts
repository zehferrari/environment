// V23-38: a cleanup error must not invalidate the job's own bounded retry.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "finalization-retry-"));
  process.env.DATABASE_URL = `file:${sandbox}/test.db`;
  process.env.PM_EPIC_MERGE_DIR = `${sandbox}/spool`;
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.PM_WORKTREE_REMOVE_SCRIPT = `${sandbox}/cleanup.py`;
  const failFlag = `${sandbox}/fail-cleanup`;
  const calls = `${sandbox}/cleanup-calls`;
  // Only the OS cleanup boundary is injected; Git, DB, spool, correlation,
  // callbacks, procedure execution and reviewer retries are real.
  await writeFile(process.env.PM_WORKTREE_REMOVE_SCRIPT, `import os,sys\nwith open(${JSON.stringify(calls)}, 'a') as f: f.write('cleanup\\n')\nif os.path.exists(${JSON.stringify(failFlag)}):\n print('worktree-remove: permission denied while preflighting worktree removal: orders/vendor', file=sys.stderr)\n sys.exit(1)\n`);
  await exec("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { runEpicMergeSpoolJob } = await import("@/lib/deploy/epic-merge");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");
    const { createProcedureRun, runProcedureRunner } = await import("@/lib/tasks/orchestrator/procedure-runner");
    const { registerFinalizeAcceptedReviewHandlers } = await import("@/lib/tasks/orchestrator/handlers/review-decisions");
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    registerFinalizeAcceptedReviewHandlers();
    const reviewer = await db.user.create({ data: { username: "reviewer", email: "reviewer@retry.invalid", kind: "human", isOwner: true } });
    const agent = await db.agent.create({ data: { slug: "monitor", name: "Monitor", role: "monitor" } });
    await db.user.create({ data: { username: "monitor", email: "monitor@retry.invalid", kind: "agent", agentId: agent.id } });
    const repo = `${sandbox}/repo`;
    const remote = `${sandbox}/origin.git`;
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["init", repo]);
    const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@retry.invalid");
    await git("commit", "--allow-empty", "-m", "base");
    const sha = await git("rev-parse", "HEAD");
    await git("remote", "add", "origin", remote);
    const project = await db.project.create({ data: { slug: "retry", name: "Retry", workMode: "code", repositoryPath: repo } });
    async function fixture(name: string) {
      const wt = `${repo}.worktrees/${name}`;
      await git("worktree", "add", "-b", name, wt);
      await git("push", "origin", name);
      const task = await db.task.create({ data: { title: name, projectId: project.id, branchName: name, status: "Review", workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: new Date(), workflowVersion: 1, actingManagerId: reviewer.id, reporterId: reviewer.id, approvedOn: new Date() } });
      const cycle = await db.$transaction((tx) => openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 1 }));
      assert.ok(cycle);
      const review = await db.reviewRun.create({ data: { taskId: task.id, workflowCycleId: cycle.id, status: "accepted", reviewerId: reviewer.id, reviewedAt: new Date(), candidateSha: sha, baseSha: sha, repoTouched: true, validationOutcome: "valid" } });
      const repository = await db.taskRepositoryRun.create({ data: { taskId: task.id, workflowCycleId: cycle.id, repositoryPath: repo, branchName: name, worktreePath: wt, candidateSha: sha, baseSha: sha, reviewedSha: sha, repoTouched: true, validationOutcome: "succeeded", phase: "finalizing", version: 29, publicationState: "publishing" } });
      const procedure = await db.$transaction((tx) => createProcedureRun(tx, { taskId: task.id, workflowCycleId: cycle.id, triggerTransitionId: `test:${name}`, type: "finalize_accepted_review", input: { reviewRunId: review.id, candidateSha: sha } }));
      const job = { kind: "finalize" as const, jobId: `proc-finalize-${procedure.procedureRunId}-${procedure.stepIds[0]}`, taskId: task.id, projectId: project.id, requestedByUserId: reviewer.id, requestedByUsername: reviewer.username, candidateSha: sha, baseSha: sha, schemaVersion: 2 as const, workflowCycleId: cycle.id, procedureRunId: procedure.procedureRunId, procedureStepId: procedure.stepIds[0], repositoryRunId: repository.id, repositoryRunVersion: 29, commandReceiptId: null, enqueuedAt: new Date().toISOString() };
      await db.taskProcedureStep.update({ where: { id: job.procedureStepId }, data: { status: "waiting_callback", output: JSON.stringify(job) } });
      await db.taskProcedureRun.update({ where: { id: procedure.procedureRunId }, data: { status: "running", currentStep: "finalize_repository" } });
      return { task, review, job, procedure };
    }
    async function takeRetry() {
      const files = (await readdir(process.env.PM_EPIC_MERGE_DIR!)).filter((f) => f.endsWith(".json"));
      assert.equal(files.length, 1);
      const file = path.join(process.env.PM_EPIC_MERGE_DIR!, files[0]);
      const job = JSON.parse(await readFile(file, "utf8"));
      await rm(file);
      return job;
    }
    const transient = await fixture("transient");
    await writeFile(failFlag, "fail");
    const first = await runEpicMergeSpoolJob(transient.job);
    assert.equal(first.outcome, "operational-retry");
    assert.equal((await db.taskRepositoryRun.findUniqueOrThrow({ where: { taskId: transient.task.id } })).version, 29, "reporting a pending retry must preserve its repository identity");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: transient.task.id } })).alertReporter, true);
    assert.equal(await db.workflowOutbox.count({ where: { taskId: transient.task.id, effectType: "task_notification" } }), 0, "bounded retries must not wake a competing reviewer retry");
    const retry = await takeRetry();
    await rm(failFlag);
    const recovered = await runEpicMergeSpoolJob(retry);
    assert.equal(recovered.outcome, "callback-applied", JSON.stringify(recovered));
    const callsBeforeReplay = await readFile(calls, "utf8");
    assert.equal((await runEpicMergeSpoolJob(retry)).outcome, "replayed");
    assert.equal(await readFile(calls, "utf8"), callsBeforeReplay, "callback replay must not repeat cleanup");
    await runProcedureRunner({ limit: 1 }); // verify_finalization
    await runProcedureRunner({ limit: 1 }); // complete_review
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: transient.task.id } })).status, "Done");
    // Stop the remaining notification steps: this test never wakes agents.
    await db.taskProcedureRun.update({ where: { id: transient.procedure.procedureRunId }, data: { status: "completed" } });
    console.log("PASS transient cleanup failure, exact retry, Done transition and replay");

    const persistent = await fixture("persistent");
    await writeFile(failFlag, "fail");
    assert.equal((await runEpicMergeSpoolJob(persistent.job)).outcome, "operational-retry");
    assert.equal((await runEpicMergeSpoolJob(await takeRetry())).outcome, "operational-retry");
    assert.equal((await runEpicMergeSpoolJob(await takeRetry())).outcome, "operational-error");
    assert.equal((await db.taskProcedureStep.findUniqueOrThrow({ where: { id: persistent.job.procedureStepId } })).status, "completed", "exhaustion must consume the callback");
    await runProcedureRunner({ limit: 1 });
    const failed = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: persistent.procedure.procedureRunId } });
    assert.equal(failed.status, "operational_error");
    assert.match(failed.lastError!, /permission denied/);
    assert.equal((await db.reviewRun.findUniqueOrThrow({ where: { id: persistent.review.id } })).status, "accepted");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: persistent.task.id } })).status, "Review");
    const stranger = await db.user.create({ data: { username: "stranger", email: "stranger@retry.invalid", kind: "human" } });
    const recoveryCommand = {
      taskId: persistent.task.id, intent: "accept_review" as const,
      actor: { id: reviewer.id, kind: "human" as const, username: "reviewer", role: "reviewer" as const },
      source: "human" as const, expectedWorkflowVersion: 1,
      payload: { reviewRunId: persistent.review.id, candidateSha: sha },
    };
    assert.equal((await submitWorkflowCommand({ ...recoveryCommand, idempotencyKey: "wrong-reviewer", actor: { ...recoveryCommand.actor, id: stranger.id, username: "stranger" } })).status, "forbidden");
    for (const [key, payload] of Object.entries({ wrongCandidate: { ...recoveryCommand.payload, candidateSha: "wrong" }, wrongLease: { ...recoveryCommand.payload, reviewRunId: "wrong" } })) {
      const rejected = await submitWorkflowCommand({ ...recoveryCommand, idempotencyKey: key, payload });
      assert.equal(rejected.status, "stale", JSON.stringify(rejected));
    }
    const restart = await submitWorkflowCommand({ taskId: persistent.task.id, intent: "accept_review", actor: { id: reviewer.id, kind: "human", username: "reviewer", role: "reviewer" }, source: "human", expectedWorkflowVersion: 1, idempotencyKey: "retry-after-host-repair", payload: { reviewRunId: persistent.review.id, candidateSha: sha } });
    assert.equal(restart.status, "accepted", JSON.stringify(restart));
    assert.notEqual(restart.procedureId, persistent.procedure.procedureRunId, "explicit recovery creates a fresh procedure for the accepted candidate");
    await db.taskProcedureRun.update({ where: { id: restart.procedureId! }, data: { status: "completed" } });
    console.log("PASS bounded exhaustion, visible terminal error and explicit recovery");

    const historical = await fixture("historical");
    const { recordTaskReviewOperationalError } = await import("@/lib/tasks/review-handoff");
    await recordTaskReviewOperationalError({ taskId: historical.task.id, error: "permission denied: orders/vendor", preserveValidationOutcome: true });
    const historicalRetry = await submitWorkflowCommand({ ...recoveryCommand, taskId: historical.task.id, idempotencyKey: "recover-historical-stall", payload: { reviewRunId: historical.review.id, candidateSha: sha } });
    assert.equal(historicalRetry.status, "accepted", JSON.stringify(historicalRetry));
    assert.notEqual(historicalRetry.procedureId, historical.procedure.procedureRunId);
    assert.equal((await db.taskProcedureRun.findUniqueOrThrow({ where: { id: historical.procedure.procedureRunId } })).status, "superseded");
    const beforeLateDelivery = await readFile(calls, "utf8");
    assert.equal((await runEpicMergeSpoolJob(historical.job)).outcome, "rejected-correlation");
    assert.equal(await readFile(calls, "utf8"), beforeLateDelivery);
    await db.taskProcedureRun.update({ where: { id: historicalRetry.procedureId! }, data: { status: "completed" } });
    console.log("PASS historical missing callback recovery fences the abandoned job");

    const dirty = await fixture("dirty");
    await writeFile(`${repo}.worktrees/dirty/unreviewed.txt`, "unreviewed work");
    assert.equal((await runEpicMergeSpoolJob(dirty.job)).outcome, "callback-applied");
    const dirtyRepository = await db.taskRepositoryRun.findUniqueOrThrow({ where: { taskId: dirty.task.id } });
    assert.equal(dirtyRepository.phase, "operational_error", "non-transient finalization failure must allow reviewer recovery");
    assert.equal(dirtyRepository.validationOutcome, "succeeded");
    assert.equal((await db.reviewRun.findUniqueOrThrow({ where: { id: dirty.review.id } })).status, "accepted");
    const wake = await db.workflowOutbox.findFirstOrThrow({ where: { taskId: dirty.task.id, effectType: "task_notification" } });
    assert.equal(JSON.parse(wake.payload).targetUserId, reviewer.id);
    assert.equal(JSON.parse(wake.payload).reason, "review_requested");
    await runProcedureRunner({ limit: 1 });
    assert.equal((await db.taskProcedureRun.findUniqueOrThrow({ where: { id: dirty.procedure.procedureRunId } })).status, "operational_error");
    await rm(`${repo}.worktrees/dirty/unreviewed.txt`);
    const dirtyRetry = await submitWorkflowCommand({ ...recoveryCommand, taskId: dirty.task.id, idempotencyKey: "retry-after-dirty-repair", payload: { reviewRunId: dirty.review.id, candidateSha: sha } });
    assert.equal(dirtyRetry.status, "accepted", JSON.stringify(dirtyRetry));
    await db.taskProcedureRun.update({ where: { id: dirtyRetry.procedureId! }, data: { status: "completed" } });
    console.log("PASS dirty candidate failure preserves acceptance and wakes the reviewer for a fenced retry");

    const stale = await fixture("stale");
    assert.equal((await runEpicMergeSpoolJob(stale.job)).outcome, "operational-retry");
    const staleRetry = await takeRetry();
    await db.taskRepositoryRun.update({ where: { taskId: stale.task.id }, data: { version: { increment: 1 } } });
    const callsBeforeStale = await readFile(calls, "utf8");
    assert.equal((await runEpicMergeSpoolJob(staleRetry)).outcome, "rejected-correlation");
    assert.equal(await readFile(calls, "utf8"), callsBeforeStale, "a newer repository version must fence cleanup");
    console.log("PASS unrelated repository changes still reject stale retries");
  } finally {
    await db.$disconnect();
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
