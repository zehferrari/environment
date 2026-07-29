import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchNameFromWorkItemKey,
  effectiveEpicBranchName,
  effectiveTaskBranchName,
} from "../lib/work-items/branches";
import { effectiveCommitPrefix, effectiveTaskCommitPrefix } from "../lib/work-items/keys";
import { subjectHasCommitPrefix } from "../lib/work-items/commit-prefix";
import { checkStatusTransition } from "../lib/workflow";
import { syncEpicOnHumanTaskStatus } from "../lib/epics/sync-on-human-task-move";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  branchNameFromWorkItemKey("V23-3") === "v23-3",
  "work-item branch fallback must preserve the human key and normalize its case",
);
assert(
  effectiveEpicBranchName({ workItemKey: "V23-2", branchName: "workflow-update" }) === "workflow-update",
  "existing Epic branch must win",
);
assert(
  effectiveEpicBranchName({ workItemKey: "V23-2", branchName: "" }) === "v23-2",
  "empty Epic branch must fall back to its human work-item key",
);
assert(
  effectiveEpicBranchName({ workItemKey: null, branchName: "" }) === null,
  "legacy Epics without a human key must not leak their database id into a branch",
);

// Own branch per task: an Epic child with no explicit override works on its own
// key-derived branch (not the shared Epic branch) so independent Epic tasks run
// in parallel across agents. An explicit Task branch still wins; a keyless
// legacy task falls back to the Epic branch.
const taskWithChangingEpic = {
  workItemKey: "V23-3",
  branchName: null,
  epic: { workItemKey: "V23-2", branchName: "epic-before" },
};
assert(
  effectiveTaskBranchName(taskWithChangingEpic) === "v23-3",
  "an Epic child without an override uses its own work-item branch (parallel per-task branches)",
);
taskWithChangingEpic.epic.branchName = "epic-after";
assert(
  effectiveTaskBranchName(taskWithChangingEpic) === "v23-3",
  "an Epic branch change must not move a child that owns a key-derived branch",
);
assert(
  effectiveTaskBranchName({ ...taskWithChangingEpic, branchName: "task-override" }) === "task-override",
  "an explicit Task branch must override its Epic",
);
assert(
  effectiveTaskBranchName({ workItemKey: "V23-3", branchName: null, epic: { workItemKey: "V23-2", branchName: null } }) === "v23-3",
  "an Epic child without explicit branches uses its own human-key branch",
);
assert(
  effectiveTaskBranchName({ workItemKey: "V23-3", branchName: null, epic: null }) === "v23-3",
  "a standalone Task without an explicit branch must use its human key",
);
assert(
  effectiveTaskBranchName({ workItemKey: null, branchName: null, epic: { workItemKey: "V23-2", branchName: "epic-branch" } }) === "epic-branch",
  "a legacy Task without its own key falls back to the Epic branch",
);

assert(
  effectiveTaskCommitPrefix({ workItemKey: "V23-3", commitPrefix: "TASK", epic: { commitPrefix: "EPIC" } }) === "TASK",
  "an explicit Task commit prefix must win",
);
assert(
  effectiveTaskCommitPrefix({ workItemKey: "V23-3", commitPrefix: null, epic: { commitPrefix: "EPIC" } }) === "EPIC",
  "an Epic child without an override must inherit the explicit Epic commit prefix",
);
assert(
  effectiveTaskCommitPrefix({ workItemKey: "V23-3", commitPrefix: null, epic: { commitPrefix: null } }) === "V23-3",
  "a Task without an explicit Task or Epic prefix must use its human key",
);
assert(
  effectiveTaskCommitPrefix({ workItemKey: null, commitPrefix: null, epic: { commitPrefix: null } }) === null,
  "legacy Tasks without a human key must not use their database id as a prefix",
);
assert(
  effectiveCommitPrefix({ commitPrefix: null, workItemKey: "V23-2" }) === "V23-2",
  "an Epic commit prefix must fall back to its human key",
);
assert(subjectHasCommitPrefix("V23-3 Add GreenID client", "V23-3"), "a space-delimited human key must match");
assert(subjectHasCommitPrefix("V23-3: Add GreenID client", "V23-3"), "a colon-delimited human key must match");
assert(!subjectHasCommitPrefix("V23-30 Add another task", "V23-3"), "a longer human key must not satisfy a shorter prefix");

