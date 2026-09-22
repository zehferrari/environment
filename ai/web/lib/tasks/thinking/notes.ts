import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { verifyTaskWorkflowToken } from '@/lib/agents/workflow/token/task';
import { hasAuthorizedTaskAgentOrigin } from '@/lib/agents/owner-origin';
import { resolveAgentTaskAccess } from '@/lib/agents/private-task-access';
import { resolveEpisodeRolloverBarrier } from '@/lib/agents/episodes/lifecycle';
import { resolveReviewOwnerId } from '@/lib/tasks/workflow-actors';
import { redactThinkingText } from './projection';

const kinds = new Set(['finding', 'decision', 'question']);
const failure = (error: string, status: number) => ({ status, body: { ok: false, error } });

// Communication only: no workflow transition, implicit approval or agent wake.
export async function publishTaskNote(taskId: string, payload: Record<string, unknown>) {
  const { messageId, token, category, body } = payload;
  if (typeof messageId !== 'string' || typeof token !== 'string' || typeof category !== 'string' || !kinds.has(category)
    || typeof body !== 'string' || !body.trim() || body.length > 2000) return failure('Provide messageId, token, category (finding/decision/question) and body (1–2000 characters).', 400);
  const original = await db.agentChatMessage.findUnique({ where: { id: messageId }, select: {
    taskId: true, agentSlug: true, targetType: true, targetValue: true, senderUserId: true, sender: { select: { kind: true, status: true } },
  } });
  if (!original || original.taskId !== taskId) return failure('Task grant message not found', 404);
  const slug = original.agentSlug === 'room' && original.targetType === 'agent' && original.targetValue?.startsWith('agent:') ? original.targetValue.slice(6) : original.agentSlug;
  if (!verifyTaskWorkflowToken(messageId, taskId, slug, token)
    || !await hasAuthorizedTaskAgentOrigin({ taskId, messageId, targetAgentSlug: slug, senderUserId: original.senderUserId, sender: original.sender })) return failure('Invalid or revoked task grant', 403);
  const [agent, task, run] = await Promise.all([
    db.agent.findUnique({ where: { slug }, select: { deactivatedAt: true, user: { select: { id: true, status: true } } } }),
    db.task.findFirst({ where: { id: taskId, archivedAt: null, deletedAt: null }, select: { assigneeId: true, actingManagerId: true, reporterId: true, projectId: true, epic: { select: { actingManagerId: true, status: true } } } }),
    db.pmChannelRun.findFirst({ where: { taskId, messageId, agentSlug: slug }, orderBy: { createdAt: 'desc' } }),
  ]);
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== 'active') return failure('Agent is inactive', 403);
  if (!task || !(await resolveAgentTaskAccess({ taskId, agentUserId: agent.user.id })).allowed) return failure('Task not found', 404);
  if (![task.assigneeId, resolveReviewOwnerId(task)].includes(agent.user.id)) return failure('Only the task assignee or reviewer may publish a task note', 403);
  if (!run) return failure('No matching run', 409);
  const text = redactThinkingText(body.trim(), [token]);
  const id = 'note_' + createHash('sha256').update(JSON.stringify([run.id, category, text])).digest('hex');
  const barrier = await resolveEpisodeRolloverBarrier({ taskId, agentSlug: slug, messageId });
  const result = await db.$transaction(async tx => {
    if (await tx.comment.findUnique({ where: { id }, select: { id: true } })) return { status: 200, body: { ok: true, id, duplicate: true } };
    const live = await tx.pmChannelRun.findUnique({ where: { id: run.id }, select: { status: true, settledByAction: true } });
    if (barrier || !live || live.settledByAction || !['admitted', 'streaming', 'accepted'].includes(live.status)) return failure('This turn is closed or awaiting its checkpoint', 409);
    if (await tx.comment.count({ where: { runId: run.id, commentKind: { startsWith: 'agent_note_' } } }) >= 10) return failure('Consolidate findings; this turn has reached its task-note limit', 429);
    await tx.comment.create({ data: { id, taskId, userId: agent.user!.id, body: text, authorAgentSlug: slug, runId: run.id, provider: run.provider, model: run.model, commentKind: `agent_note_${category}` } });
    await tx.activityLog.create({ data: { taskId, projectId: task.projectId, userId: agent.user!.id, targetAgent: slug, kind: 'task.comment', payload: JSON.stringify({ commentId: id, category, source: 'explicit_task_note', runId: run.id }) } });
    return { status: 201, body: { ok: true, id, duplicate: false } };
  });
  return result;
}
