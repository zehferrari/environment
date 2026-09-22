import { NextResponse, type NextRequest } from 'next/server';
import { publishTaskNote } from '@/lib/tasks/thinking/notes';
import { revalidateTaskReplyScope } from '@/lib/tasks/cache';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest, ctx: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await ctx.params;
  let payload: unknown;
  try { payload = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  const result = await publishTaskNote(taskId, payload as Record<string, unknown>);
  if (result.status === 201) revalidateTaskReplyScope(taskId, 'comment');
  return NextResponse.json(result.body, { status: result.status });
}
