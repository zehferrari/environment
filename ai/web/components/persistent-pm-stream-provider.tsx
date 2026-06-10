"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { StreamingReplyRunStatus } from "@/lib/agents/streaming-agent-reply-status";

type TargetKind = "direct" | "task-chat" | "task-comment" | "epic-chat";

export type PersistentPmStreamState = {
  text: string;
  reasoning: string;
  status: "pending" | "connecting" | "streaming" | "thinking" | "done" | "error";
  lifecycleStatus: "thinking" | "reading" | "working" | null;
  toolStatus: "call" | "result" | null;
  toolName: string | null;
  runStatus: StreamingReplyRunStatus;
  error: string | null;
  startedAt: number;
  lastUpdateAt: number | null;
  connectionIssueAt: number | null;
};

type StreamPayload = {
  text?: string;
  reasoning?: string;
  status?: "streaming" | "done" | "error";
  lifecycleStatus?: "thinking" | "reading" | "working" | null;
  toolStatus?: "call" | "result" | null;
  toolName?: string | null;
  runStatus?: StreamingReplyRunStatus;
  error?: string | null;
  updatedAt?: number;
};

type StreamKeyParts = {
  targetKind: TargetKind;
  agentSlug: string;
  messageId: string;
  taskId?: string;
  epicId?: string;
};

type SSEEvent = {
  event: string;
  data: string;
  id?: string;
};

type StreamRecord = {
  key: string;
  url: string;
  state: PersistentPmStreamState;
  listeners: Set<() => void>;
  controller: AbortController | null;
  lastEventId: string;
  reconnectAttempt: number;
  started: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

type PersistentPmStreamStore = {
  ensureStream: (parts: StreamKeyParts, initialStatus?: PersistentPmStreamState["status"]) => StreamRecord;
  subscribe: (key: string, listener: () => void) => () => void;
  getSnapshot: (key: string) => PersistentPmStreamState | null;
  release: (key: string) => void;
};

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_JITTER_MS = 100;
const TERMINAL_CLEANUP_MS = 60_000;

const stateEventTypes = new Set([
  "snapshot",
  "status",
  "status:thinking",
  "status:reading",
  "status:working",
  "tool:call",
  "tool:result",
  "token",
  "partial",
  "reasoning",
  "final",
  "done",
]);

const PersistentPmStreamContext = createContext<PersistentPmStreamStore | null>(null);

function randomJitter(): number {
  return Math.floor(Math.random() * RECONNECT_JITTER_MS * 2) - RECONNECT_JITTER_MS;
}

function nextBackoff(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt)) + randomJitter();
}

function streamKey(parts: StreamKeyParts) {
  return [parts.targetKind, parts.agentSlug, parts.messageId, parts.taskId ?? "", parts.epicId ?? ""].join(":");
}

function streamUrl(parts: StreamKeyParts) {
  const params = new URLSearchParams({
    kind: parts.targetKind,
    agentSlug: parts.agentSlug,
    messageId: parts.messageId,
  });
  if (parts.taskId) params.set("taskId", parts.taskId);
  if (parts.epicId) params.set("epicId", parts.epicId);
  return `/api/openclaw/pm-channel/events?${params.toString()}`;
}

function isTerminalStatus(status: PersistentPmStreamState["status"]) {
  return status === "done" || status === "error";
}

function initialStreamState(initialStatus: PersistentPmStreamState["status"] = "pending"): PersistentPmStreamState {
  return {
    text: "",
    reasoning: "",
    status: initialStatus,
    lifecycleStatus: null,
    toolStatus: null,
    toolName: null,
    runStatus: "queued",
    error: null,
    startedAt: Date.now(),
    lastUpdateAt: null,
    connectionIssueAt: null,
  };
}

function applyPayload(current: PersistentPmStreamState, payload: StreamPayload): PersistentPmStreamState {
  let status: PersistentPmStreamState["status"] = "streaming";
  if (payload.status === "done") status = "done";
  else if (payload.status === "error") status = "error";
  else if (payload.lifecycleStatus === "thinking") status = "thinking";

  return {
    ...current,
    text: typeof payload.text === "string" ? payload.text : current.text,
    reasoning: typeof payload.reasoning === "string" ? payload.reasoning : current.reasoning,
    status,
    lifecycleStatus: payload.lifecycleStatus ?? null,
    toolStatus: payload.toolStatus ?? null,
    toolName: payload.toolName ?? null,
    runStatus: payload.runStatus ?? current.runStatus,
    error: payload.error ?? null,
    lastUpdateAt: payload.updatedAt ?? Date.now(),
    connectionIssueAt: null,
  };
}

async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentData = "";
  let currentId = "";

  const processBuffer = () => {
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      if (line === "") {
        if (currentData !== "") onEvent({ event: currentEvent, data: currentData, id: currentId || undefined });
        currentEvent = "message";
        currentData = "";
        currentId = "";
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData += (currentData ? "\n" : "") + line.slice(5).trimStart();
      } else if (line.startsWith("id:")) {
        currentId = line.slice(3).trim();
      }
    }
  };

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      processBuffer();
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    processBuffer();
  }
}

