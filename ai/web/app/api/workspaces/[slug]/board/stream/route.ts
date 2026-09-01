import { db } from "@/lib/db";
import { subscribeBoardTouch } from "@/lib/pm/board-events";
import { normalizeWorkspaceSlug } from "@/lib/workspaces/service";
import {
  accessibleProjectWhere,
  requireViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";
import { attachRevocationGuard } from "@/lib/users/access-revocation-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  let viewer;
  try { viewer = await requireViewer(); } catch { return new Response("Unauthorized", { status: 401 }); }

  const { slug: rawSlug } = await ctx.params;
  let slug: string;
  try {
    slug = normalizeWorkspaceSlug(rawSlug);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const workspace = await db.workspace.findFirst({
    where: { AND: [{ slug }, workspaceAccessWhere(viewer)] },
    select: {
      id: true,
      projects: {
        where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
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

      const unsubs = viewer.agentVisibility === "hidden"
        ? []
        : projectIds.map((projectId) =>
            subscribeBoardTouch(projectId, (event) => send("board.touch", event)),
          );

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: hb\n\n`));
      }, HEARTBEAT_MS);

      let revocationGuard: { stop: () => void } | null = null;
      const cleanup = () => {
        revocationGuard?.stop();
        clearInterval(heartbeat);
        for (const unsub of unsubs) unsub();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // ENV-168: re-evaluate this viewer's workspace access on every
      // access-change hub event plus a heartbeat fallback; a revoked
      // connection gets one explicit `access-revoked` event and a terminal
      // close instead of serving stale scope forever.
      revocationGuard = attachRevocationGuard({
        userId: viewer.id,
        send,
        close: cleanup,
        stillAuthorized: async (fresh) => {
          if (!fresh) return false;
          const reachable = await db.workspace.findFirst({
            where: { AND: [{ id: workspace.id }, workspaceAccessWhere(fresh)] },
            select: { id: true },
          });
          return Boolean(reachable);
        },
      });

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
