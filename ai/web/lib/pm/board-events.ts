import { EventEmitter } from "node:events";

type BoardTouchEvent = { type: "board.touch"; at: number };

// In-process pub/sub for board "touch" events keyed by projectId.
// Single-node deployments only; we don't fan out across processes.
//
// The emitter is pinned to globalThis because Next's App Router bundles
// each route handler independently and inlines this module per-route. A
// plain module-level `new EventEmitter()` therefore yields a *separate*
// instance in every route bundle (the SSE stream route, the agent
// workflow route, the board/task server actions each got their own),
// so a publish from one bundle never reached the subscriber in another
// and the board never live-updated until a manual refresh. A single
// process-global instance makes every bundle share one emitter.
const globalForBoard = globalThis as unknown as {
  __pmBoardEmitter?: EventEmitter;
};

function getEmitter(): EventEmitter {
  if (!globalForBoard.__pmBoardEmitter) {
    const created = new EventEmitter();
    created.setMaxListeners(0);
    globalForBoard.__pmBoardEmitter = created;
  }
  return globalForBoard.__pmBoardEmitter;
}

function channel(projectId: string) {
  return `board:${projectId}`;
}

export function publishBoardTouch(projectId: string | null | undefined) {
  if (!projectId) return;
  getEmitter().emit(channel(projectId), { type: "board.touch", at: Date.now() } satisfies BoardTouchEvent);
}

export function subscribeBoardTouch(
  projectId: string,
  listener: (event: BoardTouchEvent) => void,
): () => void {
  const emitter = getEmitter();
  const key = channel(projectId);
  emitter.on(key, listener);
  return () => emitter.off(key, listener);
}
