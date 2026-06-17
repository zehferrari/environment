import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { subscribeBoardTouch } from "@/lib/pm/board-events";
import { normalizeWorkspaceSlug } from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const { slug: rawSlug } = await ctx.params;
  let slug: string;
  try {
    slug = normalizeWorkspaceSlug(rawSlug);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const workspace = await db.workspace.findUnique({
    where: { slug },
    select: {
      id: true,
      projects: {
        where: { project: { deletedAt: null, archivedAt: null } },
        select: { projectId: true },
      },
    },
  });
  if (!workspace) return new Response("Not found", { status: 404 });

  const projectIds = workspace.projects.map((project) => project.projectId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      send("hello", { workspaceId: workspace.id, projectIds });

      const unsubs = projectIds.map((projectId) =>
        subscribeBoardTouch(projectId, (event) => send("board.touch", event)),
      );

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: hb\n\n`));
      }, HEARTBEAT_MS);

      const cleanup = () => {
        clearInterval(heartbeat);
        for (const unsub of unsubs) unsub();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
