import type { Prisma } from '@prisma/client';
import { createTaskWorkflowToken } from '@/lib/agents/workflow/token/task';
import { projectThinking, type ThinkingInput } from './projection';

// Called in the same transaction as the durable event, before stream compaction.
export async function captureTaskThinking(tx: Prisma.TransactionClient, runId: string, input: ThinkingInput, seq: number, finalReceived = false) {
  const run = await tx.pmChannelRun.findUnique({ where: { id: runId }, select: { taskId: true, agentSlug: true, messageId: true, kind: true } });
  if (!run?.taskId || !['task-chat', 'task-comment'].includes(run.kind)) return;
  const old = await tx.taskThinkingSnapshot.findUnique({ where: { runId } });
  if (old && seq <= old.lastSeq && !finalReceived) return;
  const secrets = process.env.AUTH_SECRET ? [createTaskWorkflowToken(run.messageId, run.taskId, run.agentSlug)] : [];
  let role = old?.role;
  if (!role) {
    const [task, agent] = await Promise.all([
      tx.task.findUnique({ where: { id: run.taskId }, select: { assigneeId: true } }),
      tx.agent.findUnique({ where: { slug: run.agentSlug }, select: { user: { select: { id: true } } } }),
    ]);
    role = agent?.user?.id === task?.assigneeId ? 'implementer' : 'reviewer / coordinator';
  }
  const data = { ...projectThinking(old ?? { progress: '', reasoning: '', tools: '[]', truncated: false }, input, seq, secrets), role,
    lastSeq: Math.max(old?.lastSeq ?? 0, seq), ...(finalReceived ? { finalReceivedAt: new Date() } : {}) };
  await tx.taskThinkingSnapshot.upsert({ where: { runId }, create: { runId, ...data }, update: data });
}
