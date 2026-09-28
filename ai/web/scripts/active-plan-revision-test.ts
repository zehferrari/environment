import './lib/next-als-polyfill';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

async function main() {
  const dir = await mkdtemp('/tmp/pm-active-plan-');
  Object.assign(process.env, { DATABASE_URL: `file:${dir}/test.db`, AUTH_SECRET: 'isolated-plan-revision', PM_ASYNC_DISPATCH: '1', PM_ASYNC_DISPATCH_INLINE_NUDGE: '0', PM_TASK_RUNTIME_V2: '1', PM_AGENT_CONFIG_ROOT: `${dir}/agents` });
  await mkdir(`${dir}/agents/worker`, { recursive: true });
  await writeFile(`${dir}/agents/worker/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: 'openai/test' } } } }));
  await promisify(execFile)('pnpm', ['prisma', 'migrate', 'deploy'], { env: process.env });
  const { db } = await import('@/lib/db');
  try {
    const { persistActionPlan, createChecklistAndDelegatableTasksFromPlan } = await import('@/lib/tasks/action-plan-store');
    const { submitWorkflowCommand } = await import('@/lib/tasks/orchestrator');
    const { openTaskWorkflowCycle } = await import('@/lib/tasks/workflow-cycle');
    const { taskToolActions } = await import('@/lib/agents/pm-channel/task-runtime');
    const owner = await db.user.create({ data: { username: 'owner', email: 'owner@plan.invalid', kind: 'human', isOwner: true } });
    const workerAgent = await db.agent.create({ data: { slug: 'worker', name: 'Worker', role: 'coding' } });
    const worker = await db.user.create({ data: { username: 'worker', email: 'worker@plan.invalid', kind: 'agent', agentId: workerAgent.id } });
    const reviewerAgent = await db.agent.create({ data: { slug: 'reviewer', name: 'Reviewer', role: 'coding' } });
    const reviewer = await db.user.create({ data: { username: 'reviewer', email: 'reviewer@plan.invalid', kind: 'agent', agentId: reviewerAgent.id } });
    const outsider = await db.user.create({ data: { username: 'outsider', email: 'outsider@plan.invalid', kind: 'agent' } });
    const project = await db.project.create({ data: { slug: 'plans', name: 'Plan fixture', workMode: 'general' } });
    const task = await db.task.create({ data: { projectId: project.id, title: 'Revise active scope', status: 'In Progress', assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
    const step = (id: string, title: string) => ({ id, title, acceptanceCriteria: [`Verify ${title}`], kind: 'sequential' as const, phase: 'implementation' as const, responsibleActor: 'assignee' as const });
    const original = { summary: 'Original implementation', steps: [step('keep', 'Keep verified work'), step('change', 'Changed requirement'), step('remove', 'Replaced requirement')] };
    const plan = await persistActionPlan({ taskId: task.id, input: original, authorId: worker.id });
    const approvedAt = new Date();
    await db.task.update({ where: { id: task.id }, data: { approvedOn: approvedAt, approvedById: owner.id } });
    await db.actionPlan.update({ where: { id: plan.id }, data: { status: 'approved', approvedOn: approvedAt, approvedById: owner.id } });
    await createChecklistAndDelegatableTasksFromPlan({ taskId: task.id, approvedAt, approvedById: owner.id });
    await db.subTask.updateMany({ where: { taskId: task.id }, data: { completedAt: approvedAt, completionEvidence: 'Original verified evidence', minutesSpent: 10 } });
    const before = await db.subTask.findMany({ where: { taskId: task.id }, orderBy: { rank: 'asc' } });
    const cycle = await db.$transaction(tx => openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 0 }));
    const actor = { id: worker.id, kind: 'agent' as const, username: worker.username, role: 'assignee' as const };
    const command = { taskId: task.id, intent: 'request_plan_revision' as const, actor, source: 'agent' as const, expectedWorkflowVersion: 0, workflowCycleId: cycle.id, idempotencyKey: 'revise-approved-plan', payload: { actionPlanId: plan.id, actionPlanVersion: 1, reviewerComment: 'Owner selected the revised approach; retain verified work and correct one requirement.' } };
    const denied = await submitWorkflowCommand({ ...command, actor: { ...actor, id: outsider.id, username: outsider.username } });
    assert.equal(denied.status, 'forbidden');
    await db.activityLog.create({ data: { taskId: task.id, projectId: project.id, kind: 'task.repository.checkpoint.requested', payload: JSON.stringify({ authorizationCommentId: 'legacy-inflight' }) } });
    const waitingForPublication = await submitWorkflowCommand(command);
    assert.equal(waitingForPublication.status, 'stale');
    assert.ok((await db.task.findUniqueOrThrow({ where: { id: task.id } })).approvedOn, 'A spooled single-use publication fences plan reopening');
    await db.activityLog.create({ data: { taskId: task.id, projectId: project.id, kind: 'pm.repo.checkpoint.fail', payload: JSON.stringify({ authorizationCommentId: 'legacy-inflight' }) } });
    const reopened = await submitWorkflowCommand(command);
    assert.equal(reopened.status, 'accepted', JSON.stringify(reopened));
    assert.equal((await submitWorkflowCommand(command)).status, 'replayed');
    const current = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(current.status, 'To Do'); assert.equal(current.approvedOn, null); assert.equal(current.activeWorkflowCycleId, null);
    assert.equal((await db.taskWorkflowCycle.findUniqueOrThrow({ where: { id: cycle.id } })).outcome, 'changes_requested');
    assert.equal((await db.actionPlan.findUniqueOrThrow({ where: { id: plan.id } })).status, 'revision_required');
    assert.deepEqual(await db.subTask.findMany({ where: { taskId: task.id }, orderBy: { rank: 'asc' } }), before, 'Reopening alone must not modify requirements/evidence');
    const { drainWorkflowOutbox } = await import('@/lib/tasks/workflow-outbox-drain');
    const { requestMissingActionPlan } = await import('@/lib/agents/watchdog/repairs');
    const { sendTaskWorkflowNotification } = await import('@/lib/agents/workflow/notifications/task');
    const revisionWake = await db.workflowOutbox.findFirstOrThrow({ where: { taskId: task.id, effectType: 'task_notification' } });
    assert.equal(revisionWake.workflowCycleId, cycle.id, 'Retain the closed cycle for audit');
    assert.deepEqual(JSON.parse(revisionWake.payload).expectedPlanRevision, { id: plan.id, version: 1 });
    await drainWorkflowOutbox();
    const planningRun = await db.pmChannelRun.findFirstOrThrow({ where: { taskId: task.id } });
    assert.equal(planningRun.agentSlug, 'worker', 'Closing the cycle must not discard the assignee revision handoff');
    const planningJob = await db.pmChannelJob.findUniqueOrThrow({ where: { runId: planningRun.id } });
    const planningPayload = JSON.parse(planningJob.payload);
    assert.equal(planningPayload.expectedWorkflowAction, 'submit_plan');
    assert.ok(planningPayload.taskRuntime.actions.includes('submit_plan'));
    assert.ok(!planningPayload.taskRuntime.actions.includes('start'));
    assert.ok(!planningPayload.taskRuntime.actions.includes('approve_plan'));
    await db.workflowOutbox.update({ where: { id: revisionWake.id }, data: { status: 'queued' } });
    await drainWorkflowOutbox();
    assert.equal(await db.pmChannelRun.count({ where: { taskId: task.id } }), 1, 'Delivery replay must not duplicate the turn');
    assert.equal((await requestMissingActionPlan({ taskId: task.id, now: new Date() })).outcome, 'noop', 'Active planning suppresses recovery');
    assert.equal(await sendTaskWorkflowNotification({ taskId: task.id, targetUserId: reviewer.id,
      actor: { id: owner.id, kind: 'human' }, reason: 'action_plan_review_requested', body: 'Stale review recovery' }), null,
      'A revision-required plan must not wake the reviewer');
    console.log('PASS revision handoff survives cycle closure, replay is deduplicated, assignee gets planning tools and stale reviewer wakes are suppressed');
    const submittedRevision = await submitWorkflowCommand({ taskId: task.id, intent: 'submit_plan', actor, source: 'agent',
      expectedWorkflowVersion: current.workflowVersion, workflowCycleId: null, idempotencyKey: 'submit-revised-plan',
      payload: { actionPlan: { summary: 'Revised implementation and explicit owner acceptance', steps: [original.steps[0],
        { ...original.steps[1], acceptanceCriteria: ['Verify the corrected behavior'] },
        { ...step('owner', 'Physical check'), phase: 'acceptance', responsibleActor: 'owner', verificationEnvironment: 'target device' }] } } });
    assert.equal(submittedRevision.status, 'accepted', JSON.stringify(submittedRevision));
    const revised = await db.actionPlan.findUniqueOrThrow({ where: { taskId: task.id } });
    assert.equal(revised.version, 2); assert.equal(revised.status, 'draft');
    await drainWorkflowOutbox();
    const reviewerTurn = await db.pmChannelRun.findFirstOrThrow({ where: { taskId: task.id, agentSlug: 'reviewer' } });
    const reviewJob = await db.pmChannelJob.findUniqueOrThrow({ where: { runId: reviewerTurn.id } });
    assert.equal(JSON.parse(reviewJob.payload).expectedWorkflowAction, 'review_plan', 'The submitted revision wakes its reviewer');

    const pending = await db.subTask.findMany({ where: { taskId: task.id } });
    assert.equal(pending.filter(row => row.kind === 'superseded').length, 0, 'Drafts cannot waive old requirements');
    const approval = await submitWorkflowCommand({ taskId: task.id, intent: 'approve_plan', actor: { id: owner.id, kind: 'human', username: owner.username }, source: 'browser', expectedWorkflowVersion: current.workflowVersion, workflowCycleId: null, idempotencyKey: 'approve-revised', payload: { actionPlanId: revised.id, actionPlanVersion: revised.version } });
    assert.equal(approval.status, 'accepted', JSON.stringify(approval));
    const rows = await db.subTask.findMany({ where: { taskId: task.id } });
    const kept = rows.find(row => row.id === before[0].id)!;
    assert.equal(kept.completedAt?.getTime(), approvedAt.getTime()); assert.equal(kept.completionEvidence, 'Original verified evidence');
    assert.equal(rows.filter(row => row.kind === 'superseded').length, 2);
    assert.ok(rows.filter(row => row.kind === 'superseded').every(row => row.supersededReason && row.completedAt));
    const changed = rows.find(row => row.planStepKey === 'change' && row.kind !== 'superseded')!;
    assert.equal(changed.completedAt, null);
    const physical = rows.find(row => row.planStepKey === 'owner')!;
    assert.equal(physical.kind, 'review'); assert.equal(physical.responsibleActor, 'owner'); assert.equal(physical.acceptanceGate, 'task');
    const afterApproval = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    const stale = await submitWorkflowCommand({ ...command, expectedWorkflowVersion: afterApproval.workflowVersion, workflowCycleId: null, idempotencyKey: 'stale-revision' });
    assert.equal(stale.status, 'stale');
    assert.ok(taskToolActions({ status: 'In Progress', approved: true, assignee: true, reviewer: false, canApprove: false, canFinish: false, unassigned: false, epicChild: false, coding: true }).includes('request_plan_revision'));
    // Recover an already-lost handoff once, with the same delivery fencing.
    const recoverTask = await db.task.create({ data: { projectId: project.id, title: 'Lost revision handoff',
      status: 'To Do', assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
    const recoverPlan = await db.actionPlan.create({ data: { taskId: recoverTask.id, summary: 'Pending revision', authorId: worker.id, status: 'revision_required' } });
    assert.equal((await requestMissingActionPlan({ taskId: recoverTask.id, now: new Date() })).outcome, 'repaired');
    assert.equal((await requestMissingActionPlan({ taskId: recoverTask.id, now: new Date() })).outcome, 'noop');
    const recoveryWake = await db.workflowOutbox.findFirstOrThrow({ where: { taskId: recoverTask.id } });
    assert.equal(await db.workflowOutbox.count({ where: { taskId: recoverTask.id } }), 1, 'One recovery per revision and assignee');
    // Scope must remain current even if it changes while the effect is queued.
    for (const changed of ['version', 'draft', 'assignee', 'approved', 'archived']) {
      await db.actionPlan.update({ where: { id: recoverPlan.id }, data: { version: changed === 'version' ? 2 : 1, status: changed === 'draft' ? 'draft' : 'revision_required' } });
      await db.task.update({ where: { id: recoverTask.id }, data: { assigneeId: changed === 'assignee' ? outsider.id : worker.id,
        approvedOn: changed === 'approved' ? new Date() : null, archivedAt: changed === 'archived' ? new Date() : null } });
      await db.workflowOutbox.update({ where: { id: recoveryWake.id }, data: { status: 'queued' } });
      await drainWorkflowOutbox();
      assert.equal(await db.pmChannelRun.count({ where: { taskId: recoverTask.id } }), 0, `${changed} fences stale recovery`);
    }
    await db.task.update({ where: { id: recoverTask.id }, data: { archivedAt: null } });
    await db.workflowOutbox.update({ where: { id: recoveryWake.id }, data: { status: 'queued' } });
    await drainWorkflowOutbox();
    assert.equal((await db.pmChannelRun.findFirstOrThrow({ where: { taskId: recoverTask.id } })).agentSlug, 'worker');
    assert.equal((await db.actionPlan.findUniqueOrThrow({ where: { id: recoverPlan.id } })).version, 1, 'Recovery cannot edit or approve the plan');
    console.log('PASS lost revision recovery is bounded, delivered to the assignee, and fenced by current plan, assignment, approval and archive state');
    const reassignedTask = await db.task.create({ data: { projectId: project.id, title: 'Reviewer access failure', status: 'Backlog', assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
    const browserStep = { id: 'browser', title: 'Browser acceptance', acceptanceCriteria: ['Verify rendered behavior'], kind: 'sequential' as const, phase: 'acceptance' as const, responsibleActor: 'reviewer' as const };
    await persistActionPlan({ taskId: reassignedTask.id, input: { summary: 'Reviewer verification', steps: [browserStep] }, authorId: worker.id });
    const reassign = (key: string, ownerInstructionCommentId?: string) => submitWorkflowCommand({ taskId: reassignedTask.id, intent: 'submit_plan', actor, source: 'agent', expectedWorkflowVersion: 0, workflowCycleId: null, idempotencyKey: key,
      payload: { actionPlan: { summary: 'Deferred browser verification', steps: [{ ...browserStep, responsibleActor: 'owner' }], ...(ownerInstructionCommentId ? { ownerInstructionCommentId } : {}) } } });
    assert.equal((await reassign('no-owner-instruction')).status, 'invalid');
    const agentInstruction = await db.comment.create({ data: { taskId: reassignedTask.id, userId: reviewer.id, body: 'Browser policy denied; assign this to the owner.' } });
    assert.equal((await reassign('agent-instruction', agentInstruction.id)).status, 'invalid');
    const wrongTaskInstruction = await db.comment.create({ data: { taskId: task.id, userId: owner.id, body: 'I will accept this check.' } });
    assert.equal((await reassign('wrong-task-instruction', wrongTaskInstruction.id)).status, 'invalid');
    assert.equal((await db.actionPlan.findUniqueOrThrow({ where: { taskId: reassignedTask.id } })).version, 1, 'Refused reassignment must not mutate the plan');
    const ownerInstruction = await db.comment.create({ data: { taskId: reassignedTask.id, userId: owner.id, body: 'Defer this browser check to my final acceptance.' } });
    assert.equal((await reassign('owner-instruction', ownerInstruction.id)).status, 'accepted');
    console.log('PASS agent-to-owner acceptance reassignment requires a live owner instruction on the same task');
    console.log('PASS active revision authorization, exact-version rejection, replay, cycle closure, immutable draft evidence, approved supersession and owner acceptance classification');
  } finally { await db.$disconnect(); await rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
