import { db } from "@/lib/db";
import { subscribeBoardTouch } from "@/lib/pm/board-events";
import {
  accessibleProjectWhere,
  requireViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

// Aggregate stream for the /workspaces landing board: one connection that
// fans a board.touch in from every project the viewer can reach through an
// accessible active workspace. The access set is resolved at subscribe time,
// same contract as the per-workspace stream.
export async function GET(req: Request) {
  let viewer;
  try { viewer = await requireViewer(); } catch { return new Response("Unauthorized", { status: 401 }); }

  const workspaces = await db.workspace.findMany({
    where: { AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)] },
    select: {
      id: true,
      projects: {
        where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
        select: { projectId: true },
      },
    },
  });

  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const projectIds = [...new Set(
    workspaces.flatMap((workspace) => workspace.projects.map((project) => project.projectId)),
  )];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      send("hello", { workspaceIds, projectIds });

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
