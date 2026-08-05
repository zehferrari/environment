import type { PmChannelReplyTarget } from "@/lib/agents/pm-channel/openclaw";

export type PmChannelStreamEventKind =
  | "status"
  | "status:thinking"
  | "status:reading"
  | "status:working"
  | "tool:call"
  | "tool:result"
  | "token"
  | "partial"
  | "reasoning"
  | "final"
  | "done"
  | "error";

export type PmChannelLifecycleStatus = "thinking" | "reading" | "working";

export type PmChannelToolStatus = "call" | "result";

export interface PmChannelStreamInput {
  target: PmChannelReplyTarget;
  event: PmChannelStreamEventKind;
  text?: string;
  delta?: string;
  replace?: boolean;
  error?: string;
  statusKind?: PmChannelLifecycleStatus;
  toolStatus?: PmChannelToolStatus;
  toolName?: string;
  seq?: number;
  runStatus?: PmChannelStreamState["runStatus"];
}

export interface PmChannelStreamState {
  key: string;
  target: PmChannelReplyTarget;
  text: string;
  reasoning: string;
  status: "streaming" | "done" | "error";
  lifecycleStatus: PmChannelLifecycleStatus | null;
  toolStatus: PmChannelToolStatus | null;
  toolName: string | null;
  runStatus?: "queued" | "accepted" | "streaming" | "completed" | "failed" | "timed_out" | "cancelled" | "superseded";
  error: string | null;
  seq?: number;
  updatedAt: number;
}

type Subscriber = (event: string, state: PmChannelStreamState) => void;

interface StreamStore {
  states: Map<string, PmChannelStreamState>;
  subscribers: Map<string, Set<Subscriber>>;
}

type GlobalWithStreamStore = typeof globalThis & {
  __missionControlPmChannelStreamStore?: StreamStore;
};

const MAX_STREAM_CHARS = 40_000;
const STREAM_TTL_MS = 10 * 60 * 1000;

function store(): StreamStore {
  const globalStore = globalThis as GlobalWithStreamStore;
  globalStore.__missionControlPmChannelStreamStore ??= {
    states: new Map(),
    subscribers: new Map(),
  };
  return globalStore.__missionControlPmChannelStreamStore;
}

function clip(value: string) {
  if (value.length <= MAX_STREAM_CHARS) return value;
  return value.slice(value.length - MAX_STREAM_CHARS);
}

export function pmChannelStreamKey(target: PmChannelReplyTarget): string {
  if (target.kind === "direct") {
    return `direct:${target.agentSlug}:${target.messageId}`;
  }
  if (target.kind === "epic-chat") {
    return `epic-chat:${target.agentSlug}:${target.epicId}:${target.messageId}`;
  }
  return `${target.kind}:${target.agentSlug}:${target.taskId}:${target.messageId}`;
}

export function emptyPmChannelStreamState(target: PmChannelReplyTarget): PmChannelStreamState {
  return {
    key: pmChannelStreamKey(target),
    target,
    text: "",
    reasoning: "",
    status: "streaming",
    lifecycleStatus: null,
    toolStatus: null,
    toolName: null,
    runStatus: "streaming",
    error: null,
    updatedAt: Date.now(),
  };
}

const INACTIVE_STREAMING_TIMEOUT_MS = 10 * 60 * 1000;

function sweepExpired(now = Date.now()) {
  const s = store();
  for (const [key, state] of s.states) {
    if (state.status === "streaming") {
      if (now - state.updatedAt > INACTIVE_STREAMING_TIMEOUT_MS) {
        state.status = "error";
        state.error = "Agent response timed out (no activity for 10 minutes)";
        state.updatedAt = now;
        s.states.set(key, state);
        notify(key, "stream-error", state);
      }
    } else {
      if (now - state.updatedAt > STREAM_TTL_MS) {
        s.states.delete(key);
      }
    }
  }
}

function notify(key: string, event: string, state: PmChannelStreamState) {
  const subscribers = store().subscribers.get(key);
  if (!subscribers) return;
  for (const subscriber of [...subscribers]) subscriber(event, state);
}

function eventName(input: PmChannelStreamInput) {
  return input.event === "error" ? "stream-error" : input.event;
}

function statusFromEvent(input: PmChannelStreamInput): PmChannelLifecycleStatus | null {
  if (input.event === "status:thinking") return "thinking";
  if (input.event === "status:reading") return "reading";
  if (input.event === "status:working") return "working";
  return input.statusKind ?? null;
}

function toolStatusFromEvent(input: PmChannelStreamInput): PmChannelToolStatus | null {
  if (input.event === "tool:call") return "call";
  if (input.event === "tool:result") return "result";
  return input.toolStatus ?? null;
}

export function publishPmChannelStreamEvent(input: PmChannelStreamInput): PmChannelStreamState {
  sweepExpired();
  const s = store();
  const key = pmChannelStreamKey(input.target);
  const state = applyPmChannelStreamInput(s.states.get(key) ?? emptyPmChannelStreamState(input.target), input);

  s.states.set(key, state);
  notify(key, eventName(input), state);
  return state;
}

