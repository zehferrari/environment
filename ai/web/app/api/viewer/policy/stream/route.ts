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

/**
 * Test seam, never supplied over HTTP: the runtime always invokes
 * GET(request, context). scripts/access-revocation-test.ts uses it to invoke
 * this handler in-process — constructing the real Response and aborting it —
 * without a request-scoped next-auth session, and with a fast heartbeat for
 * teardown assertions.
 */
type ViewerPolicyRouteDeps = {
  getViewer?: typeof getViewer;
  heartbeatMs?: number;
};

export async function GET(
  _req: Request,
  _ctx?: unknown,
  deps?: ViewerPolicyRouteDeps,
): Promise<Response> {
  const viewer = await (deps?.getViewer ?? getViewer)();
  if (!viewer) return new Response("Unauthorized", { status: 401 });

  const user = await db.user.findUnique({
    where: { id: viewer.id },
    select: { policyVersion: true },
  });
  if (!user) return new Response("Unauthorized", { status: 401 });

  const stream = createViewerPolicyStream({
    viewerId: viewer.id,
    initialEpoch: user.policyVersion,
    heartbeatMs: deps?.heartbeatMs,
    readEpoch: async () => {
      const row = await db.user.findUnique({
        where: { id: viewer.id },
        select: { policyVersion: true },
      });
      return row?.policyVersion ?? null;
    },
    resolveViewer: () => getViewerByUserId(viewer.id),
  });

  // No req.signal abort listener here (ENV-168 review fix): once the stream
  // is handed to Response the runtime's reader locks it, so cancelling it
  // from an abort listener rejects and surfaces an unhandled TypeError on
  // every client disconnect. Next's own body pipe (readable.pipeTo(writer,
  // { signal })) cancels the source on abort, which runs
  // createViewerPolicyStream's cancel() → closeStream() — heartbeat cleared,
  // hub subscription released. Covered by scripts/access-revocation-test.ts §7.

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