const root = process.cwd();
const workflowRoute = readFileSync(join(root, "app/api/agent/epics/[epicId]/workflow/route.ts"), "utf8");
assert(!workflowRoute.includes("effectiveEpicBranchName(epic)"), "Epic manager workflow must not persist a generated branch");
assert(workflowRoute.includes("branchName: null"), "Epic-created Tasks must keep a null branch override");
assert(workflowRoute.includes("commitPrefix: null"), "Epic-created Tasks must keep a null commit-prefix override");

const proposalApply = readFileSync(join(root, "lib/work-items/apply.ts"), "utf8");
assert(!proposalApply.includes("inheritedBranchName"), "proposal-created Tasks must not copy an Epic branch");
assert(!proposalApply.includes("inheritedCommitPrefix"), "proposal-created Tasks must not copy an Epic prefix");
assert(proposalApply.includes("branchName: null"), "proposal-created Tasks must retain a null branch override");
assert(proposalApply.includes("commitPrefix: null"), "proposal-created Tasks must retain a null prefix override");

const epicActions = readFileSync(join(root, "lib/epics/actions.ts"), "utf8");
assert(!epicActions.includes("effectiveEpicBranchName(epic)"), "UI-created Epic Tasks must not persist a generated Epic branch");
assert(epicActions.includes("branchName: null"), "UI-created Epic Tasks must retain a null branch override");
assert(epicActions.includes("commitPrefix: null"), "UI-created Epic Tasks must retain a null prefix override");

const projectPage = readFileSync(join(root, "app/(app)/projects/[slug]/page.tsx"), "utf8");
assert(projectPage.includes("branchName: null"), "board-created Tasks must retain a null branch override");
assert(projectPage.includes("commitPrefix: null"), "board-created Tasks must retain a null prefix override");

const taskPage = readFileSync(join(root, "app/(app)/projects/[slug]/tasks/[taskId]/page.tsx"), "utf8");
assert(taskPage.includes("data.branchName = newBranch"), "clearing a Task branch override must persist null, not a copied fallback");
assert(taskPage.includes("data.commitPrefix = newCommitPrefix"), "clearing a Task prefix override must persist null, not a copied fallback");
assert(taskPage.includes('defaultValue={task.branchName ?? ""}'), "the Task form must not submit an inherited branch as an override");
assert(taskPage.includes('defaultValue={task.commitPrefix ?? ""}'), "the Task form must not submit an inherited prefix as an override");

const reviewAutomation = readFileSync(join(root, "lib/tasks/review-automation.ts"), "utf8");
assert(reviewAutomation.includes('status: "Done"'), "last Epic task completion must move the Epic to Done");
assert(reviewAutomation.includes("remainingOpenTasks === 0"), "the Epic Done rollup must only happen on the last open Epic task");

const taskNotifications = readFileSync(join(root, "lib/agents/workflow/notifications/task.ts"), "utf8");
assert(taskNotifications.includes("never edit a primary checkout"), "worktree guidance must prohibit primary-checkout edits");
assert(taskNotifications.includes("tag the reporter"), "worktree failure guidance must tell agents to tag the reporter");
assert(taskNotifications.includes("do not demand splitting for small or strictly sequential/dependent work"), "reviewer split-feedback rule must preserve small/sequential exception");

// --- 2026-07 workflow overhaul (P1-P6) ---

// P1: the Review → In Progress edge is abolished; Done → Review re-open stays.
assert(
  !checkStatusTransition({ from: "Review", to: "In Progress", actor: { id: "u1", kind: "human" } }).ok,
  "Review → In Progress must be an invalid transition (P1: no Review resume)",
);
assert(
  checkStatusTransition({ from: "Done", to: "Review", actor: { id: "u1", kind: "human" } }).ok,
  "Done → Review re-open edge must remain",
);

