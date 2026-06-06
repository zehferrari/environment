import { EventEmitter } from "node:events";

type BoardTouchEvent = { type: "board.touch"; at: number };

// In-process pub/sub for board "touch" events keyed by projectId.
// Single-node deployments only; we don't fan out across processes.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function channel(projectId: string) {
  return `board:${projectId}`;
}

export function publishBoardTouch(projectId: string | null | undefined) {
  if (!projectId) return;
  emitter.emit(channel(projectId), { type: "board.touch", at: Date.now() } satisfies BoardTouchEvent);
}

export function subscribeBoardTouch(
  projectId: string,
  listener: (event: BoardTouchEvent) => void,
): () => void {
  const key = channel(projectId);
  emitter.on(key, listener);
  return () => emitter.off(key, listener);
}
