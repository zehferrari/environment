import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function source(path: string) {
  return readFileSync(path, "utf8");
}

const paths = [
  "lib/tasks/auto-start.ts",
  "lib/tasks/reviewer-assignment.ts",
  "lib/epics/assignment.ts",
  "lib/epics/queue.ts",
  "scripts/pm-workflow-nudge.ts",
] as const;
const files = Object.fromEntries(paths.map((path) => [path, source(path)]));

for (const [path, contents] of Object.entries(files)) {
  assert.doesNotMatch(contents, /recordLegacyWorkflowBoundaryInvocation/,
    `${path} must not remain a registered legacy mutation boundary`);
  assert.doesNotMatch(contents, /\bapplyTaskTransition\b|\btransitionTask\b/,
    `${path} must not call the task transition kernel`);
  assert.doesNotMatch(contents, /\.task\.(?:update|updateMany|delete|deleteMany)\s*\(/,
    `${path} must not write workflow-owned Task fields directly`);
}

const autoStart = files["lib/tasks/auto-start.ts"];
assert.match(autoStart, /submitWorkflowCommand\(\{/);
assert.match(autoStart, /intent: "start_implementation"/);
assert.match(autoStart, /source: "pm-service"/);
assert.match(autoStart, /"pm-policy:start"/);
assert.match(autoStart, /policyIdentityPart\(selectionReason, 120\)/,
  "auto-start idempotency must distinguish the selected policy reason");
for (const field of [
  "trigger",
  "selectionReason",
  "assigneeLane",
  "selectedTaskId",
  "selectedAssigneeId",
  "expectedWorkflowVersion",
]) {
  assert.match(autoStart, new RegExp(`\\b${field}\\b`), `auto-start policy evidence must carry ${field}`);
}
assert.match(autoStart, /result\.status !== "accepted" && result\.status !== "replayed"/,
  "a rejected start command must surface without a legacy fallback");
assert.doesNotMatch(autoStart, /ensureTaskCodeWorktree|drainWorkflowOutbox|publishBoardTouch/,
  "auto-start must leave repository and effect execution to canonical procedures/outbox workers");

const reviewerAssignment = files["lib/tasks/reviewer-assignment.ts"];
assert.match(reviewerAssignment, /submitWorkflowCommand\(\{/);
assert.match(reviewerAssignment, /intent: "assign_task"/);
assert.match(reviewerAssignment, /policy: "reviewer_assignment"/);
assert.match(reviewerAssignment, /approvedPlanPreserved/);
assert.match(reviewerAssignment, /resetUnapprovedPlan/);
assert.match(reviewerAssignment, /queueGeneration/,
  "reviewer assignment identity must advance when an unassigned task re-enters the queue");
assert.match(reviewerAssignment, /taskWorkflowCommandReceipt\.findUnique/);
assert.match(reviewerAssignment, /kind: "command_receipt",\s+id: assignmentReceipt\.id/,
  "reviewer auto-start must carry the causal assignment receipt instead of a workflow-version fallback");
assert.match(reviewerAssignment, /assignmentResult\.status !== "accepted" && assignmentResult\.status !== "replayed"/,
  "reviewer assignment must expose a rejected canonical command");

const epicAssignment = files["lib/epics/assignment.ts"];
assert.match(epicAssignment, /submitWorkflowCommandInTransaction\(tx, \{/);
assert.match(epicAssignment, /policy: "epic_queue_refill"/);
assert.match(epicAssignment, /queueGeneration/,
  "Epic queue assignment identity must advance when a task re-enters the queue without a status transition");
assert.match(epicAssignment, /throw new PolicyCommandRejected\("assign"/,
  "a rejected queue command must throw so the caller-owned batch rolls back");
assert.match(epicAssignment, /intent: "triage_task"/);
assert.match(epicAssignment, /throw new PolicyCommandRejected\("promote"/,
  "a rejected Epic promotion command must roll back the cascade transaction");

const epicQueue = files["lib/epics/queue.ts"];
assert.doesNotMatch(epicQueue, /for \(const assigned of assignment\.assignments\)/,
  "queue refill must not send a second notification outside the assignment command");
assert.match(epicQueue, /selectionReason: "all_prerequisites_done_for_preassigned_approved_task"/);
assert.match(epicQueue, /dependency_release_start_rejected/,
  "dependency release must surface a rejected start command");

const nudge = files["scripts/pm-workflow-nudge.ts"];
assert.match(nudge, /kind: "monitor_incident"/);
assert.match(nudge, /selectionReason: "monitor_detected_approved_todo_task_with_idle_lane"/);
assert.match(nudge, /pm_policy_auto_start_rejected/,
  "workflow nudges must surface canonical command rejection instead of silently sending a legacy-style wake");

async function integration() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "phasee-09-policy-"));
  const databaseUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  try {
    await execFileP("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    const { db } = await import("@/lib/db");
    const { startApprovedTodoTaskIfIdle } = await import("@/lib/tasks/auto-start");
    const { assignTaskAfterPlanApproval } = await import("@/lib/tasks/reviewer-assignment");
    const { assignOpenEpicTasks, promoteEpicBacklogTasks } = await import("@/lib/epics/assignment");

    const owner = await db.user.create({
      data: { username: "policy-owner", email: "policy-owner@example.invalid", kind: "human", isOwner: true },
    });
    const monitor = await db.agent.create({
      data: { slug: "policy-monitor", name: "Policy Monitor", role: "monitor" },
    });
    const serviceActor = await db.user.create({
      data: {
        username: "policy-monitor",
        email: "policy-monitor@example.invalid",
        kind: "agent",
        agentId: monitor.id,
      },
    });
    const codingAgent = await db.agent.create({
      data: { slug: "policy-worker", name: "Policy Worker", role: "coding" },
    });
    const worker = await db.user.create({
      data: {
        username: "policy-worker",
        email: "policy-worker@example.invalid",
        kind: "agent",
        agentId: codingAgent.id,
      },
    });
    const project = await db.project.create({ data: { slug: "policy-project", name: "Policy Project" } });
    const epic = await db.epic.create({
      data: {
        projectId: project.id,
        title: "Policy Epic",
        status: "To Do",
        approvedOn: new Date(),
        approvedById: owner.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
      },
    });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        title: "Approved idle task",
        status: "To Do",
        assigneeId: worker.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        approvedById: owner.id,
      },
    });

    const started = await startApprovedTodoTaskIfIdle({
      taskId: task.id,
      actor: { id: serviceActor.id, username: serviceActor.username, kind: "agent" },
      via: "pm-workflow-nudge",
      trigger: { kind: "monitor_incident", id: "incident-42" },
      selectionReason: "monitor_detected_approved_todo_task_with_idle_lane",
    });
    assert.equal(started.started, true);
    const [startedTask, promotedEpic, receipt, transition, procedure] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: task.id } }),
      db.epic.findUniqueOrThrow({ where: { id: epic.id } }),
      db.taskWorkflowCommandReceipt.findFirstOrThrow({
        where: { taskId: task.id, intent: "start_implementation", source: "pm-service" },
      }),
      db.workflowTransition.findFirstOrThrow({ where: { taskId: task.id, source: "pm-service" } }),
      db.taskProcedureRun.findFirstOrThrow({
        where: { taskId: task.id, type: "start_implementation_cycle" },
      }),
    ]);
    assert.equal(startedTask.status, "In Progress");
    assert.equal(startedTask.workflowVersion, 1);
    assert.equal(promotedEpic.status, "In Progress", "canonical start must atomically promote a To Do Epic");
    assert.equal(receipt.actorUserId, serviceActor.id,
      "PM policy receipt must retain the service actor rather than fabricating the assignee");
    assert.equal(receipt.status, "accepted");
    assert.match(receipt.idempotencyKey, /^pm-policy:start:monitor_incident:incident-42:/);
    assert.equal(procedure.status, "queued");
    assert.ok(transition.evidence, "canonical start transition must retain policy evidence");
    const evidence = JSON.parse(transition.evidence) as Record<string, unknown>;
    assert.equal(evidence.policy, "auto_start");
    assert.equal(evidence.selectedAssigneeId, worker.id);
    assert.deepEqual(evidence.trigger, { kind: "monitor_incident", id: "incident-42" });

    const waitingTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Second approved task",
        status: "To Do",
        assigneeId: worker.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        approvedById: owner.id,
      },
    });
    const busy = await startApprovedTodoTaskIfIdle({
      taskId: waitingTask.id,
      actor: { id: serviceActor.id, username: serviceActor.username, kind: "agent" },
      via: "dependency-completed",
      trigger: { kind: "workflow_transition", id: transition.id },
    });
    assert.equal(busy.started, false);
    if (busy.started) throw new Error("unreachable");
    assert.equal(busy.reason, "busy");
    assert.equal(await db.taskWorkflowCommandReceipt.count({ where: { taskId: waitingTask.id } }), 0,
      "an ineligible busy candidate must not submit a mutation command");

    const secondCodingAgent = await db.agent.create({
      data: { slug: "policy-worker-2", name: "Policy Worker 2", role: "coding" },
    });
    const secondWorker = await db.user.create({
      data: {
        username: "policy-worker-2",
        email: "policy-worker-2@example.invalid",
        kind: "agent",
        agentId: secondCodingAgent.id,
      },
    });
    const reviewerApprovedAt = new Date("2026-08-19T01:02:03.000Z");
    const reviewerAssignedTask = await db.task.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        title: "Reviewer-assigned approved task",
        status: "Backlog",
        actingManagerId: owner.id,
        reporterId: owner.id,
        approvedOn: reviewerApprovedAt,
        approvedById: owner.id,
      },
    });
    const reviewerAssignmentResult = await assignTaskAfterPlanApproval({
      taskId: reviewerAssignedTask.id,
      actor: { id: owner.id, username: owner.username, kind: "human" },
      assigneeUsername: secondWorker.username,
      requireReviewerUserId: owner.id,
      trigger: { kind: "policy_event", id: "reviewer-approval-7" },
    });
    assert.equal(reviewerAssignmentResult.ok, true);
    assert.equal(reviewerAssignmentResult.task.status, "In Progress",
      "an approved reviewer assignment must promote Backlog and enter the canonical start path");
    const [reviewerTaskAfter, reviewerReceipts] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: reviewerAssignedTask.id } }),
      db.taskWorkflowCommandReceipt.findMany({
        where: { taskId: reviewerAssignedTask.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    assert.equal(reviewerTaskAfter.assigneeId, secondWorker.id);
    assert.equal(reviewerTaskAfter.status, "In Progress");
    assert.equal(reviewerTaskAfter.workflowVersion, 2);
    assert.equal(reviewerTaskAfter.approvedOn?.toISOString(), reviewerApprovedAt.toISOString(),
      "approved-plan state must survive reviewer assignment and auto-start");
    const reviewerAssignReceipt = reviewerReceipts.find((row) => row.intent === "assign_task");
    const reviewerStartReceipt = reviewerReceipts.find((row) => row.intent === "start_implementation");
    assert.ok(reviewerAssignReceipt);
    assert.ok(reviewerStartReceipt);
    assert.match(reviewerAssignReceipt.idempotencyKey,
      /^pm-policy:assign:policy_event:reviewer-approval-7:reviewer_named_eligible_worker:/);
    assert.match(reviewerStartReceipt.idempotencyKey,
      new RegExp(`^pm-policy:start:command_receipt:${reviewerAssignReceipt.id}:newly_assigned_approved_task_lane_idle:`),
      "auto-start must be causally keyed by the exact assignment receipt");

    const thirdCodingAgent = await db.agent.create({
      data: { slug: "policy-worker-3", name: "Policy Worker 3", role: "coding" },
    });
    const thirdWorker = await db.user.create({
      data: {
        username: "policy-worker-3",
        email: "policy-worker-3@example.invalid",
        kind: "agent",
        agentId: thirdCodingAgent.id,
      },
    });
    const reviewerUnapprovedTask = await db.task.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        title: "Reviewer-assigned unapproved task",
        status: "Backlog",
        actingManagerId: owner.id,
        reporterId: owner.id,
      },
    });
    const historicalPlan = await db.actionPlan.create({
      data: {
        taskId: reviewerUnapprovedTask.id,
        summary: "Historical approved plan",
        status: "approved",
        authorId: thirdWorker.id,
        approvedOn: new Date("2026-08-18T00:00:00.000Z"),
        approvedById: owner.id,
        contentHash: "historical-plan",
      },
    });
    await db.actionPlanRevision.create({
      data: {
        actionPlanId: historicalPlan.id,
        taskId: reviewerUnapprovedTask.id,
        version: 1,
        summary: historicalPlan.summary,
        status: "approved",
        authorId: thirdWorker.id,
        approvedOn: historicalPlan.approvedOn,
        approvedById: owner.id,
        contentHash: historicalPlan.contentHash,
      },
    });
    const reviewerUnapprovedResult = await assignTaskAfterPlanApproval({
      taskId: reviewerUnapprovedTask.id,
      actor: { id: owner.id, username: owner.username, kind: "human" },
      assigneeUsername: thirdWorker.username,
      requireReviewerUserId: owner.id,
      trigger: { kind: "policy_event", id: "reviewer-assignment-8" },
    });
    assert.equal(reviewerUnapprovedResult.ok, true);
    const [reviewerUnapprovedAfter, currentPlanAfter, historicalRevisionAfter] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: reviewerUnapprovedTask.id } }),
      db.actionPlan.findUniqueOrThrow({ where: { taskId: reviewerUnapprovedTask.id } }),
      db.actionPlanRevision.findUniqueOrThrow({
        where: { taskId_version: { taskId: reviewerUnapprovedTask.id, version: 1 } },
      }),
    ]);
    assert.equal(reviewerUnapprovedAfter.assigneeId, thirdWorker.id);
    assert.equal(reviewerUnapprovedAfter.status, "Backlog",
      "an unapproved reviewer assignment must not promote or start the task");
    assert.equal(reviewerUnapprovedAfter.workflowVersion, 0,
      "assignment without a status edge must remain a canonical audited no-op");
    assert.equal(currentPlanAfter.status, "revision_required",
      "ownership change must reset the mutable unapproved plan projection");
    assert.equal(currentPlanAfter.approvedOn, null);
    assert.equal(historicalRevisionAfter.status, "approved",
      "ownership change must preserve historical approved-plan evidence");

    const queueProject = await db.project.create({
      data: { slug: "policy-queue-project", name: "Policy Queue Project" },
    });
    const queueEpic = await db.epic.create({
      data: {
        projectId: queueProject.id,
        title: "Policy Queue Epic",
        status: "To Do",
        approvedOn: new Date(),
        approvedById: owner.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
      },
    });
    const queueWorkers = [];
    for (const ordinal of [1, 2]) {
      const agent = await db.agent.create({
        data: { slug: `queue-worker-${ordinal}`, name: `Queue Worker ${ordinal}`, role: "coding" },
      });
      const user = await db.user.create({
        data: {
          username: `queue-worker-${ordinal}`,
          email: `queue-worker-${ordinal}@example.invalid`,
          kind: "agent",
          agentId: agent.id,
        },
      });
      await db.epicWorker.create({ data: { epicId: queueEpic.id, userId: user.id } });
      queueWorkers.push(user);
    }
    await db.task.create({
      data: {
        projectId: queueProject.id,
        epicId: queueEpic.id,
        title: "Existing queue tail",
        status: "To Do",
        rank: 10,
        assigneeId: owner.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
      },
    });
    const queueApprovedAt = new Date("2026-08-19T02:03:04.000Z");
    const queueApprovedTask = await db.task.create({
      data: {
        projectId: queueProject.id,
        epicId: queueEpic.id,
        title: "Queue approved task",
        status: "Backlog",
        rank: 1,
        approvedOn: queueApprovedAt,
        approvedById: owner.id,
        actingManagerId: owner.id,
        reporterId: owner.id,
      },
    });
    const queueUnapprovedTask = await db.task.create({
      data: {
        projectId: queueProject.id,
        epicId: queueEpic.id,
        title: "Queue unapproved task",
        status: "Backlog",
        rank: 2,
        actingManagerId: owner.id,
        reporterId: owner.id,
      },
    });
    const promoted = await db.$transaction((tx) => promoteEpicBacklogTasks(tx, {
      epicId: queueEpic.id,
      projectId: queueProject.id,
      actorUserId: serviceActor.id,
      via: "policy-test-promotion",
      trigger: { kind: "workflow_transition", id: "queue-generation-1" },
    }));
    assert.equal(promoted.length, 2);
    const promotedTasks = await db.task.findMany({
      where: { id: { in: [queueApprovedTask.id, queueUnapprovedTask.id] } },
      orderBy: { rank: "asc" },
    });
    assert.deepEqual(promotedTasks.map((row) => row.status), ["To Do", "To Do"]);
    assert.deepEqual(promotedTasks.map((row) => row.rank), [11, 12],
      "canonical promotion must preserve queue order after the existing To Do tail");
    assert.deepEqual(promotedTasks.map((row) => row.workflowVersion), [1, 1]);

    const queueGenerationByTask = new Map(promotedTasks.map((row) => [row.id, row.updatedAt.toISOString()]));
    const queueAssignment = await db.$transaction((tx) => assignOpenEpicTasks(tx, {
      epicId: queueEpic.id,
      projectId: queueProject.id,
      actorUserId: serviceActor.id,
      via: "policy-test-refill",
      trigger: { kind: "command_receipt", id: "queue-refill-receipt-1" },
    }));
    assert.equal(queueAssignment.assignments.length, 2);
    const [queueApprovedAfter, queueUnapprovedAfter] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: queueApprovedTask.id } }),
      db.task.findUniqueOrThrow({ where: { id: queueUnapprovedTask.id } }),
    ]);
    assert.ok(queueWorkers.some((candidate) => candidate.id === queueApprovedAfter.assigneeId));
    assert.ok(queueWorkers.some((candidate) => candidate.id === queueUnapprovedAfter.assigneeId));
    assert.notEqual(queueApprovedAfter.assigneeId, queueUnapprovedAfter.assigneeId);
    assert.equal(queueApprovedAfter.approvedOn?.toISOString(), queueApprovedAt.toISOString());
    assert.equal(queueUnapprovedAfter.approvedOn, null);
    const queueReceipts = await db.taskWorkflowCommandReceipt.findMany({
      where: {
        taskId: { in: [queueApprovedTask.id, queueUnapprovedTask.id] },
        intent: "assign_task",
      },
    });
    assert.equal(queueReceipts.length, 2);
    for (const receiptRow of queueReceipts) {
      const queueGeneration = queueGenerationByTask.get(receiptRow.taskId);
      assert.ok(queueGeneration);
      assert.match(receiptRow.idempotencyKey,
        new RegExp(`^pm-policy:assign:command_receipt:queue-refill-receipt-1:(?:preferred_freed_worker_for_next_unblocked_task|first_free_epic_worker_for_unblocked_queue_head):${queueGeneration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
    }

    await db.$disconnect();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

integration()
  .then(() => console.log("[phasee-09-policy-automation] PASS"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
