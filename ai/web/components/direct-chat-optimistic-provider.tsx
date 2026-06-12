"use client";

// Bridges the two direct-chat islands (ChatInput composer and
// ChatMessagesContainer list) so the user's own message can echo instantly
// on submit and offer a Resend if the send itself fails. This mirrors the
// optimistic behavior the decomposed task/epic room already has; direct chat
// splits composer and list across server-component boundaries, so they share
// state through this client context instead of one parent component.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { sendDirectAgentMessage } from "@/lib/agents/direct-chat-actions";

export interface OptimisticDirectMessage {
  clientId: string;
  body: string;
  createdAt: string;
  status: "sending" | "failed";
}

interface DirectChatOptimisticValue {
  optimistic: OptimisticDirectMessage[];
  addOptimistic: (clientId: string, body: string) => void;
  markFailed: (clientId: string) => void;
  removeOptimistic: (clientId: string) => void;
  // Drop optimistic echoes the server has now persisted (matched by message id,
  // since the client supplies the id used for both the echo and the server row).
  reconcileAgainst: (serverMessageIds: string[]) => void;
  resend: (clientId: string) => void;
}

const noop = () => undefined;

const DirectChatOptimisticContext = createContext<DirectChatOptimisticValue>({
  optimistic: [],
  addOptimistic: noop,
  markFailed: noop,
  removeOptimistic: noop,
  reconcileAgainst: noop,
  resend: noop,
});

// Optimistic echoes that never reconcile are swept after this long so a body
// mismatch (e.g. server-appended attachment names) can't leave a permanent
// ghost bubble.
const OPTIMISTIC_TTL_MS = 60_000;

export function useDirectChatOptimistic() {
  return useContext(DirectChatOptimisticContext);
}

export default function DirectChatOptimisticProvider({
  agentSlug,
  baseArchiveId = null,
  children,
}: {
  agentSlug: string;
  baseArchiveId?: string | null;
  children: React.ReactNode;
}) {
  const [optimistic, setOptimistic] = useState<OptimisticDirectMessage[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const removeOptimistic = useCallback((clientId: string) => {
    setOptimistic((prev) => prev.filter((m) => m.clientId !== clientId));
    const timer = timers.current.get(clientId);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(clientId);
    }
  }, []);

  const addOptimistic = useCallback((clientId: string, body: string) => {
    setOptimistic((prev) => [
      ...prev.filter((m) => m.clientId !== clientId),
      { clientId, body, createdAt: new Date().toISOString(), status: "sending" },
    ]);
    const timer = setTimeout(() => removeOptimistic(clientId), OPTIMISTIC_TTL_MS);
    timers.current.set(clientId, timer);
  }, [removeOptimistic]);

  const markFailed = useCallback((clientId: string) => {
    setOptimistic((prev) =>
      prev.map((m) => (m.clientId === clientId ? { ...m, status: "failed" } : m)),
    );
    // A failed send should not be auto-swept — the user decides to resend or
    // dismiss — so cancel the TTL timer.
    const timer = timers.current.get(clientId);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(clientId);
    }
  }, []);

  const reconcileAgainst = useCallback((serverMessageIds: string[]) => {
    const idSet = new Set(serverMessageIds);
    setOptimistic((prev) =>
      prev.filter((m) => {
        if (m.status === "failed") return true; // keep failed bubbles until resolved
        const settled = idSet.has(m.clientId);
        if (settled) {
          const timer = timers.current.get(m.clientId);
          if (timer) {
            clearTimeout(timer);
            timers.current.delete(m.clientId);
          }
        }
        return !settled;
      }),
    );
  }, []);

  const resend = useCallback((clientId: string) => {
    const target = optimistic.find((m) => m.clientId === clientId);
    if (!target) return;
    setOptimistic((prev) =>
      prev.map((m) => (m.clientId === clientId ? { ...m, status: "sending" } : m)),
    );
    const timer = setTimeout(() => removeOptimistic(clientId), OPTIMISTIC_TTL_MS);
    timers.current.set(clientId, timer);
    const formData = new FormData();
    formData.set("agentSlug", agentSlug);
    formData.set("body", target.body);
    formData.set("clientMessageId", clientId); // reconcile by id + idempotent resend
    if (baseArchiveId) formData.set("baseArchiveId", baseArchiveId);
    void sendDirectAgentMessage(formData).catch(() => markFailed(clientId));
  }, [agentSlug, baseArchiveId, markFailed, optimistic, removeOptimistic]);

  const value = useMemo(
    () => ({ optimistic, addOptimistic, markFailed, removeOptimistic, reconcileAgainst, resend }),
    [optimistic, addOptimistic, markFailed, removeOptimistic, reconcileAgainst, resend],
  );

  return (
    <DirectChatOptimisticContext.Provider value={value}>
      {children}
    </DirectChatOptimisticContext.Provider>
  );
}
