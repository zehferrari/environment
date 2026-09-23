import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDevPublicationConfig } from "@/lib/projects/dev-publication-config";

async function main() {
  const dir = await mkdtemp(`${tmpdir()}/pm-standing-grant-`);
  process.env.DATABASE_URL = `file:${dir}/test.db`;
  process.env.AUTH_SECRET = "isolated-standing-authority";
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  await promisify(execFile)("pnpm", ["prisma", "db", "push", "--skip-generate"], { env: process.env });
  const { db } = await import("@/lib/db");
  const { createStandingAuthorizationForApprovedPlan, validateStandingAuthorization } = await import("@/lib/tasks/standing-authorization");
  const { withDevPublication: actualWithDevPublication, releaseTaskDevLease, verifyDevReceipt, assertDevPublicationCandidate } = await import("@/lib/deploy/dev-publication");
  // The database/lease/authority are real. Only the installed host command is
  // replaced: this sandbox maps system executable ownership to nobody.
  const withDevPublication: typeof actualWithDevPublication = args => actualWithDevPublication(args, { runCommand: async (command, config, sha) => command.args.join("").replaceAll("{sha}", sha).replaceAll("{environmentId}", config.environmentId).replaceAll("{target}", config.target) });
  try {
    const pipeline = "pipelines: {default: []}\n";
    const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", dir, ...args])).stdout.trim();
    await git("init", "-b", "task-test");
    await writeFile(`${dir}/bitbucket-pipelines.yml`, pipeline);
    await git("add", "bitbucket-pipelines.yml");
    await git("-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "fixture");
    const config = {
      environment: "development", environmentId: "shared-dev", target: "https://dev.test.invalid", repositoryPath: dir,
      allowedOperations: ["publish", "deploy"], publishTriggersDeployment: true, devOnCheckpoint: null,
      configurationFiles: [{ path: "bitbucket-pipelines.yml", sha256: createHash("sha256").update(pipeline).digest("hex") }],
      verify: { executable: "/usr/bin/printf", args: ['{"sha":"{sha}","environmentId":"{environmentId}","target":"{target}"}'], timeoutSeconds: 5 },
    };
    const parsed = parseDevPublicationConfig(JSON.stringify(config))!;
    assert.throws(() => parseDevPublicationConfig(JSON.stringify({ ...config, environment: "production" })), /non-production/);
    assert.throws(() => parseDevPublicationConfig(JSON.stringify({ ...config, allowedOperations: ["publish"] })), /deploy operation/);
    assert.throws(() => verifyDevReceipt(JSON.stringify({ sha: "b".repeat(40), environmentId: config.environmentId, target: config.target }), parsed, "a".repeat(40)), /exact published SHA/);
    const owner = await db.user.create({ data: { username: "owner", email: "owner@standing.invalid", kind: "human", isOwner: true } });
    const worker = await db.user.create({ data: { username: "worker", email: "worker@standing.invalid", kind: "agent" } });
    const reviewer = await db.user.create({ data: { username: "reviewer", email: "reviewer@standing.invalid", kind: "agent" } });
    const project = await db.project.create({ data: { slug: "standing", name: "Standing", repositoryPath: dir, devPublicationPolicy: "standing", devPublicationConfig: JSON.stringify(config) } });
    await assertDevPublicationCandidate({ projectId: project.id, repositoryPath: dir, branch: "task-test", sha: await git("rev-parse", "HEAD") });
    await writeFile(`${dir}/bitbucket-pipelines.yml`, pipeline + "# changed deployment behavior\n");
    await git("add", "bitbucket-pipelines.yml");
    await git("-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "unapproved pipeline change");
    await assert.rejects(assertDevPublicationCandidate({ projectId: project.id, repositoryPath: dir, branch: "task-test", sha: await git("rev-parse", "HEAD") }), /changes deployment configuration/);
    await writeFile(`${dir}/bitbucket-pipelines.yml`, pipeline);
    await git("add", "bitbucket-pipelines.yml");
    await git("-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "restore approved deployment configuration");
    const task = await db.task.create({ data: { projectId: project.id, title: "Named Dev scope", description: "Approved change", branchName: "task-test", status: "In Progress", approvedOn: new Date(), assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
    const plan = await db.actionPlan.create({ data: { taskId: task.id, status: "approved", summary: "Named scope", contentHash: "version-one", approvedOn: new Date() } });
    assert.equal(await db.taskStandingAuthorization.count(), 0, "existing approved plans do not enroll on reads");
    const grant = await db.$transaction(tx => createStandingAuthorizationForApprovedPlan(tx, { taskId: task.id, approvedById: owner.id }));
    assert.ok(grant);
    assert.equal((await validateStandingAuthorization(db, { taskId: task.id, grantId: grant.id })).ok, true);
    const replayGrant = await db.$transaction(tx => createStandingAuthorizationForApprovedPlan(tx, { taskId: task.id, approvedById: owner.id }));
    assert.equal(replayGrant?.id, grant.id);
    for (const change of [{ description: "Expanded design" }, { actingManagerId: owner.id }, { assigneeId: owner.id }, { branchName: "main" }]) {
      await db.task.update({ where: { id: task.id }, data: change });
      assert.equal((await validateStandingAuthorization(db, { taskId: task.id, grantId: grant.id })).ok, false);
      await db.task.update({ where: { id: task.id }, data: { description: task.description, actingManagerId: reviewer.id, assigneeId: worker.id, branchName: task.branchName } });
    }
    await db.actionPlan.update({ where: { id: plan.id }, data: { version: 2 } });
    assert.equal((await validateStandingAuthorization(db, { taskId: task.id, grantId: grant.id })).ok, false);
    await db.actionPlan.update({ where: { id: plan.id }, data: { version: 1 } });
    const sha = await git("rev-parse", "HEAD"); let publications = 0;
    const args = { projectId: project.id, taskId: task.id, branch: task.branchName!, attemptId: "attempt-one", grantId: grant.id,
      publish: async () => { publications++; return { sha }; }, publishedSha: (result: { sha: string }) => result.sha };
    assert.deepEqual(await withDevPublication(args), { sha });
    assert.equal((await db.devEnvironmentLease.findUniqueOrThrow({ where: { environmentId: config.environmentId } })).state, "ready", "task owns Dev through acceptance checks");
    assert.deepEqual(await withDevPublication(args), { sha });
    assert.equal(publications, 1, "same attempt never republishes");
    const otherProject = await db.project.create({ data: { slug: "other", name: "Other", repositoryPath: dir, devPublicationConfig: JSON.stringify(config) } });
    await assert.rejects(withDevPublication({ ...args, projectId: otherProject.id, grantId: undefined, taskId: undefined, attemptId: "other" }), /reserved by another/);
    await withDevPublication({ ...args, attemptId: "attempt-two" });
    assert.equal(publications, 2, "the same task may iterate under one standing grant");
    await db.$transaction(tx => releaseTaskDevLease(tx, { taskId: task.id }));
    assert.equal((await db.devEnvironmentLease.findUniqueOrThrow({ where: { environmentId: config.environmentId } })).state, "released");
    await withDevPublication({ ...args, projectId: otherProject.id, grantId: undefined, taskId: undefined, attemptId: "other" });
    assert.equal(publications, 3);
    // Keep an executing attempt fenced even when its exact id is submitted twice.
    let started!: () => void; let finish!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const concurrent = { ...args, attemptId: "concurrent", publish: async () => { started(); await gate; return { sha }; } };
    const first = withDevPublication(concurrent);
    await begun;
    await assert.rejects(withDevPublication(concurrent), /already executing/);
    finish(); await first;
    await db.$transaction(tx => releaseTaskDevLease(tx, { taskId: task.id }));
    // Verification failure preserves the SHA/result and retry never repeats push.
    const badConfig = { ...config, verify: { ...config.verify, args: ['{"sha":"wrong"}'] } };
    await db.project.update({ where: { id: otherProject.id }, data: { devPublicationConfig: JSON.stringify(badConfig) } });
    let failedPublications = 0;
    const failing = { ...args, projectId: otherProject.id, taskId: undefined, grantId: undefined, attemptId: "verify-fail", publish: async () => { failedPublications++; return { sha }; } };
    await assert.rejects(withDevPublication(failing), /exact published SHA/);
    await assert.rejects(withDevPublication(failing), /exact published SHA/);
    assert.equal(failedPublications, 1);
    await assert.rejects(withDevPublication({ ...failing, attemptId: "another" }), /reserved by another/);
    await db.taskStandingAuthorization.update({ where: { id: grant.id }, data: { status: "revoked", revokedAt: new Date() } });
    assert.equal((await validateStandingAuthorization(db, { taskId: task.id, grantId: grant.id })).ok, false);
    // Exercise the actual command -> transaction -> durable outbox boundary.
    // No outbox drain runs here: publication commands must remain inert intents.
    const { persistActionPlan } = await import("@/lib/tasks/action-plan-store");
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");
    const canonical = await db.task.create({ data: { projectId: project.id, title: "Canonical Dev approval", status: "Backlog", description: "Registered nonproduction checkpoint", branchName: "task-canonical", assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
    const submitted = await persistActionPlan({ taskId: canonical.id, authorId: worker.id, input: { summary: "Publish approved checkpoint for verification", steps: [{ id: "implementation", title: "Implement and verify", kind: "sequential", acceptanceCriteria: ["The exact candidate passes Dev checks"] }] } });
    const approval = { taskId: canonical.id, intent: "approve_plan" as const, actor: { id: owner.id, username: owner.username, kind: "human" as const }, source: "browser" as const, expectedWorkflowVersion: 0, idempotencyKey: "canonical-approve", payload: { actionPlanId: submitted.id, actionPlanVersion: submitted.version } };
    const approved = await submitWorkflowCommand(approval);
    assert.equal(approved.status, "accepted", JSON.stringify(approved));
    const canonicalGrant = await db.taskStandingAuthorization.findFirstOrThrow({ where: { taskId: canonical.id, status: "active" } });
    assert.equal((await submitWorkflowCommand(approval)).status, "replayed");
    assert.equal(await db.taskStandingAuthorization.count({ where: { taskId: canonical.id } }), 1);
    await db.task.update({ where: { id: canonical.id }, data: { status: "In Progress" } });
    const cycle = await db.$transaction(tx => openTaskWorkflowCycle(tx, { taskId: canonical.id, openedWorkflowVersion: 1 }));
    await db.taskRepositoryRun.create({ data: { taskId: canonical.id, workflowCycleId: cycle.id, repositoryPath: dir, worktreePath: dir, branchName: canonical.branchName, phase: "active", baseSha: sha } });
    const publish = async (key: string) => submitWorkflowCommand({ taskId: canonical.id, intent: "publish_checkpoint", actor: { id: worker.id, username: worker.username, kind: "agent", codingCapability: true }, source: "agent", expectedWorkflowVersion: (await db.task.findUniqueOrThrow({ where: { id: canonical.id } })).workflowVersion, workflowCycleId: cycle.id, idempotencyKey: key, payload: { standingAuthorizationId: canonicalGrant.id } });
    const firstPublish = await publish("canonical-checkpoint-1");
    assert.equal(firstPublish.status, "accepted", JSON.stringify(firstPublish));
    assert.equal((await publish("canonical-checkpoint-1")).status, "replayed");
    assert.equal((await publish("canonical-checkpoint-2")).status, "accepted");
    const outbox = await db.workflowOutbox.findMany({ where: { taskId: canonical.id, effectType: "repository_checkpoint" } });
    assert.equal(outbox.length, 2, "one durable publication intent per checkpoint, not per grant");
    const payloads = outbox.map(row => JSON.parse(row.payload));
    assert.ok(payloads.every(payload => payload.standingAuthorizationId === canonicalGrant.id));
    assert.equal(new Set(payloads.map(payload => payload.publicationAttemptId)).size, 2);
    await db.taskStandingAuthorization.update({ where: { id: canonicalGrant.id }, data: { status: "revoked", revokedAt: new Date() } });
    assert.equal((await publish("canonical-after-revocation")).status, "forbidden");
    assert.equal(await db.workflowOutbox.count({ where: { taskId: canonical.id, effectType: "repository_checkpoint" } }), 2);
    console.log("PASS standing authority scope/revision/actor fences, target verification, per-attempt replay, cross-project Dev ownership, concurrency and uncertain-result recovery");
    console.log("PASS canonical approval mints one grant; command replay, separate checkpoint outbox identities and revoked admission retain durable boundaries");
  } finally { await db.$disconnect(); await rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
