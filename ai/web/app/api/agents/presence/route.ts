import { db } from "@/lib/db";
import { readAtlasSnapshot } from "@/lib/atlas-snapshot";
import { requireViewer } from "@/lib/auth/permissions";
import { agentStatusFor, type AgentPresenceStatus } from "@/lib/agents/presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-side poll of the Atlas snapshot; the upstream busy probe runs every
// ~3s, so 4s here keeps flips near-live without hammering the DB.
const POLL_MS = 4_000;
const HEARTBEAT_MS = 25_000;

type PresenceMap = Record<string, AgentPresenceStatus>;

async function readPresenceMap(): Promise<PresenceMap> {
  const [agents, snapshot] = await Promise.all([
    db.agent.findMany({
      select: {
        slug: true,
        deactivatedAt: true,
        user: { select: { status: true } },
      },
    }),
    readAtlasSnapshot(),
  ]);
  const live = snapshot?.agents ?? {};
  const map: PresenceMap = {};
  for (const agent of agents) {
    map[agent.slug] = agentStatusFor(agent, live[agent.slug]);
  }
  return map;
}

function samePresence(a: PresenceMap, b: PresenceMap): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

// One shared poller drives every open SSE connection: a single 4s DB+snapshot
// read fans out to all subscribers instead of each connection polling on its
// own. Refcounted — the interval starts with the first subscriber and stops
// with the last, so an idle server does no work.
type Subscriber = (map: PresenceMap) => void;
const subscribers = new Set<Subscriber>();
let sharedTimer: ReturnType<typeof setInterval> | null = null;
let lastMap: PresenceMap = {};
let polling = false;

function ensurePoller() {
  if (sharedTimer) return;
  sharedTimer = setInterval(() => {
    if (polling || subscribers.size === 0) return;
    polling = true;
    readPresenceMap()
      .then((next) => {
        if (samePresence(lastMap, next)) return;
        lastMap = next;
        for (const notify of subscribers) notify(next);
      })
      .catch(() => {
        // snapshot/DB hiccup — keep the last map, retry next tick
      })
      .finally(() => {
        polling = false;
      });
  }, POLL_MS);
}

function subscribe(fn: Subscriber) {
  subscribers.add(fn);
  ensurePoller();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && sharedTimer) {
      clearInterval(sharedTimer);
      sharedTimer = null;
    }
  };
}

export async function GET(req: Request) {
  let viewer;
  try { viewer = await requireViewer(); } catch { return new Response("Unauthorized", { status: 401 }); }
  // Live busy state is owner-only everywhere else in the app (sidebar, boards,
  // task lists all gate on viewer.canAccessOwnerFeatures) — keep the stream to the same
  // audience so presence never widens what a non-owner can see.
  if (!viewer.canAccessOwnerFeatures) return new Response("Forbidden", { status: 403 });

  const initial = await readPresenceMap();
  lastMap = initial;

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      send({ type: "presence", agents: initial });

      const unsubscribe = subscribe((map) => send({ type: "presence", agents: map }));

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          // controller already closed
        }
      }, HEARTBEAT_MS);

      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        req.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Two teardown paths: fetch abort (client navigates away) and stream
      // cancel (consumer releases the reader). Wiring only one leaked the
      // subscription + heartbeat on the other.
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
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
