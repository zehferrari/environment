import { runRouteHandler } from "./lib/next-route-harness";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pm-task-runtime-"));
  process.env.DATABASE_URL = `file:${path.join(sandbox, "test.db")}`;
  process.env.AUTH_SECRET = "isolated-runtime-test-secret";
  process.env.PM_TASK_RUNTIME_V2 = "1";
  process.env.PM_AGENT_CONFIG_ROOT = path.join(sandbox, "agents");
  const setBackend = async (agent: string, primary: string) => {
    const dir = path.join(process.env.PM_AGENT_CONFIG_ROOT!, agent);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "openclaw.json"), JSON.stringify({ agents: { defaults: { model: { primary } } } }));
  };
  await setBackend("worker", "openai/test"); await setBackend("reviewer", "openai/test");
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { sendTaskWorkflowNotification } = await import("@/lib/agents/workflow/notifications/task");
    const { prepareCompactTaskTurn, PM_TASK_CONTRACT_VERSION } = await import("@/lib/agents/pm-channel/task-runtime");
    const owner = await db.user.create({ data: { username: "owner", email: "owner@runtime.invalid", kind: "human", isOwner: true } });
    const project = await db.project.create({ data: { slug: "runtime", name: "Runtime" } });
    const workerAgent = await db.agent.create({ data: { slug: "worker", name: "Worker", role: "coding" } });
    const reviewerAgent = await db.agent.create({ data: { slug: "reviewer", name: "Reviewer", role: "coding" } });
    const worker = await db.user.create({ data: { username: "worker", email: "worker@runtime.invalid", kind: "agent", agentId: workerAgent.id } });
    const reviewer = await db.user.create({ data: { username: "reviewer", email: "reviewer@runtime.invalid", kind: "agent", agentId: reviewerAgent.id } });
    const task = await db.task.create({ data: { title: "Fix one invoice key", description: "Change the key; retain tenant checks. Verify cross-user refusal.", projectId: project.id, assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
    const actor = { id: owner.id, kind: "human" as const, username: "owner" };
    const notify = async (reason: "backlog_plan_requested" | "action_plan_feedback_received" | "action_plan_review_requested", targetUserId: string, body: string, key: string) => {
      await sendTaskWorkflowNotification({ taskId: task.id, targetUserId, actor, reason, body, dedupeKey: key });
      const message = await db.agentChatMessage.findUniqueOrThrow({ where: { workflowDedupeKey: key } });
      const run = await db.pmChannelRun.findFirstOrThrow({ where: { taskId: task.id, messageId: message.id } });
      const job = await db.pmChannelJob.findUniqueOrThrow({ where: { runId: run.id } });
      const payload = JSON.parse(job.payload);
      await db.pmChannelRun.update({ where: { id: run.id }, data: { status: "completed" } });
      await db.pmChannelJob.update({ where: { id: job.id }, data: { status: "complete" } });
      return { payload, run };
    };
    const emptyReview = await sendTaskWorkflowNotification({ taskId: task.id, targetUserId: reviewer.id, actor, reason: "reviewer_assignment_requested", body: "Reviewer assigned.", dedupeKey: "empty-review" });
    assert.equal(emptyReview, null, "no model wake before an assigned worker submits a plan");
    assert.equal(await db.agentChatMessage.count({ where: { workflowDedupeKey: "empty-review" } }), 0);
    await db.task.update({ where: { id: task.id }, data: { assigneeId: null } });
    await sendTaskWorkflowNotification({ taskId: task.id, targetUserId: reviewer.id, actor, reason: "reviewer_assignment_requested", body: "Select an assignee.", dedupeKey: "needs-assignee" });
    assert.equal(await db.agentChatMessage.count({ where: { workflowDedupeKey: "needs-assignee" } }), 1, "unassigned task still wakes its reviewer");
    await db.task.update({ where: { id: task.id }, data: { assigneeId: worker.id } });
    const first = await notify("backlog_plan_requested", worker.id, "Submit a concise plan.", "first");
    const revised = await notify("action_plan_feedback_received", worker.id, "Add an explicit tenant-refusal test.", "revised");
    const review = await notify("action_plan_review_requested", reviewer.id, "Review the structured plan.", "review");
    assert.equal(first.payload.sessionKey, revised.payload.sessionKey, "planning revisions preserve session identity");
    assert.notEqual(first.payload.sessionKey, review.payload.sessionKey, "reviewer has an independent session");
    assert.notEqual(first.payload.taskRuntime.token, revised.payload.taskRuntime.token, "each message has its own capability");
    for (const { payload } of [first, revised, review]) {
      assert.ok(payload.systemPrompt.includes(PM_TASK_CONTRACT_VERSION));
      assert.ok(payload.systemPrompt.includes("Use NO_REPLY"));
      assert.ok(!payload.systemPrompt.includes("PM_SILENT_NO_CONTRIBUTION"));
      assert.ok(payload.systemPrompt.length < 12_000, `compact startup: ${payload.systemPrompt.length}`);
      assert.ok(!payload.systemPrompt.includes(payload.taskRuntime.token));
      assert.ok(!payload.systemPrompt.includes(payload.taskRuntime.contextUrl));
      assert.equal(payload.contextText, null);
    }
    assert.ok(first.payload.taskRuntime.actions.includes("submit_plan"));
    assert.ok(!first.payload.taskRuntime.actions.includes("approve_plan"));
    assert.ok(review.payload.taskRuntime.actions.includes("request_plan_changes"));
    assert.ok(!review.payload.taskRuntime.actions.includes("submit_plan"));
    const audits = await db.activityLog.findMany({ where: { taskId: task.id, kind: "pm.task.runtime.prepared" } });
    for (const row of audits) {
      const sizes = JSON.parse(row.payload!);
      assert.ok(sizes.promptChars < sizes.originalPromptChars * 0.5, JSON.stringify(sizes));
      console.log(`PROMPT ${sizes.role}: ${sizes.originalPromptChars} → ${sizes.promptChars} chars (${Math.round((1 - sizes.promptChars / sizes.originalPromptChars) * 100)}% reduction)`);
    }
    // Exercise the actual authenticated HTTP route with an admitted native turn.
    const { POST } = await import("@/app/api/agent/tasks/[taskId]/workflow/route");
    const { NextRequest } = await import("next/server");
    const post = async (turn: typeof first, action: string, body: Record<string, unknown>) => {
      const response = await runRouteHandler(() => POST(new NextRequest("http://localhost/api/agent/tasks/" + task.id + "/workflow", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, action, messageId: turn.payload.taskRuntime.messageId, token: turn.payload.taskRuntime.token }),
      }), { params: Promise.resolve({ taskId: task.id }) }));
      return { status: response.status, body: await response.json() };
    };
    const actionPlan = { summary: "Change invoice key and verify tenant isolation", steps: [
      { id: "fix", title: "Change invoice key", kind: "sequential", acceptanceCriteria: ["Correct key for this tenant"] },
      { id: "verify", title: "Verify isolation", kind: "sequential", acceptanceCriteria: ["Cross-tenant request refused"] },
    ] };
    await db.pmChannelRun.update({ where: { id: revised.run.id }, data: { status: "admitted" } });
    const submitted = await post(revised, "submit_plan", { actionPlan });
    assert.equal(submitted.status, 202, JSON.stringify(submitted));
    await db.pmChannelRun.update({ where: { id: review.run.id }, data: { status: "admitted" } });
    const feedback = await post(review, "request_plan_changes", { comment: "Verify both invoice and project tenant isolation." });
    assert.equal(feedback.status, 202, JSON.stringify(feedback));
    const replay = await post(review, "request_plan_changes", { comment: "Verify both invoice and project tenant isolation." });
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.equal((await db.actionPlan.findUniqueOrThrow({ where: { taskId: task.id } })).status, "revision_required");
    let feedbackRows = await db.workflowOutbox.findMany({ where: { taskId: task.id, effectType: "task_notification", dedupeKey: { contains: "plan-changes-requested" } } });
    assert.equal(feedbackRows.length, 1, "lost feedback response replay does not duplicate wake");
    assert.ok(feedbackRows[0].payload.includes("Verify both invoice and project tenant isolation."));
    assert.ok(feedbackRows[0].payload.includes("action_plan_feedback_received"));
    await db.workflowOutbox.updateMany({ where: { id: feedbackRows[0].id }, data: { status: "completed" } });
    const nextPlan = await notify("action_plan_feedback_received", worker.id, "Revise the plan.", "api-plan-2");
    await db.pmChannelRun.update({ where: { id: nextPlan.run.id }, data: { status: "admitted" } });
    assert.equal((await post(nextPlan, "submit_plan", { actionPlan: { ...actionPlan, summary: "Revised plan" } })).status, 202);
    const nextReview = await notify("action_plan_review_requested", reviewer.id, "Review revision 2.", "api-review-2");
    await db.pmChannelRun.update({ where: { id: nextReview.run.id }, data: { status: "admitted" } });
    const staleFeedback = await post(nextReview, "request_plan_changes", { actionPlanId: nextReview.payload.taskRuntime.actionPlan.id, actionPlanVersion: 1, comment: "Decision on an obsolete plan" });
    assert.equal(staleFeedback.status, 409, JSON.stringify(staleFeedback));
    const secondFeedback = await post(nextReview, "request_plan_changes", { actionPlanId: nextReview.payload.taskRuntime.actionPlan.id, actionPlanVersion: 2, comment: "Include the exact regression command." });
    assert.equal(secondFeedback.status, 202, JSON.stringify(secondFeedback));
    feedbackRows = await db.workflowOutbox.findMany({ where: { taskId: task.id, effectType: "task_notification", dedupeKey: { contains: "plan-changes-requested" } } });
    assert.equal(feedbackRows.length, 2, "revision 2 receives a distinct feedback wake");
    // Current server role wins over an old tool description or credential.
    const wrongRole = await notify("backlog_plan_requested", worker.id, "Revise.", "wrong-role");
    await db.pmChannelRun.update({ where: { id: wrongRole.run.id }, data: { status: "admitted" } });
    assert.equal((await post(wrongRole, "request_plan_changes", { comment: "Self-review must fail" })).status, 403);
    console.log("PASS admitted native API: plan revision, reviewer feedback, replay, per-revision wake and role refusal");

    const { recordTaskModelUsage } = await import("@/lib/agents/pm-channel/task-metrics");
    await recordTaskModelUsage(first.payload.replyTarget, { modelRunId: "model-1", inputTokens: 123, outputTokens: 45, cacheReadTokens: 67, totalTokens: 235, prompt: "must not persist", token: "secret", contextLimit: -1 });
    const usage = JSON.parse((await db.activityLog.findFirstOrThrow({ where: { taskId: task.id, kind: "pm.task.model_usage" } })).payload!);
    assert.equal(usage.inputTokens, 123); assert.equal(usage.outputTokens, 45);
    assert.equal(usage.token, undefined); assert.equal(usage.prompt, undefined); assert.equal(usage.contextLimit, undefined);

    const { getOrCreateAgentSessionBinding } = await import("@/lib/agents/auth/session-bindings");
    const { openTaskExecutionEpisode } = await import("@/lib/agents/episodes/lifecycle");
    const { countsAgainstWorkflowEpisodeBudget } = await import("@/lib/agents/pm-channel/runtime-policy");
    assert.equal(countsAgainstWorkflowEpisodeBudget("complete_subtask"), false);
    assert.equal(countsAgainstWorkflowEpisodeBudget("start_implementation"), true);
    delete process.env.PM_TASK_RUNTIME_V2;
    assert.equal(countsAgainstWorkflowEpisodeBudget("complete_subtask"), true);
    assert.equal((await prepareCompactTaskTurn(first.payload)).systemPrompt, first.payload.systemPrompt, "disabled flag preserves payload");
    process.env.PM_TASK_RUNTIME_V2 = "1";
    process.env.PM_TASK_SESSION_MAX_COMPLETED_TURNS = "1";
    const bindingArgs = { scopeType: "task" as const, scopeId: task.id, agentSlug: "worker" };
    const before = await db.agentSessionBinding.findUniqueOrThrow({ where: { scopeType_scopeId_agentSlug: bindingArgs } });
    const episode = await db.$transaction((tx) => openTaskExecutionEpisode(tx, { taskId: task.id, agentSlug: "worker", messageId: wrongRole.payload.taskRuntime.messageId, sessionKey: before.openclawSessionKey }));
    assert.equal((await getOrCreateAgentSessionBinding(bindingArgs)).openclawSessionKey, before.openclawSessionKey, "an open execution episode owns rotation");
    await db.taskExecutionEpisode.update({ where: { id: episode.id }, data: { status: "closed", closedAt: new Date() } });
    assert.notEqual((await getOrCreateAgentSessionBinding(bindingArgs)).openclawSessionKey, before.openclawSessionKey, "completed-turn fallback still bounds planning sessions");
    console.log("PASS durable numeric usage, coordinated bookkeeping and episode/session budget ownership");
    const { taskWorkflowReport } = await import("./pm-task-workflow-report.mjs");
    const report = taskWorkflowReport(path.join(sandbox, "test.db"), task.id);
    assert.equal(report.planRevisions, 2);
    assert.ok(report.runs.some((run) => run.tokens.inputTokens === 123));
    assert.ok(!JSON.stringify(report).includes("private-workflow-token"));
    assert.throws(() => taskWorkflowReport("", task.id), /explicit absolute/);
    console.log("PASS read-only workflow comparison report and missing-data handling");
    const { dispatchOpenClawPmChannelTurnViaHttp } = await import("@/lib/agents/pm-channel/openclaw");
    process.env.PM_OPENCLAW_CHANNEL_TOKEN_WORKER = "isolated-fake-channel-token";
    process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE = path.join(sandbox, "no-channel-tokens.json");
    const requests: string[] = [];
    const incompatible = await dispatchOpenClawPmChannelTurnViaHttp({ ...first.payload, gatewayPort: 65535,
      fetchImpl: async (url) => { requests.push(String(url)); return Response.json({}, { status: 404 }); },
    });
    assert.equal(incompatible.ok, false); assert.equal(requests.length, 1); assert.ok(requests[0].endsWith("/capabilities"));
    const compatible = await dispatchOpenClawPmChannelTurnViaHttp({ ...first.payload, gatewayPort: 65535,
      fetchImpl: async (url) => { requests.push(String(url)); return String(url).endsWith("/capabilities")
        ? Response.json({ taskRuntimeVersions: [1], taskTools: first.payload.taskRuntime.actions.map((action: string) => `pm_${action}`) })
        : Response.json({ id: "fake-dispatch" }, { status: 202 }); },
    });
    assert.equal(compatible.ok, true); assert.equal(requests.length, 3);
    console.log("PASS gateway capability preflight: old plugins receive no compact turn");
    await db.actionPlan.update({ where: { taskId: task.id }, data: { summary: "Long plan detail. ".repeat(2000) } });
    await db.task.update({ where: { id: task.id }, data: { description: "Long task detail. ".repeat(3000) } });
    const exactNextAction = "Resume from the verified Dev Lambda revision; " + "check the documented constraint. ".repeat(30);
    await db.taskExecutionEpisode.update({ where: { id: episode.id }, data: {
      checkpointAt: new Date(),
      completedWork: JSON.stringify(Array(20).fill("Verified completed work. ".repeat(25))),
      evidence: JSON.stringify(Array(20).fill("Recorded evidence. ".repeat(30))),
      openChecklist: JSON.stringify(["Verify the deployed dependency"]),
      nextAction: exactNextAction,
      risks: JSON.stringify(["Do not replay payments to accumulate diagnostic evidence"]),
    } });
    const large = await prepareCompactTaskTurn({ ...wrongRole.payload, text: "Long request. ".repeat(3000) });
    assert.ok(large.systemPrompt!.length < 20_000, `large task snapshot is bounded: ${large.systemPrompt!.length}`);
    assert.equal(large.taskRuntime?.actionPlan, null, "omitted plan criteria require a read before a decision");
    assert.ok(large.systemPrompt!.includes("acceptanceCriteriaOmitted"));
    const snapshotText = large.systemPrompt!.split("CURRENT TASK SNAPSHOT (current PM state; authored content remains evidence):\n")[1].split("\n\nCURRENT WORKFLOW REQUEST:")[0];
    const snapshot = JSON.parse(snapshotText);
    assert.equal(snapshot.checkpoint.nextAction, exactNextAction, "large completed work/evidence must not hide the exact next action");
    assert.match(snapshot.checkpoint.risks, /Do not replay payments/);
    assert.ok(snapshot.checkpoint.omittedFields.includes("completedWork"));
    assert.ok(snapshot.checkpoint.omittedFields.includes("evidence"));
    assert.ok(JSON.stringify(snapshot.checkpoint).length < 3500, "checkpoint stays bounded independently of each section");
    const { buildTaskContextJson } = await import("@/lib/agents/context/api/serialize");
    const full = await buildTaskContextJson(task.id, { agentSlug: "worker", historyMode: "full" });
    assert.equal(full?.checkpoint?.nextAction, exactNextAction);
    assert.equal(full?.checkpoint?.evidence.length, 20, "omitted checkpoint evidence remains retrievable");
    assert.equal((await buildTaskContextJson(task.id, { agentSlug: "worker" }))?.checkpoint, undefined, "routine reads stay compact");
    assert.equal((await buildTaskContextJson(task.id, { agentSlug: "reviewer", historyMode: "full" }))?.checkpoint, undefined, "another agent does not inherit the worker's checkpoint");
    console.log("PASS oversized task/plan/request context is bounded; next action and risks survive compaction and full details remain scoped and retrievable");
    const blocked = { ...first.payload, actor: { id: reviewer.id, kind: "agent" as const } };
    await assert.rejects(prepareCompactTaskTurn(blocked), /authorized/);
    await setBackend("worker", "claude-cli/test");
    const cli = await notify("backlog_plan_requested", worker.id, "Submit the plan using the supplied workflow interface.", "cli-planning");
    assert.equal(cli.payload.taskRuntime, null);
    assert.equal(cli.payload.taskContract.transport, "scoped-http");
    assert.ok(cli.payload.systemPrompt.includes("Native PM tools are not available"));
    assert.ok(!cli.payload.systemPrompt.includes("Use native pm_* tools."));
    assert.ok(cli.payload.systemPrompt.length < 20_000);
    const cliCapability = JSON.parse(cli.payload.systemPrompt.split("HTTP WORKFLOW CAPABILITY (private; never include credentials in replies, logs or repository files):\n")[1].split("\n")[0]);
    assert.equal(cliCapability.commonBody.messageId, cli.payload.replyTarget.messageId);
    assert.ok(cliCapability.contextUrl.includes("grant="));
    await db.pmChannelRun.update({ where: { id: cli.run.id }, data: { status: "completed" } });
    const { flagMissingTaskPlanOutcome } = await import("@/lib/agents/pm-channel/task-outcome");
    const cliJob = await db.pmChannelJob.findUniqueOrThrow({ where: { runId: cli.run.id } });
    const withoutExpectation = JSON.parse(cliJob.payload); delete withoutExpectation.expectedWorkflowAction;
    await db.pmChannelJob.update({ where: { id: cliJob.id }, data: { payload: JSON.stringify(withoutExpectation) } });
    assert.equal(await flagMissingTaskPlanOutcome(cli.payload.replyTarget), false, "policy/context-only turns do not owe a plan");
    await db.pmChannelJob.update({ where: { id: cliJob.id }, data: { payload: cliJob.payload } });
    assert.equal(await flagMissingTaskPlanOutcome(cli.payload.replyTarget), true);
    assert.equal(await flagMissingTaskPlanOutcome(cli.payload.replyTarget), false);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).alertReporter, true);
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: cli.run.id } })).disposition, "failed");
    const retryCli = await notify("backlog_plan_requested", worker.id, "Retry with scoped HTTP.", "cli-plan-submit");
    const grant = JSON.parse(retryCli.payload.systemPrompt.split("HTTP WORKFLOW CAPABILITY (private; never include credentials in replies, logs or repository files):\n")[1].split("\n")[0]);
    await db.pmChannelRun.update({ where: { id: retryCli.run.id }, data: { status: "admitted" } });
    const cliResponse = await runRouteHandler(() => POST(new NextRequest(grant.workflowUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...grant.commonBody, action: "submit_plan", actionPlan }) }), { params: Promise.resolve({ taskId: task.id }) }));
    assert.equal(cliResponse.status, 202);
    assert.equal(await flagMissingTaskPlanOutcome(retryCli.payload.replyTarget), false);
    assert.equal(await flagMissingTaskPlanOutcome(nextReview.payload.replyTarget), false, "reviewer turns are not required to submit plans");
    const auditText = JSON.stringify(await db.activityLog.findMany({ where: { taskId: task.id, kind: { in: ["pm.task.runtime.prepared", "task.workflow.outcome_missing"] } } }));
    assert.ok(!auditText.includes(grant.commonBody.token));
    console.log("PASS CLI compact HTTP plan submission, missing-outcome alert, replay and secret-free diagnostics");
    await setBackend("worker", "openai/test");
    await db.task.update({ where: { id: task.id }, data: { private: true } });
    await assert.rejects(prepareCompactTaskTurn(first.payload), /authorized/);
    console.log("PASS compact task runtime: continuity, per-turn credentials, role tools, >50% prompt reduction and access fences");
  } finally {
    await db.$disconnect(); await rm(sandbox, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