const taskWorkflowRoute = readFileSync(join(root, "app/api/agent/tasks/[taskId]/workflow/route.ts"), "utf8");
// start = To Do → In Progress only; the Review-resume branch is deleted.
assert(taskWorkflowRoute.includes('task.status !== "To Do"'), "workflow start must be allowed from To Do only");
assert(
  !taskWorkflowRoute.includes("To Do or Review before start"),
  "the start action must not accept tasks in Review (no resume path)",
);
assert(
  taskWorkflowRoute.includes("start cannot resume a task from Review"),
  "the start rejection must explain the review_feedback → To Do front flow",
);
// P4: start runs the shared per-project WIP + branch-clash gate.
assert(
  taskWorkflowRoute.includes("findInProgressStartConflict"),
  "workflow start must run the shared WIP/branch-clash gate before transition",
);
assert(
  taskWorkflowRoute.includes("1 In Progress task per agent per project"),
  "the WIP rejection must state the per-project limit so agents know what to finish",
);
// P3: ready_for_review is rejected while open implementation sub-tasks exist.
assert(
  taskWorkflowRoute.includes("openImplementationSubtasks"),
  "ready_for_review must reject when open implementation sub-tasks exist",
);
assert(
  taskWorkflowRoute.includes("ready_for_review rejected"),
  "the sub-task gate rejection must list the open items and how to clear them",
);
// PH-124 close-the-loop: ticking the last open implementation sub-task tells
// the agent to call ready_for_review with the same reusable token AND
// dispatches a belt-and-braces fresh workflow turn.
assert(
  taskWorkflowRoute.includes("allImplementationSubtasksComplete"),
  "complete_subtask must flag when the last implementation sub-task closes",
);
assert(
  taskWorkflowRoute.includes("call action=ready_for_review NOW with this same messageId and token"),
  "complete_subtask must instruct an immediate ready_for_review with the reusable token",
);
assert(
  taskWorkflowRoute.includes('reason: "ready_for_review_available"'),
  "complete_subtask must auto-dispatch a ready_for_review_available workflow turn",
);

// P4: the shared gate lives in auto-start and is per-project.
const autoStartLib = readFileSync(join(root, "lib/tasks/auto-start.ts"), "utf8");
assert(
  autoStartLib.includes("export async function findInProgressStartConflict"),
  "auto-start must export the shared In Progress entry gate",
);
assert(
  autoStartLib.includes("projectId: args.projectId"),
  "the shared WIP gate must scope the busy check to the task's project",
);
assert(
  autoStartLib.includes("findInProgressStartConflict(tx"),
  "auto-start must consume the shared gate inside its transaction",
);

// Ack is a liveness ping only — no status transition anywhere.
const ackRoute = readFileSync(join(root, "app/api/tasks/[id]/ack/route.ts"), "utf8");
assert(!ackRoute.includes("autoTransitionOnAck"), "ack must not consult the removed auto-transition rule");
assert(!ackRoute.includes("task.update"), "ack must not write task status");
assert(ackRoute.includes("transitioned: false"), "ack must always report transitioned: false");
const workflowLib = readFileSync(join(root, "lib/workflow.ts"), "utf8");
assert(!workflowLib.includes("export function autoTransitionOnAck"), "lib/workflow must not export the ack auto-transition");

// P5: one shared Review-entry handoff, called by the agent route AND every
// human board-move surface, with the epicChild fields the verifier consumes.
const reviewHandoff = readFileSync(join(root, "lib/tasks/review-handoff.ts"), "utf8");
assert(reviewHandoff.includes("export async function runTaskReviewHandoff"), "review-handoff must export runTaskReviewHandoff");
assert(reviewHandoff.includes("epicChild"), "the verify job must carry epicChild");
assert(reviewHandoff.includes("epicBranch"), "the verify job must carry epicBranch");
assert(reviewHandoff.includes("preferUserId"), "the Review refill must prefer the freed worker");
assert(
  reviewHandoff.includes("syncEpicOnHumanTaskStatus"),
  "the shared Review handoff must reopen a Done parent Epic for human Review moves",
);
assert(taskWorkflowRoute.includes("runTaskReviewHandoff"), "the agent workflow route must use the shared Review handoff");
for (const pagePath of [
  "app/(app)/projects/[slug]/page.tsx",
  "app/(app)/projects/[slug]/tasks/[taskId]/page.tsx",
  "app/(app)/workspaces/[slug]/page.tsx",
  "app/(app)/workspaces/(landing)/page.tsx",
]) {
  const pageSource = readFileSync(join(root, pagePath), "utf8");
  assert(pageSource.includes("runTaskReviewHandoff"), `${pagePath} must run the shared Review handoff on human moves to Review`);
  assert(pageSource.includes("human-board-move"), `${pagePath} must audit human moves with via: human-board-move`);
  assert(
    pageSource.includes("syncEpicOnHumanTaskStatus"),
    `${pagePath} must keep a parent Epic actionable after a human child-task move`,
  );
}

