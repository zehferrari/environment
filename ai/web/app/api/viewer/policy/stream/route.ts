import { db } from "@/lib/db";
import { getViewer, getViewerByUserId } from "@/lib/auth/permissions";
import { createViewerPolicyStream } from "@/lib/viewer-policy-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Always-on viewer-scoped policy channel (ENV-168). Every authenticated
// viewer — owner, admin, customer, on any route — holds one of these per
// tab; it is the propagation path for tabs that have no board stream (a
// customer parked on a task/epic detail page). The payload is the viewer's
// policyVersion epoch integer only: no role, scope, or project content ever
// crosses this channel. 401 at connect is a terminal authz close for
// EventSource — the browser fails the connection permanently instead of
// looping reconnects, and the client provider settles the tab into the safe
// denied state via router.refresh().
export async function GET(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Unauthorized", { status: 401 });

  const user = await db.user.findUnique({
    where: { id: viewer.id },
    select: { policyVersion: true },
  });
  if (!user) return new Response("Unauthorized", { status: 401 });

  const stream = createViewerPolicyStream({
    viewerId: viewer.id,
    initialEpoch: user.policyVersion,
    readEpoch: async () => {
      const row = await db.user.findUnique({
        where: { id: viewer.id },
        select: { policyVersion: true },
      });
      return row?.policyVersion ?? null;
    },
    resolveViewer: () => getViewerByUserId(viewer.id),
  });

  req.signal.addEventListener("abort", () => {
    void stream.cancel();
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
