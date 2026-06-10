"use client";

import { useCallback, useRef } from "react";

/**
 * Reconnectable SSE client for the PM channel events stream.
 *
 * Uses fetch + ReadableStream parsing instead of native EventSource so we can:
 * - Send Last-Event-ID on reconnect to resume from the last received seq
 * - Control backoff/jitter precisely
 * - Avoid the browser's built-in reconnect (which has no backoff control)
 */

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_JITTER_MS = 100;

interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

function randomJitter(): number {
  return Math.floor(Math.random() * RECONNECT_JITTER_MS * 2) - RECONNECT_JITTER_MS;
}

function nextBackoff(attempt: number): number {
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
  return delay + randomJitter();
}

function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentData = "";
  let currentId = "";

  return new Promise<void>((resolve, reject) => {
    signal.addEventListener("abort", () => resolve(), { once: true });

    function processBuffer() {
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        if (line === "") {
          // Empty line = dispatch event
          if (currentData !== "") {
            onEvent({
              event: currentEvent,
              data: currentData,
              id: currentId || undefined,
            });
          }
          currentEvent = "message";
          currentData = "";
          currentId = "";
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData += (currentData ? "\n" : "") + line.slice(5).trimStart();
        } else if (line.startsWith("id:")) {
          currentId = line.slice(3).trim();
        } else if (line.startsWith(":")) {
          // comment, ignore
        }
      }
    }

    function read(): void {
      if (signal.aborted) { resolve(); return; }
      reader.read().then(({ done, value }) => {
        if (done) {
          processBuffer();
          resolve();
          return;
        }
        if (signal.aborted) { resolve(); return; }
        buffer += decoder.decode(value, { stream: true });
        processBuffer();
        read();
      }).catch((err) => {
        if (signal.aborted) { resolve(); return; }
        reject(err);
      });
    }

    read();
  });
}

export interface UseReconnectableSSEOptions {
  /** SSE endpoint URL (without Last-Event-ID param; we set the header) */
  url: string;
  /** Called for each parsed SSE event */
  onEvent: (event: SSEEvent) => void;
  /** Called when connection is established/re-established (including after replay) */
  onConnected?: () => void;
  /** Called on terminal close (component unmount) */
  onDone?: () => void;
  /** Called when a non-terminal error occurs before reconnect attempt */
  onError?: (attempt: number) => void;
  /** Called when reconnect attempt is about to start */
  onReconnect?: (attempt: number, delayMs: number) => void;
  /** Whether to attempt reconnect on error (default: true for non-terminal states) */
  shouldReconnect?: () => boolean;
  /** Maximum reconnect attempts before giving up (default: 20) */
  maxReconnectAttempts?: number;
}

export function useReconnectableSSE() {
  const abortRef = useRef<AbortController | null>(null);
  const lastEventIdRef = useRef<string>("");
  const reconnectAttemptRef = useRef(0);

  const connect = useCallback(async (options: UseReconnectableSSEOptions) => {
    // Abort any existing connection
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    reconnectAttemptRef.current = 0;

    const maxAttempts = options.maxReconnectAttempts ?? 20;

    while (!controller.signal.aborted) {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
      };
      if (lastEventIdRef.current) {
        headers["Last-Event-ID"] = lastEventIdRef.current;
      }

      try {
        const response = await fetch(options.url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`SSE fetch failed: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("SSE fetch: no response body");
        }

        // Connection established
        reconnectAttemptRef.current = 0;
        options.onConnected?.();

        const reader = response.body.getReader();
        await parseSSEStream(reader, (event) => {
          // Track last event id for reconnect
          if (event.id) {
            lastEventIdRef.current = event.id;
          }
          options.onEvent(event);
        }, controller.signal);

        // Stream ended without abort — check if we should reconnect
        if (controller.signal.aborted) break;

        // Stream ended naturally (server closed) — check shouldReconnect
        if (options.shouldReconnect && !options.shouldReconnect()) {
          break;
        }

        // Reconnect on stream close if allowed
        const attempt = reconnectAttemptRef.current;
        if (attempt >= maxAttempts) break;

        const delay = nextBackoff(attempt);
        options.onReconnect?.(attempt, delay);
        reconnectAttemptRef.current = attempt + 1;

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, delay);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      } catch (err: unknown) {
        if (controller.signal.aborted) break;

        const attempt = reconnectAttemptRef.current;
        options.onError?.(attempt);

        if (options.shouldReconnect && !options.shouldReconnect()) break;
        if (attempt >= maxAttempts) break;

        const delay = nextBackoff(attempt);
        options.onReconnect?.(attempt, delay);
        reconnectAttemptRef.current = attempt + 1;

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, delay);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      }
    }

    options.onDone?.();
  }, []);

  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const setLastEventId = useCallback((id: string) => {
    lastEventIdRef.current = id;
  }, []);

  return { connect, disconnect, setLastEventId };
}