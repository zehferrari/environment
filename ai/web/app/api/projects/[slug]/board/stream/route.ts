import { db } from "@/lib/db";
import { subscribeBoardTouch } from "@/lib/pm/board-events";
import { accessibleProjectWhere, canAccessProject, requireViewer } from "@/lib/auth/permissions";
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

  const { slug } = await ctx.params;
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug, deletedAt: null }),
    select: { id: true },
  });
  if (!project) return new Response("Not found", { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      send("hello", { projectId: project.id });

      // A board touch carries the mutation time but not its author. Without
      // provenance the stream cannot prove that a touch is Customer-visible,
      // so hidden mode must not subscribe: otherwise internal agent workflow
      // activity is inferable from event timing even though the refreshed row
      // is filtered. Customers still receive policy revocation and heartbeats.
      const unsub = viewer.agentVisibility === "hidden"
        ? () => {}
        : subscribeBoardTouch(project.id, (event) => send("board.touch", event));

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: hb\n\n`));
      }, HEARTBEAT_MS);

      let revocationGuard: { stop: () => void } | null = null;
      const cleanup = () => {
        revocationGuard?.stop();
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // ENV-168: streams authenticated once at connect would otherwise keep
      // serving under the old policy forever. The guard re-evaluates this
      // viewer's access on every access-change hub event and on a heartbeat
      // fallback; a failed check emits one explicit `access-revoked` event
      // and closes the stream terminally (the client stops reconnecting
      // and refreshes into the safe denied state).
      revocationGuard = attachRevocationGuard({
        userId: viewer.id,
        send,
        close: cleanup,
        stillAuthorized: (fresh) =>
          fresh ? canAccessProject(fresh, { id: project.id }) : Promise.resolve(false),
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
