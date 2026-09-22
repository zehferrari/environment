import { getViewer } from '@/lib/auth/permissions';
import { taskThinkingResponse } from '@/lib/tasks/thinking/read';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return taskThinkingResponse(req, (await ctx.params).id, await getViewer());
}