// PH-124 item B: every workflow action with a durable outcome settles the
// PM-channel run. 7 original actions + the 5 that used to leave the run
// dangling (add_subtask, complete_subtask, request_subtask, request_task,
// flag_extra_work_blocker) = 12 call sites.
assert(
  taskWorkflowRoute.split("recordPmChannelRunWorkflowAction(").length - 1 === 12,
  "all 12 durable-outcome workflow actions must settle the PM-channel run",
);

// request-workflow-turn: PM-bearer-authenticated self-service turn re-arm.
const requestTurnRoute = readFileSync(join(root, "app/api/agent/tasks/[taskId]/request-workflow-turn/route.ts"), "utf8");
assert(requestTurnRoute.includes("authorizePmChannelCallback"), "request-workflow-turn must reuse the PM-channel bearer auth");
assert(requestTurnRoute.includes("task.workflow.turn_requested"), "request-workflow-turn must log an ActivityLog row");
assert(requestTurnRoute.includes("ready_for_review_available"), "request-workflow-turn must arm ready_for_review from In Progress");
assert(taskNotifications.includes("request-workflow-turn"), "the standing workflow rules must advertise request-workflow-turn");

// P1 wording: no Review-resume instructions survive; review_feedback returns
// the task to the FRONT of To Do.
assert(
  !taskNotifications.includes("call action=start to move it back to In Progress"),
  "the standing rules must not instruct a Review resume via start",
);
assert(
  taskNotifications.includes("FRONT of To Do"),
  "review_feedback wording must send the task to the front of To Do",
);
// P6 wording: epic children commit locally and never push.
assert(taskNotifications.includes("NEVER push this branch to origin"), "epic-child commit hygiene must forbid origin pushes");
const branchVerifier = readFileSync(join(root, "scripts/pm-verify-branch-pushed.ts"), "utf8");
assert(
  branchVerifier.includes("inspectOriginBranch(job.repositoryPath, job.branchName)"),
  "the Epic-child reviewer gate must inspect the remote itself for forbidden task refs",
);
assert(
  branchVerifier.includes("Epic-child policy breach"),
  "the monitor must report a forbidden remote Epic-child ref visibly",
);
assert(
  branchVerifier.includes("epicMode\n    ? !state.remoteSha"),
  "a published Epic-child ref must fail reviewer hand-off",
);
const epicMerge = readFileSync(join(root, "lib/deploy/epic-merge.ts"), "utf8");
assert(
  epicMerge.includes("publishEpicBranch({"),
  "Epic-Done finalization must explicitly publish the Epic branch",
);
assert(
  epicMerge.includes("includeArchived: true"),
  "only the explicit Epic-Done hook may queue archived child merges",
);
assert(
  epicMerge.includes("...(job.includeArchived ? {} : { archivedAt: null })"),
  "ordinary merge jobs must reject archived historical tasks",
);
assert(
  !epicMerge.includes('if (branches.length === 0) return { enqueued: false'),
  "Epic-Done publication must still enqueue when there are no child refs to clean",
);
assert(
  epicMerge.includes("removeMergedOriginChildBranch({"),
  "Epic-Done cleanup must safely remove leaked remote child refs",
);

// onlyReportersCanApprovePullRequests: the Development-section approve
// actions enforce the flag server-side (reporter-only when set).
const deployActions = readFileSync(join(root, "lib/deploy/actions.ts"), "utf8");
assert(
  deployActions.includes("onlyReportersCanApprovePullRequests ? isReporter : isReporter || isReviewer"),
  "deployment PR approval must be reporter-only server-side when the project flag is set",
);

