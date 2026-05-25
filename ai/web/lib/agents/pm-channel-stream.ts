import type { PmChannelReplyTarget } from "@/lib/agents/openclaw-pm-channel";

export type PmChannelStreamEventKind =
  | "partial"
  | "reasoning"
  | "final"
  | "done"
  | "error";

export interface PmChannelStreamInput {
  target: PmChannelReplyTarget;
  event: PmChannelStreamEventKind;
  text?: string;
  delta?: string;
  replace?: boolean;
  error?: string;
}

export interface PmChannelStreamState {
  key: string;
  target: PmChannelReplyTarget;
  text: string;
  reasoning: string;
  status: "streaming" | "done" | "error";
  error: string | null;
  updatedAt: number;
}

type Subscriber = (event: string, state: PmChannelStreamState) => void;

interface StreamStore {
  states: Map<string, PmChannelStreamState>;
  subscribers: Map<string, Set<Subscriber>>;
}

type GlobalWithStreamStore = typeof globalThis & {
  __vixiPmChannelStreamStore?: StreamStore;
};

const MAX_STREAM_CHARS = 40_000;
const STREAM_TTL_MS = 10 * 60 * 1000;

function store(): StreamStore {
  const globalStore = globalThis as GlobalWithStreamStore;
  globalStore.__vixiPmChannelStreamStore ??= {
    states: new Map(),
    subscribers: new Map(),
  };
  return globalStore.__vixiPmChannelStreamStore;
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

function emptyState(target: PmChannelReplyTarget): PmChannelStreamState {
  return {
    key: pmChannelStreamKey(target),
    target,
    text: "",
    reasoning: "",
    status: "streaming",
    error: null,
    updatedAt: Date.now(),
  };
}

function sweepExpired(now = Date.now()) {
  const s = store();
  for (const [key, state] of s.states) {
    if (state.status === "streaming") continue;
    if (now - state.updatedAt > STREAM_TTL_MS) s.states.delete(key);
  }
}

function notify(key: string, event: string, state: PmChannelStreamState) {
  const subscribers = store().subscribers.get(key);
  if (!subscribers) return;
  for (const subscriber of [...subscribers]) subscriber(event, state);
}

export function publishPmChannelStreamEvent(input: PmChannelStreamInput): PmChannelStreamState {
  sweepExpired();
  const s = store();
  const key = pmChannelStreamKey(input.target);
  const state = s.states.get(key) ?? emptyState(input.target);

  if (input.event === "partial" || input.event === "final") {
    if (input.replace) {
      state.text = clip(input.text ?? "");
    } else if (input.delta) {
      state.text = clip(state.text + input.delta);
    } else if (input.text) {
      state.text = clip(input.text);
    }
    state.status = input.event === "final" ? "done" : "streaming";
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
    state.error = null;
  } else {
    state.status = "error";
    state.error = input.error || input.text || "OpenClaw stream failed";
  }

  state.updatedAt = Date.now();
  s.states.set(key, state);
  notify(key, input.event === "error" ? "stream-error" : input.event, state);
  return state;
}

function ssePayload(event: string, state: PmChannelStreamState) {
  return `event: ${event}\ndata: ${JSON.stringify(state)}\n\n`;
}

export function createPmChannelEventStream(key: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
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

      const snapshot = s.states.get(key);
      if (snapshot) send("snapshot", snapshot);

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
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
