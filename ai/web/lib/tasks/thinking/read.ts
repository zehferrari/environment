import { canAccessTask, type Viewer } from '@/lib/auth/permissions';
import { db } from '@/lib/db';
import { createTaskWorkflowToken } from '@/lib/agents/workflow/token/task';
import { projectThinking, redactThinkingText, type ThinkingInput } from '@/lib/tasks/thinking/projection';
export async function taskThinkingResponse(req: Request, taskId: string, viewer: Viewer | null) {
  if (!viewer) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  // Match the existing PM live stream's owner-only visibility, including preview.
  if (!viewer.canAccessOwnerFeatures || !await canAccessTask(viewer, taskId)) return Response.json({ error: 'Not found' }, { status: 404 });
  const before = new URL(req.url).searchParams.get('before');
  if (before && !await db.pmChannelRun.findFirst({ where: { id: before, taskId }, select: { id: true } })) return Response.json({ error: 'Invalid cursor' }, { status: 400 });
  const rows = await db.pmChannelRun.findMany({ where: { taskId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 11,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}), select: {
      id: true, messageId: true, agentSlug: true, provider: true, model: true, status: true, createdAt: true, lastEventAt: true, lastAction: true, error: true,
      thinking: { select: { progress: true, reasoning: true, tools: true, role: true, truncated: true, updatedAt: true } },
    } });
  const agents = await db.agent.findMany({ where: { slug: { in: rows.map(r => r.agentSlug) } }, select: { slug: true, name: true } });
  const runs = await Promise.all(rows.slice(0, 10).map(async row => {
    const { messageId, ...publicRow } = row;
    let thinking = row.thinking;
    const secrets = process.env.AUTH_SECRET ? [createTaskWorkflowToken(messageId, taskId, row.agentSlug)] : [];
    // Existing runs may still have retained frames. Read them without creating
    // records or replaying any workflow. Previously compacted data stays absent.
    if (!thinking) {
      const events = await db.pmChannelStreamEvent.findMany({ where: { runId: row.id }, orderBy: { seq: 'desc' }, take: 200, select: { seq: true, payload: true, createdAt: true } });
      if (events.length) {
        let projection = { progress: '', reasoning: '', tools: '[]', truncated: events.length === 200 };
        for (const event of events.slice().reverse()) {
          try { projection = projectThinking(projection, JSON.parse(event.payload) as ThinkingInput, event.seq, secrets, event.createdAt); } catch { /* Ignore unreadable legacy frames. */ }
        }
        thinking = { ...projection, role: 'agent', updatedAt: events[0].createdAt };
      }
    }
    return { ...publicRow, agentName: agents.find(a => a.slug === row.agentSlug)?.name || row.agentSlug,
      error: row.error ? redactThinkingText(row.error, secrets) : null,
      thinking: thinking ? { ...thinking, progress: redactThinkingText(thinking.progress, secrets), reasoning: redactThinkingText(thinking.reasoning, secrets), tools: JSON.parse(thinking.tools) } : null,
    };
  }));
  return Response.json({ runs, nextCursor: rows.length > 10 ? runs.at(-1)!.id : null }, { headers: { 'Cache-Control': 'private, no-store' } });
}