console.log("workflow-agent-rules static checks passed");

async function testHumanTaskMoveEpicSync() {
  function fakeClient(initialStatus: string) {
    let status = initialStatus;
    const activities: Array<Record<string, unknown>> = [];
    const client = {
      epic: {
        findUnique: async () => ({ id: "epic-1", status }),
        updateMany: async (args: {
          where: { status: string };
          data: { status: string };
        }) => {
          if (args.where.status !== status) return { count: 0 };
          status = args.data.status;
          return { count: 1 };
        },
      },
      activityLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          activities.push(args.data);
          return args.data;
        },
      },
    };
    return {
      client,
      status: () => status,
      activities,
    };
  }

  const queued = fakeClient("Done");
  assert(
    await syncEpicOnHumanTaskStatus(queued.client as never, {
      epicId: "epic-1",
      projectId: "project-1",
      taskId: "task-1",
      actorId: "human-1",
      actorKind: "human",
      targetStatus: "To Do",
      via: "human-board-move",
    }),
    "a human reopening a child to To Do must reopen its Done parent Epic",
  );
  assert(queued.status() === "To Do", "a queued child must reopen its parent Epic to To Do");

  const reviewing = fakeClient("Done");
  await syncEpicOnHumanTaskStatus(reviewing.client as never, {
    epicId: "epic-1",
    projectId: "project-1",
    taskId: "task-1",
    actorId: "human-1",
    actorKind: "human",
    targetStatus: "Review",
    via: "human-board-move",
  });
  assert(
    reviewing.status() === "In Progress",
    "a human reopening a child to Review must reopen its parent Epic to In Progress",
  );
  assert(
    reviewing.activities.length === 1,
    "the derived Epic transition must be audited exactly once",
  );

  const agentMove = fakeClient("Done");
  assert(
    !(await syncEpicOnHumanTaskStatus(agentMove.client as never, {
      epicId: "epic-1",
      projectId: "project-1",
      taskId: "task-1",
      actorId: "agent-1",
      actorKind: "agent",
      targetStatus: "In Progress",
      via: "agent-workflow",
    })),
    "an agent task move must never reopen a Done Epic",
  );
  assert(agentMove.status() === "Done", "agent moves must leave a Done Epic unchanged");
}

