// PHASEE-11 — deterministic effectful-admission and rollback coverage.
// Runs only against a disposable SQLite database.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const disposableDir = mkdtempSync(path.join(tmpdir(), "phasee-11-admission-"));
const databaseUrl = `file:${path.join(disposableDir, "test.db")}`;
process.env.DATABASE_URL = databaseUrl;

execFileSync("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "ignore",
});

async function main() {
  const { db } = await import("@/lib/db");
  const {
    orchestratorShadowEnabled,
    shouldComputeV2Decision,
    isV2MutationAdmissionEnabledForProject,
  } = await import("@/lib/tasks/orchestrator/flags");
  const {
    runProjectAdmission,
    unpinQuiescentTask,
  } = await import("@/lib/tasks/orchestrator/admission");
  const {
    ENGINE_LEGACY,
    ENGINE_ORCHESTRATOR_V2,
    pinToV2,
    unpinFromV2,
  } = await import("@/lib/tasks/orchestrator/ownership");
  const {
    evaluateObservationWindow,
    evaluateRolloutGates,
    PHASE_E_STOP_CONDITIONS,
  } = await import("@/lib/tasks/orchestrator/rollout-gates");
  const { updateTaskRepositoryState } = await import("@/lib/tasks/repository-state");
  const { applyProcedureCallback } = await import("@/lib/tasks/orchestrator/procedure-runner");

  const repositoryColumns = await db.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM pragma_table_info('task_repository_runs')",
  );
  assert(repositoryColumns.some((column) => column.name === "publication_state_v2"));
  assert(repositoryColumns.some((column) => column.name === "replay_count_v2"));

  for (const seam of [
    "app/api/agent/tasks/[taskId]/workflow/route.ts",
    "app/api/agent/tasks/[taskId]/request-workflow-turn/route.ts",
    "lib/agents/workflow/notifications/task.ts",
    "lib/agents/pm-channel/jobs.ts",
    "lib/agents/pm-channel/target-authorization.ts",
    "lib/agents/context/task.ts",
    "lib/agents/context/api/serialize.ts",
  ]) {
    assert.match(
      readFileSync(path.join(process.cwd(), seam), "utf8"),
      /resolveAgentTaskAccess/,
      `${seam} must use the centralized private-task access fence`,
    );
  }

  process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "*";
  delete process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS;
  assert.equal(orchestratorShadowEnabled(), true);
  assert.equal(shouldComputeV2Decision("internal-canary"), true);
  assert.equal(isV2MutationAdmissionEnabledForProject("internal-canary"), false,
    "compute-only flags must never enable effectful admission");

  const owner = await db.user.create({
    data: {
      username: "phasee-11-owner",
      email: "phasee-11-owner@example.invalid",
      kind: "human",
      status: "active",
      isOwner: true,
    },
  });
  const project = await db.project.create({
    data: { slug: "internal-canary", name: "Synthetic private Phase E canary" },
  });
  const assigneeAgent = await db.agent.create({
    data: { slug: "phasee-11-assignee", name: "Phase E assignee", role: "coding" },
  });
  const assignee = await db.user.create({
    data: {
      username: "phasee-11-assignee",
      email: "phasee-11-assignee@example.invalid",
      kind: "agent",
      status: "active",
      agentId: assigneeAgent.id,
    },
  });
  const reviewerAgent = await db.agent.create({
    data: { slug: "phasee-11-reviewer", name: "Phase E reviewer", role: "coding" },
  });
  const reviewer = await db.user.create({
    data: {
      username: "phasee-11-reviewer",
      email: "phasee-11-reviewer@example.invalid",
      kind: "agent",
      status: "active",
      agentId: reviewerAgent.id,
    },
  });
  const outsider = await db.user.create({
    data: {
      username: "phasee-11-outsider",
      email: "phasee-11-outsider@example.invalid",
      kind: "agent",
      status: "active",
    },
  });
  const eligible = await db.task.create({
    data: {
      projectId: project.id,
      title: "Private quiescent task",
      status: "To Do",
      private: true,
      assigneeId: assignee.id,
      actingManagerId: reviewer.id,
      reporterId: owner.id,
    },
  });
  const active = await db.task.create({
    data: { projectId: project.id, title: "Private active task", status: "In Progress", private: true },
  });
  const publicTask = await db.task.create({
    data: { projectId: project.id, title: "Public task", status: "Backlog", private: false },
  });

  const { resolveAgentTaskAccess } = await import("@/lib/agents/private-task-access");
  process.env.PM_PRIVATE_TASK_AGENT_PROJECTS = project.slug;
  assert.equal(
    (await resolveAgentTaskAccess({ taskId: eligible.id, agentUserId: assignee.id })).allowed,
    false,
    "durable V2 ownership is required before private agent access",
  );

  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = project.slug;
  const evidence = {
    schemaVersion: 1 as const,
    evidenceId: "phasee-11-test-evidence",
    generatedAt: new Date().toISOString(),
    targetProjectSlug: project.slug,
    mode: "e2_internal_canary" as const,
    syntheticPrivateProject: true,
    checks: {
      migrations: true,
      typecheck: true,
      workflowSuite: true,
      phaseESuites: true,
      build: true,
      lint: true,
      procedureHandlerIdempotency: true,
      callbackV2Correlation: true,
      comparisonParity: true,
      doctorInvariants: true,
    },
    ownership: { backupOwner: "owner", rollbackOwner: "owner", onCallOwner: "owner" },
    artifacts: ["disposable-db:test"],
  };
  assert.equal(evaluateRolloutGates(evidence).ready, true);

  const dryRun = await runProjectAdmission({
    projectSlug: project.slug,
    operatorUserId: owner.id,
    evidence,
    dryRun: true,
  });
  assert.equal(dryRun.counts.wouldAdmit, 1);
  assert.equal(dryRun.tasks.find((task) => task.taskId === active.id)?.reasonCode, "status_not_approved");
  assert.equal(dryRun.tasks.find((task) => task.taskId === publicTask.id)?.reasonCode, "canary_task_not_private");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_LEGACY);

  const admitted = await runProjectAdmission({
    projectSlug: project.slug,
    operatorUserId: owner.id,
    evidence,
  });
  assert.equal(admitted.counts.admitted, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);

  const assigneeAccess = await resolveAgentTaskAccess({ taskId: eligible.id, agentSlug: assigneeAgent.slug });
  const reviewerAccess = await resolveAgentTaskAccess({ taskId: eligible.id, agentSlug: reviewerAgent.slug });
  assert.deepEqual(assigneeAccess, {
    allowed: true,
    visibility: "private-agent",
    attachmentsAllowed: false,
  });
  assert.equal(reviewerAccess.allowed, true, "the resolved reviewer receives exact-task access");
  assert.equal(
    (await resolveAgentTaskAccess({ taskId: eligible.id, agentUserId: outsider.id })).allowed,
    false,
    "unrelated agents remain fenced",
  );

  await db.attachment.create({
    data: {
      projectId: project.id,
      taskId: eligible.id,
      uploaderId: owner.id,
      filename: "private.txt",
      storagePath: "private/private.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      sha256: "phasee11-private-attachment",
    },
  });
  const { buildTaskContextJson, buildProjectContextJson } = await import("@/lib/agents/context/api/serialize");
  const privateContext = await buildTaskContextJson(eligible.id, { agentSlug: assigneeAgent.slug });
  assert.equal(privateContext?.task.id, eligible.id, "the exact scoped task context is available to its assignee");
  assert.deepEqual(privateContext?.attachments, [], "private task attachments are never exposed by the exception");
  assert.equal(
    await buildTaskContextJson(eligible.id, { agentSlug: "unknown-agent" }),
    null,
    "a context grant bound to another agent cannot reveal the task",
  );
  const projectContext = await buildProjectContextJson(project.id);
  assert.equal(
    projectContext?.openTasks.some((task) => task.id === eligible.id),
    false,
    "generic project context remains private",
  );

  process.env.PM_PRIVATE_TASK_AGENT_PROJECTS = "*";
  assert.equal(
    (await resolveAgentTaskAccess({ taskId: eligible.id, agentUserId: assignee.id })).allowed,
    false,
    "private access never accepts a wildcard",
  );
  process.env.PM_PRIVATE_TASK_AGENT_PROJECTS = project.slug;
  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = "*";
  assert.equal(
    (await resolveAgentTaskAccess({ taskId: eligible.id, agentUserId: assignee.id })).allowed,
    false,
    "both allowlists must explicitly name the private project",
  );
  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = project.slug;

  const replayed = await runProjectAdmission({
    projectSlug: project.slug,
    operatorUserId: owner.id,
    evidence,
  });
  assert.equal(replayed.counts.admitted, 0);
  assert.equal(replayed.counts.alreadyPinned, 1);
  assert.equal(await db.activityLog.count({
    where: { taskId: eligible.id, kind: "task.workflow.engine_pinned" },
  }), 1, "repeated admission must not duplicate the pin or its audit row");
  assert.equal(await db.activityLog.count({
    where: { taskId: publicTask.id, kind: "task.workflow.engine_admission_skipped" },
  }), 1, "repeated skip evidence must be deduplicated");

  // Production E3/E4 cohorts require a schema-v2 exact task set and a formal,
  // owner-authored reporter-approval grant. Admission must never widen that
  // set to every otherwise eligible task in the project.
  const productionProject = await db.project.create({
    data: { slug: "low-risk-production", name: "Low-risk production" },
  });
  const productionCanary = await db.task.create({
    data: {
      projectId: productionProject.id,
      workItemKey: "LRP-1",
      title: "Approved exact canary",
      status: "To Do",
      reporterId: owner.id,
    },
  });
  const productionOutsideCohort = await db.task.create({
    data: {
      projectId: productionProject.id,
      workItemKey: "LRP-2",
      title: "Eligible but outside approved cohort",
      status: "Backlog",
      reporterId: owner.id,
    },
  });
  const rolloutTask = await db.task.create({
    data: {
      projectId: productionProject.id,
      workItemKey: "ROLLOUT-1",
      title: "Production rollout approval",
      status: "In Progress",
      reporterId: owner.id,
    },
  });
  const approvedAt = new Date("2026-08-24T00:00:00.000Z");
  const deployedEpicSha = "a".repeat(40);
  const permissionScope = [
    `Enable low-risk-production at ${deployedEpicSha} through PM_ORCHESTRATOR_V2_MUTATION_PROJECTS`,
    `for exact task LRP-1 with a 60 minute observation window`,
    "then exercise admission rollback and halt on every Phase E stop condition.",
  ].join(" ");
  const approval = await db.comment.create({
    data: {
      taskId: rolloutTask.id,
      userId: owner.id,
      body: `Reporter approval: ${permissionScope}`,
      createdAt: approvedAt,
      commentKind: "blocker_notice",
      isGenerated: true,
    },
  });
  await db.activityLog.create({
    data: {
      projectId: productionProject.id,
      taskId: rolloutTask.id,
      userId: owner.id,
      kind: "task.blocker.permission.granted",
      payload: JSON.stringify({
        blockerCommentId: "production-rollout-blocker",
        permissionKind: "reporter_approval",
        permissionScope,
        authorizationCommentId: approval.id,
      }),
    },
  });
  const productionEvidence = {
    schemaVersion: 2 as const,
    evidenceId: "phasee-e3-production-evidence",
    generatedAt: "2026-08-24T00:00:01.000Z",
    targetProjectSlug: productionProject.slug,
    mode: "project_cohort" as const,
    syntheticPrivateProject: false,
    checks: { ...evidence.checks },
    ownership: { ...evidence.ownership },
    artifacts: ["retained:production-preflight"],
    productionCohort: {
      stage: "e3_production_canary" as const,
      deployedEpicSha,
      taskIdsOrKeys: [productionCanary.workItemKey!],
      mutationSetting: {
        name: "PM_ORCHESTRATOR_V2_MUTATION_PROJECTS" as const,
        before: [project.slug],
        after: [project.slug, productionProject.slug],
      },
      comparisonSetting: { shadowEnabled: false, projects: [productionProject.slug] },
      approval: {
        taskId: rolloutTask.id,
        ownerUsername: owner.username,
        approvedAt: approvedAt.toISOString(),
        authorizationCommentId: approval.id,
      },
      observationWindow: { startsAt: "2026-08-24T00:00:02.000Z", minimumMinutes: 60 },
      rollbackAction: "Remove low-risk-production from PM_ORCHESTRATOR_V2_MUTATION_PROJECTS; keep V2 workers running and never unpin active work.",
      stopConditions: [...PHASE_E_STOP_CONDITIONS],
      baselineArtifacts: {
        cohortReport: "retained:cohort-report",
        engineDistribution: "retained:engine-distribution",
        legacyInvocationCounter: "retained:legacy-counter",
        callbackCorrelation: "retained:callback-correlation",
      },
    },
  };
  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = `${project.slug},${productionProject.slug}`;
  assert.equal(evaluateRolloutGates(productionEvidence).ready, true);
  assert.deepEqual(
    evaluateObservationWindow(productionEvidence, new Date("2026-08-24T00:30:02.000Z")),
    {
      applicable: true,
      complete: false,
      startsAt: "2026-08-24T00:00:02.000Z",
      endsAt: "2026-08-24T01:00:02.000Z",
      remainingMinutes: 30,
    },
  );
  assert.equal(
    evaluateObservationWindow(productionEvidence, new Date("2026-08-24T01:00:02.000Z")).complete,
    true,
  );

  const productionDryRun = await runProjectAdmission({
    projectSlug: productionProject.slug,
    operatorUserId: owner.id,
    evidence: productionEvidence,
    dryRun: true,
  });
  assert.equal(productionDryRun.counts.total, 1);
  assert.equal(productionDryRun.counts.wouldAdmit, 1);
  assert.deepEqual(productionDryRun.targetTaskSelectors, ["LRP-1"]);
  assert.equal(productionDryRun.outsideApprovedTasks.some((task) => task.taskId === productionOutsideCohort.id), true);

  const productionAdmission = await runProjectAdmission({
    projectSlug: productionProject.slug,
    operatorUserId: owner.id,
    evidence: productionEvidence,
  });
  assert.equal(productionAdmission.counts.admitted, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: productionCanary.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: productionOutsideCohort.id } })).workflowEngine, ENGINE_LEGACY);
  const productionPin = await db.activityLog.findFirstOrThrow({
    where: { taskId: productionCanary.id, kind: "task.workflow.engine_pinned" },
  });
  assert.deepEqual(
    JSON.parse(productionPin.payload ?? "{}"),
    {
      from: ENGINE_LEGACY,
      to: ENGINE_ORCHESTRATOR_V2,
      pinnedAt: (await db.task.findUniqueOrThrow({ where: { id: productionCanary.id } })).workflowEnginePinnedAt?.toISOString(),
      evidenceId: productionEvidence.evidenceId,
      cohortStage: "e3_production_canary",
      authorizationCommentId: approval.id,
    },
  );

  const rollbackCycle = await db.taskWorkflowCycle.create({
    data: {
      taskId: productionCanary.id,
      sequence: 1,
      status: "open",
      openedWorkflowVersion: productionCanary.workflowVersion,
      workflowEngine: ENGINE_ORCHESTRATOR_V2,
    },
  });
  await db.task.update({
    where: { id: productionCanary.id },
    data: { status: "In Progress", activeWorkflowCycleId: rollbackCycle.id },
  });
  const rollbackProcedure = await db.taskProcedureRun.create({
    data: {
      taskId: productionCanary.id,
      workflowCycleId: rollbackCycle.id,
      triggerTransitionId: "phasee-e3-active-rollback",
      type: "submit_candidate_for_review",
      definitionVersion: 1,
      status: "running",
    },
  });
  const rollbackStep = await db.taskProcedureStep.create({
    data: {
      procedureRunId: rollbackProcedure.id,
      name: "run_validation",
      ordinal: 3,
      status: "waiting_callback",
      output: JSON.stringify({ jobId: "phasee-e3-rollback-job", candidateSha: "candidate", baseSha: "base" }),
    },
  });
  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = project.slug;
  const rollbackCallback = await applyProcedureCallback({
    procedureRunId: rollbackProcedure.id,
    stepId: rollbackStep.id,
    taskId: productionCanary.id,
    workflowCycleId: rollbackCycle.id,
    jobId: "phasee-e3-rollback-job",
    candidateSha: "candidate",
    baseSha: "base",
    schemaVersion: 2,
  });
  assert.equal(rollbackCallback.applied, true, "an active V2 callback finishes after admission rollback");
  assert.equal((await db.taskProcedureStep.findUniqueOrThrow({ where: { id: rollbackStep.id } })).status, "completed");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: productionCanary.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);
  assert.equal((await db.taskWorkflowCycle.findUniqueOrThrow({ where: { id: rollbackCycle.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);
  assert.equal(await db.activityLog.count({
    where: {
      projectId: productionProject.id,
      kind: "task.workflow.legacy_boundary.invoked",
      taskId: productionCanary.id,
    },
  }), 0);
  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = `${project.slug},${productionProject.slug}`;

  const missingSelectorEvidence = {
    ...productionEvidence,
    evidenceId: "phasee-e3-missing-selector",
    productionCohort: {
      ...productionEvidence.productionCohort,
      taskIdsOrKeys: ["LRP-404"],
    },
  };
  await assert.rejects(
    runProjectAdmission({
      projectSlug: productionProject.slug,
      operatorUserId: owner.id,
      evidence: missingSelectorEvidence,
      dryRun: true,
    }),
    /task selector\(s\) not found/,
  );
  const duplicateResolvedTaskEvidence = {
    ...productionEvidence,
    evidenceId: "phasee-e3-duplicate-resolved-task",
    productionCohort: {
      ...productionEvidence.productionCohort,
      taskIdsOrKeys: [productionCanary.id, productionCanary.workItemKey!],
    },
  };
  await assert.rejects(
    runProjectAdmission({
      projectSlug: productionProject.slug,
      operatorUserId: owner.id,
      evidence: duplicateResolvedTaskEvidence,
      dryRun: true,
    }),
    /must resolve to distinct tasks/,
  );
  assert.equal(
    evaluateRolloutGates({
      ...productionEvidence,
      productionCohort: {
        ...productionEvidence.productionCohort,
        stage: "e4_project_expansion",
      },
    }).gates.find((gate) => gate.id === "previous_cohort_observed")?.passed,
    false,
  );

  const privateChild = await db.task.create({
    data: {
      projectId: project.id,
      parentTaskId: eligible.id,
      title: "Private child must stay fenced",
      private: true,
      workflowEngine: ENGINE_ORCHESTRATOR_V2,
      workflowEnginePinnedAt: new Date(),
      assigneeId: assignee.id,
    },
  });
  assert.equal(
    (await resolveAgentTaskAccess({ taskId: privateChild.id, agentUserId: assignee.id })).allowed,
    false,
    "the exception is top-level only",
  );

  // Removing the allowlist stops only new admission. Durable V2 ownership is
  // unchanged and remains authoritative.
  delete process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS;
  const laterTask = await db.task.create({
    data: { projectId: project.id, title: "Created after rollback", status: "Backlog", private: true },
  });
  assert.equal(isV2MutationAdmissionEnabledForProject(project.slug), false);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: laterTask.id } })).workflowEngine, ENGINE_LEGACY);

  // Quiescent unpin rejects every active workflow phase. The task engine is
  // never changed by a rejection.
  await db.task.update({ where: { id: eligible.id }, data: { status: "In Progress" } });
  let unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);

  await db.task.update({ where: { id: eligible.id }, data: { status: "Review" } });
  unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);

  await db.task.update({ where: { id: eligible.id }, data: { status: "To Do" } });
  await db.taskRepositoryRun.create({ data: { taskId: eligible.id, phase: "validating" } });
  unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);
  assert.equal((unpin as { code: string }).code, "active_repository_work");
  await db.taskRepositoryRun.delete({ where: { taskId: eligible.id } });

  const transition = await db.workflowTransition.create({
    data: {
      taskId: eligible.id,
      workflowVersion: 1,
      intent: "test",
      fromStatus: "To Do",
      toStatus: "To Do",
      source: "phasee-11-test",
      idempotencyKey: "phasee-11-procedure-transition",
    },
  });
  const procedure = await db.taskProcedureRun.create({
    data: {
      taskId: eligible.id,
      triggerTransitionId: transition.id,
      type: "start_implementation_cycle",
      status: "queued",
    },
  });
  unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);
  assert.equal((unpin as { code: string }).code, "active_procedure");
  await db.taskProcedureRun.update({ where: { id: procedure.id }, data: { status: "completed", completedAt: new Date() } });

  const result = await unpinQuiescentTask({
    projectSlug: project.slug,
    taskIdOrKey: eligible.id,
    operatorUserId: owner.id,
  });
  assert.deepEqual(result, { ok: true, code: "unpinned" });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_LEGACY);

  // A fresh re-pin is possible only after the cohort is re-enabled; two
  // concurrent attempts converge on exactly one durable owner.
  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = project.slug;
  const concurrent = await Promise.all([
    db.$transaction((tx) => pinToV2(tx, eligible.id, { projectInCohort: true, operatorUserId: owner.id })),
    db.$transaction((tx) => pinToV2(tx, eligible.id, { projectInCohort: true, operatorUserId: owner.id })),
  ]);
  assert.equal(concurrent.filter((item) => item.ok && item.code === "pinned").length, 1);
  assert.equal(concurrent.filter((item) => item.ok && item.code === "already_pinned").length, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);

  // A checkpoint is published before deployment applies its newly published
  // migrations. Repository baseline bookkeeping must therefore avoid
  // selecting the not-yet-deployed compatibility columns on its return path.
  const compatibilityTask = await db.task.create({
    data: { projectId: project.id, title: "Pre-deployment repository compatibility" },
  });
  await updateTaskRepositoryState(compatibilityTask.id, {
    phase: "active",
    baseSha: "phasee-11-before-checkpoint",
  });
  await db.$executeRawUnsafe('DROP INDEX "task_repository_runs_publication_state_v2_idx"');
  await db.$executeRawUnsafe('ALTER TABLE "task_repository_runs" DROP COLUMN "publication_state_v2"');
  await db.$executeRawUnsafe('ALTER TABLE "task_repository_runs" DROP COLUMN "replay_count_v2"');
  const compatibilityRun = await updateTaskRepositoryState(compatibilityTask.id, {
    phase: "active",
    baseSha: "phasee-11-checkpoint-baseline",
  });
  assert.equal(compatibilityRun.baseSha, "phasee-11-checkpoint-baseline");
  assert.equal(compatibilityRun.phase, "active");

  console.log("PHASEE-11 admission: isolation, gated pinning, rollback, unpin, concurrency, and deployment-fence compatibility passed");
  await db.$disconnect();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(disposableDir, { recursive: true, force: true });
  });