function PersistentPmStreamProviderInner({ children }: { children: React.ReactNode }) {
  const recordsRef = useRef<Map<string, StreamRecord>>(new Map());

  const notify = useCallback((record: StreamRecord) => {
    record.listeners.forEach((listener) => listener());
  }, []);

  const updateRecord = useCallback((record: StreamRecord, updater: (state: PersistentPmStreamState) => PersistentPmStreamState) => {
    record.state = updater(record.state);
    notify(record);
  }, [notify]);

  const scheduleCleanup = useCallback((record: StreamRecord) => {
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    record.cleanupTimer = setTimeout(() => {
      if (record.listeners.size === 0 && (record.state.status === "done" || record.state.status === "error")) {
        recordsRef.current.delete(record.key);
      }
    }, TERMINAL_CLEANUP_MS);
  }, []);

  const startConnection = useCallback((record: StreamRecord) => {
    if (record.started) return;
    record.started = true;
    record.controller = new AbortController();

    const run = async () => {
      const controller = record.controller;
      if (!controller) return;
      const maxAttempts = 20;

      while (!controller.signal.aborted && !isTerminalStatus(record.state.status)) {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (record.lastEventId) headers["Last-Event-ID"] = record.lastEventId;

        try {
          const response = await fetch(record.url, { method: "GET", headers, signal: controller.signal });
          if (!response.ok) throw new Error(`SSE fetch failed: ${response.status}`);
          if (!response.body) throw new Error("SSE fetch: no response body");

          record.reconnectAttempt = 0;
          updateRecord(record, (state) => ({
            ...state,
            status: state.status === "pending" || state.status === "connecting" ? "streaming" : state.status,
            connectionIssueAt: null,
          }));

          await parseSSEStream(response.body.getReader(), (event) => {
            if (event.id) record.lastEventId = event.id;

            if (event.event === "heartbeat") {
              updateRecord(record, (state) => ({
                ...state,
                status: state.status === "connecting" ? "streaming" : state.status,
                lastUpdateAt: state.lastUpdateAt ?? Date.now(),
                connectionIssueAt: null,
              }));
              return;
            }

            if (event.event === "stream-error") {
              let payload: StreamPayload | null = null;
              try { payload = JSON.parse(event.data) as StreamPayload; } catch { /* ignore */ }
              updateRecord(record, (state) => ({
                ...state,
                status: "error",
                runStatus: "failed",
                error: payload?.error ?? "Agent stream failed",
                text: payload?.text ?? state.text,
                reasoning: payload?.reasoning ?? state.reasoning,
                lastUpdateAt: payload?.updatedAt ?? Date.now(),
                connectionIssueAt: null,
              }));
              controller.abort();
              scheduleCleanup(record);
              return;
            }

            if (!stateEventTypes.has(event.event)) return;
            let payload: StreamPayload | null = null;
            try { payload = JSON.parse(event.data) as StreamPayload; } catch { return; }
            updateRecord(record, (state) => applyPayload(state, payload ?? {}));
            if (payload?.status === "done" || payload?.status === "error") {
              controller.abort();
              scheduleCleanup(record);
            }
          }, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
          updateRecord(record, (state) => {
            if (state.status === "done" || state.status === "error") return state;
            return { ...state, status: "connecting", connectionIssueAt: state.connectionIssueAt ?? Date.now() };
          });
        }

        if (controller.signal.aborted || isTerminalStatus(record.state.status)) break;
        if (record.reconnectAttempt >= maxAttempts) break;
        const delay = nextBackoff(record.reconnectAttempt);
        record.reconnectAttempt += 1;
        updateRecord(record, (state) => ({
          ...state,
          status: "connecting",
          connectionIssueAt: state.connectionIssueAt ?? Date.now(),
        }));
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, delay);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      }
    };

    void run();
  }, [scheduleCleanup, updateRecord]);

  const store = useMemo<PersistentPmStreamStore>(() => ({
    ensureStream(parts, initialStatus = "pending") {
      const key = streamKey(parts);
      let record = recordsRef.current.get(key);
      if (!record) {
        record = {
          key,
          url: streamUrl(parts),
          state: initialStreamState(initialStatus),
          listeners: new Set(),
          controller: null,
          lastEventId: "",
          reconnectAttempt: 0,
          started: false,
          cleanupTimer: null,
        };
        recordsRef.current.set(key, record);
      } else if (record.cleanupTimer) {
        clearTimeout(record.cleanupTimer);
        record.cleanupTimer = null;
      }
      startConnection(record);
      return record;
    },
    subscribe(key, listener) {
      const record = recordsRef.current.get(key);
      if (!record) return () => undefined;
      record.listeners.add(listener);
      return () => {
        record.listeners.delete(listener);
        if (record.listeners.size === 0 && (record.state.status === "done" || record.state.status === "error")) {
          scheduleCleanup(record);
        }
      };
    },
    getSnapshot(key) {
      return recordsRef.current.get(key)?.state ?? null;
    },
    release(key) {
      const record = recordsRef.current.get(key);
      if (!record) return;
      if (record.listeners.size === 0 && (record.state.status === "done" || record.state.status === "error")) {
        scheduleCleanup(record);
      }
    },
  }), [scheduleCleanup, startConnection]);

  return <PersistentPmStreamContext.Provider value={store}>{children}</PersistentPmStreamContext.Provider>;
}

export function PersistentPmStreamProvider({ children }: { children: React.ReactNode }) {
  return <PersistentPmStreamProviderInner>{children}</PersistentPmStreamProviderInner>;
}

export function usePersistentPmStream(parts: StreamKeyParts, initialStatus: PersistentPmStreamState["status"] = "pending") {
  const store = useContext(PersistentPmStreamContext);
  if (!store) throw new Error("usePersistentPmStream must be used inside PersistentPmStreamProvider");

  const record = store.ensureStream(parts, initialStatus);
  const key = record.key;

  useEffect(() => () => store.release(key), [key, store]);

  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.getSnapshot(key) ?? record.state,
    () => record.state,
  );
}