export function acknowledgePmChannelStreamSeq(
  target: PmChannelReplyTarget,
  seq: number,
): PmChannelStreamState | null {
  const s = store();
  const key = pmChannelStreamKey(target);
  const state = s.states.get(key);
  if (!state) return null;
  if (state.seq == null || seq > state.seq) {
    state.seq = seq;
    state.updatedAt = Date.now();
    s.states.set(key, state);
  }
  return state;
}

export function applyPmChannelStreamInput(
  baseState: PmChannelStreamState,
  input: PmChannelStreamInput,
): PmChannelStreamState {
  const state: PmChannelStreamState = {
    ...baseState,
    target: input.target,
    key: pmChannelStreamKey(input.target),
  };
  if (input.seq != null) state.seq = input.seq;

  const lifecycleStatus = statusFromEvent(input);
  const toolStatus = toolStatusFromEvent(input);

  if (input.event === "status" || lifecycleStatus) {
    state.lifecycleStatus = lifecycleStatus ?? state.lifecycleStatus;
    state.toolStatus = null;
    state.toolName = null;
    if (input.runStatus) {
      state.runStatus = input.runStatus;
      state.status = input.runStatus === "failed" || input.runStatus === "timed_out" || input.runStatus === "superseded"
        ? "error"
        : input.runStatus === "completed" || input.runStatus === "cancelled"
          ? "done"
          : "streaming";
    }
    if (input.error) state.error = input.error;
  } else if (toolStatus) {
    state.toolStatus = toolStatus;
    state.toolName = input.toolName ?? input.text ?? null;
    state.lifecycleStatus = "working";
    state.status = "streaming";
    state.runStatus = "streaming";
    state.error = null;
  } else if (input.event === "partial" || input.event === "token" || input.event === "final") {
    if (input.replace) {
      state.text = clip(input.text ?? "");
    } else if (input.delta) {
      state.text = clip(state.text + input.delta);
    } else if (input.text) {
      state.text = clip(input.text);
    }
    state.status = input.event === "final" ? "done" : "streaming";
    state.runStatus = input.event === "final" ? "completed" : "streaming";
    state.error = null;
  } else if (input.event === "reasoning") {
    if (input.replace) {
      state.reasoning = clip(input.text ?? "");
    } else if (input.delta) {
      state.reasoning = clip(state.reasoning + input.delta);
    } else if (input.text) {
      state.reasoning = clip(input.text);
    }
  } else if (input.event === "done") {
    state.status = "done";
    state.runStatus = "completed";
    state.error = null;
  } else {
    state.status = "error";
    state.runStatus = "failed";
    state.error = input.error || input.text || "OpenClaw stream failed";
  }

  state.updatedAt = Date.now();
  return state;
}

function ssePayload(event: string, state: PmChannelStreamState) {
  const id = state.seq == null ? "" : `id: ${state.seq}\n`;
  return `${id}event: ${event}\ndata: ${JSON.stringify(state)}\n\n`;
}

export interface PmChannelReplayFrame {
  event: string;
  state: PmChannelStreamState;
}

export function createPmChannelEventStream(
  key: string,
  initialState?: PmChannelStreamState | null,
  replayFrames: PmChannelReplayFrame[] = [],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      sweepExpired();
      const s = store();
      const send = (event: string, state: PmChannelStreamState) => {
        try {
          controller.enqueue(encoder.encode(ssePayload(event, state)));
        } catch {
          // The browser disconnected between notification and enqueue.
        }
      };

      let subscribers = s.subscribers.get(key);
      if (!subscribers) {
        subscribers = new Set();
        s.subscribers.set(key, subscribers);
      }
      subscribers.add(send);

      // Read the in-memory head once, synchronously, after registering the
      // subscriber (so no live event can be missed between the two).
      const memState = s.states.get(key);
      if (replayFrames.length > 0) {
        for (const frame of replayFrames) send(frame.event, frame.state);
        // Reconcile replay against the in-memory head. Events are published to
        // memory BEFORE the async DB persist, and the caller reads replay frames
        // from the DB before this subscriber is registered — so a terminal
        // (final/done/error) published in that window is absent from replay and
        // was never delivered live. Without this the client replays up to the
        // last persisted partial and hangs until the 10-minute sweep. If the
        // in-memory head is terminal, deliver it now (idempotent for the client).
        if (memState && (memState.status === "done" || memState.status === "error")) {
          send(memState.status === "error" ? "stream-error" : "snapshot", memState);
        }
      } else {
        const snapshot = memState ?? initialState;
        if (snapshot) send("snapshot", snapshot);
      }

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15_000);

      cleanup = () => {
        clearInterval(keepAlive);
        subscribers?.delete(send);
        if (subscribers?.size === 0) s.subscribers.delete(key);
      };
    },
    cancel() {
      cleanup();
    },
  });
}
