// PHASEE-10 dashboard aggregation and agent-observability auth regressions.
//
// Runs against a throwaway SQLite database. The DATABASE_URL is set before
// importing application modules so this script never touches the live PM DB.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";

const execFileP = promisify(execFile);
const AGENT_TOKEN = "phasee10-observability-test-token";

async function dbPush(dbUrl: string) {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
}

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch-phasee-10-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const originalDbUrl = process.env.DATABASE_URL;
  const originalAuthSecret = process.env.AUTH_SECRET;
  const tokenKey = "PM_OPENCLAW_CHANNEL_TOKEN_PHASEE10_AGENT";
  const originalAgentToken = process.env[tokenKey];
  let prisma: PrismaClient | undefined;

  try {
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_SECRET = "phasee10-test-auth-secret";
    process.env[tokenKey] = AGENT_TOKEN;

    const [
      { db },
      dashboard,
      projection,
      { LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND },
      { NextRequest },
      middlewareModule,
      cohortRoute,
      legacyRoute,
    ] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/tasks/orchestrator/dashboard-data"),
      import("@/lib/tasks/orchestrator/projection"),
      import("@/lib/tasks/legacy-workflow-boundary"),
      import("next/server"),
      import("@/middleware"),
      import("@/app/api/agent/observability/cohort/route"),
      import("@/app/api/agent/observability/legacy-invocations/route"),
    ]);
    prisma = db as PrismaClient;

    const agent = await db.agent.create({
      data: { slug: "phasee10-agent", name: "PHASEE-10 Agent", role: "coding" },
    });
    await db.user.create({
      data: {
        username: "phasee10-agent",
        email: "phasee10-agent@example.test",
        kind: "agent",
        agentId: agent.id,
      },
    });

    const [alpha, beta] = await Promise.all([
      db.project.create({ data: { slug: "phasee10-alpha", name: "PHASEE-10 Alpha" } }),
      db.project.create({ data: { slug: "phasee10-beta", name: "PHASEE-10 Beta" } }),
    ]);

    const [alphaLegacy, alphaV2, alphaDeleted, betaLegacy, alphaUnsafe, alphaReceiptUnsafe] = await Promise.all([
      db.task.create({
        data: {
          projectId: alpha.id,
          title: "Alpha legacy",
          status: "Backlog",
          workflowEngine: "legacy",
          activeWorkflowCycleId: "alpha-cycle",
        },
      }),
      db.task.create({
        data: {
          projectId: alpha.id,
          title: "Alpha V2",
          status: "In Progress",
          workflowEngine: "orchestrator_v2",
        },
      }),
      db.task.create({
        data: {
          projectId: alpha.id,
          title: "Alpha deleted",
          status: "Done",
          workflowEngine: "legacy",
          deletedAt: new Date(),
        },
      }),
      db.task.create({
        data: {
          projectId: beta.id,
          title: "Beta legacy",
          status: "Review",
          workflowEngine: "legacy",
          activeWorkflowCycleId: "beta-cycle",
        },
      }),
      db.task.create({
        data: {
          projectId: alpha.id,
          title: "Alpha currently unsafe candidate",
          status: "Backlog",
          workflowEngine: "legacy",
        },
      }),
      db.task.create({
        data: {
          projectId: alpha.id,
          title: "Alpha candidate with pre-window accepted receipt",
          status: "Backlog",
          workflowEngine: "legacy",
        },
      }),
    ]);

    await db.taskWorkflowCommandReceipt.create({
      data: {
        taskId: alphaReceiptUnsafe.id,
        idempotencyKey: "alpha-pre-window-receipt",
        requestFingerprint: "alpha-pre-window-fingerprint",
        intent: "submit_plan",
        source: "agent_workflow",
        expectedWorkflowVersion: 0,
        resultingWorkflowVersion: 1,
        status: "accepted",
        result: "{}",
        createdAt: new Date("2026-08-18T00:00:00.000Z"),
      },
    });
    await db.taskWorkflowCommandReceipt.create({
      data: {
        taskId: betaLegacy.id,
        idempotencyKey: "beta-completed-receipt",
        requestFingerprint: "beta-completed-fingerprint",
        intent: "submit_plan",
        source: "agent_workflow",
        expectedWorkflowVersion: 0,
        resultingWorkflowVersion: 1,
        status: "completed",
        result: "{}",
      },
    });

    await db.taskProcedureRun.createMany({
      data: [
        { taskId: alphaLegacy.id, triggerTransitionId: "alpha-t1", type: "prepare_todo_task", status: "queued" },
        { taskId: alphaLegacy.id, triggerTransitionId: "alpha-t2", type: "start_implementation_cycle", status: "operational_error" },
        { taskId: alphaV2.id, triggerTransitionId: "alpha-t3", type: "submit_candidate_for_review", status: "completed" },
        { taskId: alphaDeleted.id, triggerTransitionId: "alpha-t4", type: "finalize_accepted_review", status: "running" },
        { taskId: betaLegacy.id, triggerTransitionId: "beta-t1", type: "finalize_accepted_review", status: "running" },
        { taskId: alphaUnsafe.id, triggerTransitionId: "alpha-t5", type: "prepare_todo_task", status: "queued" },
      ],
    });

    const hotPayload = JSON.stringify({
      legacyBoundary: "agent-task-workflow-route",
      entryPoint: "POST /api/agent/tasks/:taskId/workflow",
    });
    const coldPayload = JSON.stringify({
      legacyBoundary: "workflow-reconciler-and-repair-tools",
      entryPoint: "pm-workflow-doctor",
    });
    const betaPayload = JSON.stringify({
      legacyBoundary: "browser-board-move-actions",
      entryPoint: "moveTask",
    });
    const baseTime = Date.parse("2026-08-19T00:00:00.000Z");
    await db.activityLog.createMany({
      data: [
        ...Array.from({ length: 501 }, (_, index) => ({
          projectId: alpha.id,
          kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
          payload: hotPayload,
          createdAt: new Date(baseTime + index),
        })),
        {
          projectId: alpha.id,
          kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
          payload: coldPayload,
          createdAt: new Date(baseTime - 60_000),
        },
        {
          projectId: beta.id,
          kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
          payload: betaPayload,
          createdAt: new Date(baseTime + 120_000),
        },
      ],
    });

    const alphaLegacySummary = await dashboard.getLegacyInvocationSummary(alpha.id);
    assert.equal(alphaLegacySummary.totalInvocations, 502);
    assert.equal(alphaLegacySummary.byBoundary.length, 2);
    assert.equal(
      alphaLegacySummary.byBoundary.reduce((sum, entry) => sum + entry.count, 0),
      alphaLegacySummary.totalInvocations,
    );
    assert.equal(
      alphaLegacySummary.byBoundary.find((entry) => entry.legacyBoundary === "workflow-reconciler-and-repair-tools")?.count,
      1,
      "cold boundary remains visible beyond the former 500-row window",
    );
    assert.equal(alphaLegacySummary.byBoundary[0]?.count, 501);
    assert.equal(alphaLegacySummary.byBoundary[0]?.lastInvokedAt, new Date(baseTime + 500).toISOString());

    const globalLegacySummary = await dashboard.getLegacyInvocationSummary();
    assert.equal(globalLegacySummary.totalInvocations, 503);
    assert.equal(globalLegacySummary.byBoundary.length, 3);

    const windowStart = new Date(baseTime + 180_000);
    await db.activityLog.createMany({
      data: [
        {
          projectId: alpha.id,
          kind: LEGACY_WORKFLOW_BOUNDARY_ACTIVITY_KIND,
          payload: hotPayload,
          createdAt: new Date(windowStart.getTime() + 1),
        },
        {
          projectId: alpha.id,
          taskId: alphaV2.id,
          kind: "task.workflow.callback.applied",
          payload: "{}",
          createdAt: new Date(windowStart.getTime() + 2),
        },
        {
          projectId: alpha.id,
          taskId: alphaV2.id,
          kind: "task.workflow.callback.mismatch",
          payload: "{}",
          createdAt: new Date(windowStart.getTime() + 3),
        },
      ],
    });
    const windowLegacySummary = await dashboard.getLegacyInvocationSummary(alpha.id, { since: windowStart });
    assert.equal(windowLegacySummary.totalInvocations, 1);
    assert.equal(windowLegacySummary.windowStartedAt, windowStart.toISOString());

    const alphaCohort = await dashboard.getCohortSummary(alpha.id);
    assert.equal(alphaCohort.length, 1);
    assert.deepEqual(alphaCohort[0]?.engineDistribution, { legacy: 3, orchestrator_v2: 1 });
    assert.deepEqual(alphaCohort[0]?.taskCountByStatus, { Backlog: 3, "In Progress": 1 });
    assert.equal(alphaCohort[0]?.activeCycleCount, 1);
    assert.equal(alphaCohort[0]?.activeProcedureCount, 3);
    assert.equal(alphaCohort[0]?.eligibleTaskCount, 0);
    assert.equal(alphaCohort[0]?.skippedTaskCount, 3);
    assert.deepEqual(alphaCohort[0]?.skippedReasons, {
      active_cycle: 1,
      active_procedure: 1,
      unsettled_receipt: 1,
    });
    assert.equal(alphaCohort[0]?.legacyDrainCount, 3);
    const alphaWindowCohort = await dashboard.getCohortSummary(alpha.id, { since: windowStart });
    assert.deepEqual(alphaWindowCohort[0]?.callbackHealth, { applied: 1, rejected: 1 });
    assert.equal(alphaWindowCohort[0]?.windowStartedAt, windowStart.toISOString());
    assert.equal(
      alphaWindowCohort[0]?.skippedReasons.unsettled_receipt,
      1,
      "windowed counters never hide a pre-window accepted receipt from current admission safety",
    );
    const alphaLegacyDrain = await dashboard.getLegacyDrainInventory(alpha.id);
    assert.equal(alphaLegacyDrain.length, 3);
    assert.equal(alphaLegacyDrain.some((entry) => entry.taskId === alphaLegacy.id && entry.activeWorkflowCycleId === "alpha-cycle"), true);
    assert.equal(alphaLegacyDrain.some((entry) => entry.taskId === alphaUnsafe.id && entry.procedureStatuses.includes("queued")), true);
    assert.equal(alphaLegacyDrain.some((entry) => entry.taskId === alphaReceiptUnsafe.id && entry.acceptedReceiptCount === 1), true);

    const globalCohort = await dashboard.getCohortSummary();
    assert.equal(globalCohort.length, 2);
    const betaCohort = globalCohort.find((entry) => entry.projectSlug === beta.slug);
    assert.deepEqual(betaCohort?.engineDistribution, { legacy: 1 });
    assert.equal(betaCohort?.activeCycleCount, 1);
    assert.equal(betaCohort?.activeProcedureCount, 1);

    const doctorResult = await execFileP(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      ["scripts/pm-workflow-doctor.ts", "--json", `--project=${alpha.id}`],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
    );
    const doctorJson = JSON.parse(doctorResult.stdout) as {
      phaseE: {
        receiptStats: Record<string, number>;
        procedureStatusSummary: Record<string, number>;
      };
    };
    assert.deepEqual(doctorJson.phaseE.receiptStats, { accepted: 1 });
    assert.equal(
      doctorJson.phaseE.procedureStatusSummary.running,
      undefined,
      "project-scoped doctor excludes another project's procedure totals",
    );
    const windowDoctorResult = await execFileP(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      [
        "scripts/pm-workflow-doctor.ts",
        "--json",
        `--project=${alpha.id}`,
        `--since=${windowStart.toISOString()}`,
      ],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
    );
    const windowDoctor = JSON.parse(windowDoctorResult.stdout) as {
      phaseE: {
        observationWindow: { startedAt: string | null };
        receiptStats: Record<string, number>;
        commandCallbackHealth: { diagnosticCounts: Record<string, number> };
        historicalResidueBeforeWindow: {
          receiptStats: Record<string, number>;
          legacyInvocationCount: number;
        } | null;
      };
    };
    assert.equal(windowDoctor.phaseE.observationWindow.startedAt, windowStart.toISOString());
    assert.deepEqual(windowDoctor.phaseE.receiptStats, {}, "pre-window receipts do not fail the rollout window");
    assert.equal(windowDoctor.phaseE.commandCallbackHealth.diagnosticCounts["task.workflow.callback.mismatch"], 1);
    assert.deepEqual(windowDoctor.phaseE.historicalResidueBeforeWindow?.receiptStats, { accepted: 1 });
    assert.ok((windowDoctor.phaseE.historicalResidueBeforeWindow?.legacyInvocationCount ?? 0) > 0);

    const projectionMismatchTask = await db.task.create({
      data: {
        projectId: alpha.id,
        title: "Projection exposes cycle mismatch",
        status: "In Progress",
        workflowEngine: "legacy",
      },
    });
    const projectionMismatchCycle = await db.taskWorkflowCycle.create({
      data: {
        taskId: projectionMismatchTask.id,
        sequence: 1,
        status: "open",
        openedWorkflowVersion: 0,
        workflowEngine: "orchestrator_v2",
      },
    });
    await db.task.update({
      where: { id: projectionMismatchTask.id },
      data: { activeWorkflowCycleId: projectionMismatchCycle.id },
    });
    const mismatchProjection = await projection.buildTaskWorkflowProjection(projectionMismatchTask.id);
    assert.equal(mismatchProjection?.workflowEngine, "legacy");
    assert.equal(
      mismatchProjection?.activeCycle?.workflowEngine,
      "orchestrator_v2",
      "the projection exposes the durable cycle engine instead of copying the task engine",
    );

    const cohortUrl = `http://127.0.0.1:3000/api/agent/observability/cohort?projectId=${alpha.id}`;
    const legacyUrl = `http://127.0.0.1:3000/api/agent/observability/legacy-invocations?projectId=${alpha.id}`;

    for (const url of [cohortUrl, legacyUrl]) {
      const nextResponse = await middlewareModule.middleware(new NextRequest(url, { method: "GET" }));
      assert.equal(nextResponse.headers.get("x-middleware-next"), "1", `${url} bypasses browser login for GET`);
    }
    for (const request of [
      new NextRequest("http://127.0.0.1:3000/api/agent/observability/not-a-route"),
      new NextRequest("http://127.0.0.1:3000/api/agent/observability/cohort/"),
      new NextRequest(cohortUrl, { method: "POST" }),
      new NextRequest("http://127.0.0.1:3000/projects"),
    ]) {
      const response = await middlewareModule.middleware(request);
      assert.equal(response.status, 307, `${request.method} ${request.nextUrl.pathname} remains browser-session protected`);
      assert.equal(response.headers.get("location")?.includes("/login"), true);
    }

    const missingCohortAuth = await cohortRoute.GET(new NextRequest(cohortUrl));
    assert.equal(missingCohortAuth.status, 401);
    const invalidLegacyAuth = await legacyRoute.GET(new NextRequest(legacyUrl, {
      headers: { authorization: "Bearer invalid" },
    }));
    assert.equal(invalidLegacyAuth.status, 401);

    const bearerHeaders = { authorization: `Bearer ${AGENT_TOKEN}` };
    const invalidSinceResponse = await cohortRoute.GET(new NextRequest(`${cohortUrl}&since=not-a-timestamp`, {
      headers: bearerHeaders,
    }));
    assert.equal(invalidSinceResponse.status, 400);
    const cohortResponse = await cohortRoute.GET(new NextRequest(cohortUrl, { headers: bearerHeaders }));
    assert.equal(cohortResponse.status, 200);
    assert.equal(cohortResponse.headers.get("cache-control"), "no-store");
    const cohortJson = await cohortResponse.json() as { ok: boolean; cohort: unknown[] };
    assert.equal(cohortJson.ok, true);
    assert.equal(cohortJson.cohort.length, 1);

    const legacyResponse = await legacyRoute.GET(new NextRequest(legacyUrl, { headers: bearerHeaders }));
    assert.equal(legacyResponse.status, 200);
    assert.equal(legacyResponse.headers.get("cache-control"), "no-store");
    const legacyJson = await legacyResponse.json() as {
      ok: boolean;
      legacyInvocations: { totalInvocations: number };
    };
    assert.equal(legacyJson.ok, true);
    assert.equal(legacyJson.legacyInvocations.totalInvocations, 503);

    const externalResponse = await cohortRoute.GET(new NextRequest(cohortUrl, {
      headers: { ...bearerHeaders, "x-forwarded-for": "203.0.113.10" },
    }));
    assert.equal(externalResponse.status, 403);

    console.log("[orch-phasee-10-dashboard] dashboard aggregation and auth checks passed");
  } finally {
    await prisma?.$disconnect();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalAuthSecret;
    if (originalAgentToken === undefined) delete process.env[tokenKey];
    else process.env[tokenKey] = originalAgentToken;
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