// --- PH-124 item B (scratch-DB slice): the five formerly-unsettled actions
// must settle both PM-channel runs (task-comment + task-chat target keys) and
// their jobs; a role-violation (403) must leave the run untouched.
//
// The static imports above transitively construct the shared Prisma client
// (lib/work-items/keys.ts -> lib/db), so DATABASE_URL cannot be pointed at
// the scratch DB from inside this process. The parent run prepares the
// scratch DB and re-spawns this same script with WORKFLOW_RULES_DB_SLICE=1
// and the env set at spawn; the child executes the slice. ---
async function pmRunSettlementSlice() {
  // MUST come before any Next internal (the route module) is evaluated: it
  // installs globalThis.AsyncLocalStorage for Next's async-local-storage.
  await import("./lib/next-als-polyfill");
  const [{ db }, route, { createTaskWorkflowToken }, { runRouteHandler }, { NextRequest }] =
    await Promise.all([
      import("../lib/db"),
      import("../app/api/agent/tasks/[taskId]/workflow/route"),
      import("../lib/agents/workflow/token/task"),
      import("./lib/next-route-harness"),
      import("next/server"),
    ]);

  try {
    const owner = await db.user.create({
      data: {
        username: "wf-owner",
        email: "wf-owner@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const assigneeAgent = await db.agent.create({
      data: { slug: "wf-assignee", name: "WF Assignee", role: "coding" },
    });
    const assigneeUser = await db.user.create({
      data: {
        username: "wf-assignee",
        email: "wf-assignee@example.test",
        kind: "agent",
        agentId: assigneeAgent.id,
        mustRotatePassword: false,
      },
    });
    const reviewerAgent = await db.agent.create({
      data: { slug: "wf-reviewer", name: "WF Reviewer", role: "coding" },
    });
    const reviewerUser = await db.user.create({
      data: {
        username: "wf-reviewer",
        email: "wf-reviewer@example.test",
        kind: "agent",
        agentId: reviewerAgent.id,
        mustRotatePassword: false,
      },
    });
    const project = await db.project.create({
      data: { slug: "wf-settle", name: "Workflow Settle" },
    });
    const epic = await db.epic.create({
      data: {
        projectId: project.id,
        title: "Settle epic",
        status: "In Progress",
        actingManagerId: reviewerUser.id,
      },
    });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        epicId: epic.id,
        title: "Settle task",
        status: "In Progress",
        assigneeId: assigneeUser.id,
        actingManagerId: reviewerUser.id,
        reporterId: owner.id,
        approvedOn: new Date(),
      },
    });

    // One grant per action: message + BOTH PM run target keys + jobs, seeded
    // in the settleable "accepted" state (the state a live turn is in while
    // the agent works).
    const grantFor = async (slug: string) => {
      const msg = await db.agentChatMessage.create({
        data: {
          projectId: project.id,
          taskId: task.id,
          agentSlug: slug,
          senderUserId: owner.id,
          body: "workflow grant",
          originChannel: "comment",
        },
        select: { id: true },
      });
      for (const kind of ["task-comment", "task-chat"] as const) {
        const run = await db.pmChannelRun.create({
          data: {
            targetKey: `${kind}:${slug}:${task.id}:${msg.id}`,
            kind,
            agentSlug: slug,
            messageId: msg.id,
            projectId: project.id,
            taskId: task.id,
            status: "accepted",
          },
        });
        await db.pmChannelJob.create({
          data: {
            runId: run.id,
            agentSlug: slug,
            kind,
            payload: "{}",
            status: "accepted",
          },
        });
      }
      return msg.id;
    };

    const runStates = async (slug: string, messageId: string) => {
      const runs = await db.pmChannelRun.findMany({
        where: { messageId, agentSlug: slug },
        select: { status: true, jobs: { select: { status: true } } },
      });
      return {
        runStatuses: runs.map((run) => run.status),
        jobStatuses: runs.flatMap((run) => run.jobs.map((job) => job.status)),
      };
    };

    const call = async (slug: string, messageId: string, body: Record<string, unknown>) => {
      const token = createTaskWorkflowToken(messageId, task.id, slug);
      const req = new NextRequest(`http://127.0.0.1/api/agent/tasks/${task.id}/workflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, token, ...body }),
      });
      const res = await runRouteHandler(() => route.POST(req, {
        params: Promise.resolve({ taskId: task.id }),
      }));
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };

    const assertSettled = async (slug: string, messageId: string, action: string) => {
      const { runStatuses, jobStatuses } = await runStates(slug, messageId);
      assert(runStatuses.length === 2, `${action}: both target-key runs must exist`);
      assert(
        runStatuses.every((status) => status === "complete"),
        `${action}: both PM runs must settle complete (got ${runStatuses.join(", ")})`,
      );
      assert(
        jobStatuses.every((status) => status === "complete"),
        `${action}: both PM jobs must settle complete (got ${jobStatuses.join(", ")})`,
      );
    };

    // add_subtask (assignee)
    const addGrant = await grantFor("wf-assignee");
    const added = await call("wf-assignee", addGrant, {
      action: "add_subtask",
      subtaskText: "settle step one",
    });
    assert(added.status === 200, `add_subtask must succeed (got ${added.status}: ${JSON.stringify(added.body)})`);
    await assertSettled("wf-assignee", addGrant, "add_subtask");

    // complete_subtask (assignee)
    const completeGrant = await grantFor("wf-assignee");
    const completed = await call("wf-assignee", completeGrant, {
      action: "complete_subtask",
      subtaskId: added.body.subtaskId,
      minutesSpent: 3,
    });
    assert(completed.status === 200, `complete_subtask must succeed (got ${completed.status}: ${JSON.stringify(completed.body)})`);
    await assertSettled("wf-assignee", completeGrant, "complete_subtask");

    // request_subtask (resolved reviewer)
    const requestSubtaskGrant = await grantFor("wf-reviewer");
    const requestedSubtask = await call("wf-reviewer", requestSubtaskGrant, {
      action: "request_subtask",
      subtaskText: "add regression coverage",
      comment: "the fix needs a test",
    });
    assert(
      requestedSubtask.status === 200,
      `request_subtask must succeed (got ${requestedSubtask.status}: ${JSON.stringify(requestedSubtask.body)})`,
    );
    await assertSettled("wf-reviewer", requestSubtaskGrant, "request_subtask");

    // request_task (assignee -> epic acting manager)
    const requestTaskGrant = await grantFor("wf-assignee");
    const requestedTask = await call("wf-assignee", requestTaskGrant, {
      action: "request_task",
      subtaskText: "Follow-up task title",
      comment: "out of current scope",
    });
    assert(
      requestedTask.status === 200,
      `request_task must succeed (got ${requestedTask.status}: ${JSON.stringify(requestedTask.body)})`,
    );
    await assertSettled("wf-assignee", requestTaskGrant, "request_task");

    // flag_extra_work_blocker (assignee)
    const blockerGrant = await grantFor("wf-assignee");
    const flagged = await call("wf-assignee", blockerGrant, {
      action: "flag_extra_work_blocker",
      comment: "requested extra scope blocks the approved plan",
    });
    assert(flagged.status === 200, `flag_extra_work_blocker must succeed (got ${flagged.status}: ${JSON.stringify(flagged.body)})`);
    await assertSettled("wf-assignee", blockerGrant, "flag_extra_work_blocker");

    // Role violation: a reviewer calling add_subtask (implementation kind)
    // 403s and must NOT settle its runs — error paths leave the turn live.
    const deniedGrant = await grantFor("wf-reviewer");
    const denied = await call("wf-reviewer", deniedGrant, {
      action: "add_subtask",
      subtaskText: "not allowed",
    });
    assert(denied.status === 403, `non-assignee add_subtask must 403 (got ${denied.status})`);
    const deniedStates = await runStates("wf-reviewer", deniedGrant);
    assert(
      deniedStates.runStatuses.every((status) => status === "accepted"),
      `403 path must leave the PM runs untouched (got ${deniedStates.runStatuses.join(", ")})`,
    );
    assert(
      deniedStates.jobStatuses.every((status) => status === "accepted"),
      `403 path must leave the PM jobs untouched (got ${deniedStates.jobStatuses.join(", ")})`,
    );
  } finally {
    await db.$disconnect();
  }
}

async function runPmRunSettlementSliceInChild() {
  await testHumanTaskMoveEpicSync();
  const { execFile } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { promisify } = await import("node:util");
  const path = await import("node:path");
  const execFileP = promisify(execFile);

  const sandbox = await mkdtemp(path.join(tmpdir(), "workflow-agent-rules-db-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const childEnv = {
    ...process.env,
    DATABASE_URL: dbUrl,
    WORKFLOW_RULES_DB_SLICE: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "workflow-agent-rules-test-secret",
    PM_ASYNC_DISPATCH: "1",
    PM_ASYNC_DISPATCH_INLINE_NUDGE: "0",
  };
  try {
    await execFileP(
      "pnpm",
      ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
      { env: childEnv, cwd: process.cwd() },
    );
    const { stdout } = await execFileP(
      "pnpm",
      ["exec", "tsx", "scripts/workflow-agent-rules-test.ts"],
      { env: childEnv, cwd: process.cwd() },
    );
    assert(
      stdout.includes("workflow-agent-rules PM-run settlement slice passed"),
      "the DB slice child must report success",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

if (process.env.WORKFLOW_RULES_DB_SLICE === "1") {
  pmRunSettlementSlice()
    .then(() => {
      console.log("workflow-agent-rules PM-run settlement slice passed");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  runPmRunSettlementSliceInChild()
    .then(() => {
      console.log("workflow-agent-rules-test passed");
    })
    .catch((err) => {
      if (err && typeof err === "object" && "stdout" in err) {
        console.error(String((err as { stdout?: unknown }).stdout ?? ""));
        console.error(String((err as { stderr?: unknown }).stderr ?? ""));
      }
      console.error(err);
      process.exit(1);
    });
}
