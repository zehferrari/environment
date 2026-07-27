"use client";

import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { archiveChatRoom, getAgentChatRoomMessages, sendAgentChatMessage, deleteChatMessage, restoreChatMessage, prebuildAgentChatContext } from "@/lib/agents/chat/actions";
import ChatBubble from "@/components/chat-bubble";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import { ChatStreamManager } from "@/lib/agents/chat/chat-stream-manager";
import MaximizableTextarea from "@/components/maximizable-textarea";
import NativePmNotificationToggle from "@/components/native-pm-notification-toggle";
import { useActiveTab } from "@/components/task-tabs";
import {
  actorDisplayName,
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";
import ProposalReview from "@/app/(app)/agents/[agent]/chat/proposal-review";
import ConfirmedDeleteButton from "@/components/confirmed-delete-button";
import DeletedMessageDivider from "@/components/deleted-message-divider";
import { findPmOptionResolution, parsePmOptions } from "@/lib/pm-options";
import { generateClientMessageId } from "@/lib/agents/ops/client-message-id";
import { getMessageGroupState, messageParticipantKey } from "@/lib/agents/chat/message-grouping";
import DiscussionRecipientPicker, {
  type DiscussionTarget,
} from "@/components/discussion-recipient-picker";

interface Message {
  id: string;
  body: string;
  createdAt: Date | string;
  allowDescriptionEdit: boolean;
  editGrantUsedAt: Date | string | null;
  targetLabel?: string | null;
  targetType?: string | null;
  targetValue?: string | null;
  sender: MessageActor;
  // Soft-delete metadata (HOMELAB-41 / item 2). When deletedAt is set,
  // the bubble is replaced by a DeletedMessageDivider that humans can
  // toggle open. Agents never see deleted bubbles in their context.
  deletedAt?: Date | string | null;
  deletedBy?: { username?: string | null; name?: string | null; kind?: string | null } | null;
}

type OptimisticMessage = Message & {
  optimisticStatus?: "sending" | "failed";
  optimisticTargets?: string[];
};

type ComposerDraftSnapshot = {
  body: string;
  files: File[];
};

interface ChatRoomProps {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  messages: Message[];
  activeMessageCount?: number;
  archives?: Array<{
    id: string;
    summary: string;
    startedAt: Date | string;
    endedAt: Date | string;
    messageCount: number;
    deletedAt?: Date | string | null;
  }>;
  binArchives?: Array<{
    id: string;
    summary: string;
    startedAt: Date | string;
    endedAt: Date | string;
    messageCount: number;
    deletedAt?: Date | string | null;
  }>;
  selectedArchiveId?: string | null;
  selectedArchiveDeleted?: boolean;
  viewingArchive?: boolean;
  discussionTargets?: DiscussionTarget[];
  defaultDiscussionTarget?: string | null;
  pendingAgents: Array<{ slug: string; username: string }>;
  latestMessageId: string | null;
  firstUnreadMessageId?: string | null;
  currentUserId?: string | null;
  currentUsername?: string | null;
  pendingProposals?: any[];
}

function formatModernDate(value: Date | string) {
  const d = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = new Intl.DateTimeFormat("en-AU", { timeStyle: "short" }).format(d);
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  }).format(d);
  return `${date} · ${time}`;
}

function daysUntilPurge(value?: Date | string | null) {
  if (!value) return null;
  const expiry = new Date(new Date(value).getTime() + 7 * 24 * 60 * 60 * 1000);
  const diffDays = Math.ceil((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return "purging soon";
  if (diffDays === 1) return "purge in 1d";
  return `purge in ${diffDays}d`;
}

function isInternalWorkflowNotification(message: Message) {
  return message.body.startsWith("PM workflow notification for @");
}

function optimisticLocalEchoEnabled() {
  return process.env.NEXT_PUBLIC_PM_OPTIMISTIC_LOCAL_ECHO === "1";
}

function NewMessagesMarker() {
  return (
    <div className="my-4 flex items-center gap-3 text-nano font-semibold uppercase tracking-[0.18em] text-crit">
      <span className="h-px flex-1 bg-crit/50" />
      <span>New messages</span>
      <span className="h-px flex-1 bg-crit/50" />
    </div>
  );
}

const VIRTUAL_MESSAGE_ESTIMATED_HEIGHT = 116;
const VIRTUAL_MESSAGE_OVERSCAN = 8;

function useVirtualizedMessageRows({
  messages,
  scrollRef,
}: {
  messages: OptimisticMessage[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const pinnedToBottomBeforeMeasureRef = useRef(true);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const [measurementVersion, forceMeasurementVersion] = useState(0);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const updateViewport = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      pinnedToBottomBeforeMeasureRef.current = distanceFromBottom < 120;
      setViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
    };

    updateViewport();
    container.addEventListener("scroll", updateViewport, { passive: true });

    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener("scroll", updateViewport);
      resizeObserver.disconnect();
    };
  }, [scrollRef]);

  useEffect(() => {
    const messageIds = new Set(messages.map((message) => message.id));
    let pruned = false;
    rowHeightsRef.current.forEach((_, id) => {
      if (!messageIds.has(id)) {
        rowHeightsRef.current.delete(id);
        pruned = true;
      }
    });
    if (pruned) forceMeasurementVersion((version) => version + 1);
  }, [messages]);

  const offsets = useMemo(() => {
    void measurementVersion;
    const starts: number[] = [];
    let total = 0;
    for (const message of messages) {
      starts.push(total);
      total += rowHeightsRef.current.get(message.id) ?? VIRTUAL_MESSAGE_ESTIMATED_HEIGHT;
    }
    return { starts, total };
  }, [messages, measurementVersion]);

  const range = useMemo(() => {
    if (messages.length === 0) return { start: 0, end: 0 };
    const overscanPixels = VIRTUAL_MESSAGE_ESTIMATED_HEIGHT * VIRTUAL_MESSAGE_OVERSCAN;
    const viewportTop = Math.max(0, viewport.scrollTop - overscanPixels);
    const viewportBottom = viewport.scrollTop + Math.max(viewport.height, 1) + overscanPixels;

    let start = 0;
    while (
      start < messages.length - 1
      && offsets.starts[start] + (rowHeightsRef.current.get(messages[start].id) ?? VIRTUAL_MESSAGE_ESTIMATED_HEIGHT) < viewportTop
    ) {
      start += 1;
    }

    let end = start;
    while (end < messages.length && offsets.starts[end] <= viewportBottom) {
      end += 1;
    }

    return {
      start: Math.max(0, start - VIRTUAL_MESSAGE_OVERSCAN),
      end: Math.min(messages.length, end + VIRTUAL_MESSAGE_OVERSCAN),
    };
  }, [messages, offsets, viewport]);

  const measureRow = useCallback((id: string, index: number, element: HTMLDivElement | null) => {
    if (!element) return undefined;

    const updateHeight = () => {
      const nextHeight = element.getBoundingClientRect().height;
      if (nextHeight <= 0) return;

      const previousHeight = rowHeightsRef.current.get(id) ?? VIRTUAL_MESSAGE_ESTIMATED_HEIGHT;
      const delta = nextHeight - previousHeight;
      if (Math.abs(delta) < 0.5) return;

      rowHeightsRef.current.set(id, nextHeight);
      const container = scrollRef.current;
      if (container) {
        const rowTop = offsets.starts[index] ?? 0;
        if (pinnedToBottomBeforeMeasureRef.current) {
          container.scrollTop = container.scrollHeight;
        } else if (rowTop < container.scrollTop) {
          container.scrollTop += delta;
        }
      }
      forceMeasurementVersion((version) => version + 1);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [offsets.starts, scrollRef]);

  const virtualMessages = messages.slice(range.start, range.end).map((message, offset) => ({
    message,
    index: range.start + offset,
  }));
  const topSpacer = offsets.starts[range.start] ?? 0;
  const renderedBottom = range.end > 0
    ? (offsets.starts[range.end - 1] ?? 0) + (rowHeightsRef.current.get(messages[range.end - 1]?.id) ?? VIRTUAL_MESSAGE_ESTIMATED_HEIGHT)
    : 0;
  const bottomSpacer = Math.max(0, offsets.total - renderedBottom);

  return {
    virtualMessages,
    topSpacer,
    bottomSpacer,
    totalMessageHeight: offsets.total,
    measureRow,
  };
}

function composerDraftStorageKey(parts: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  archiveId?: string | null;
  selectedTargets: string[];
}) {
  const threadId = parts.taskId ? `task:${parts.taskId}` : `epic:${parts.epicId ?? "unknown"}`;
  const archiveId = parts.archiveId ? `archive:${parts.archiveId}` : "current";
  const targetKey = parts.selectedTargets.length > 0 ? [...parts.selectedTargets].sort().join(",") : "default";
  return `pm:chat-composer-draft:v1:${parts.projectSlug}:${threadId}:${archiveId}:${targetKey}`;
}

function readStoredComposerDraft(key: string) {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStoredComposerDraft(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    const body = value.trim();
    if (body.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // Local draft persistence is best-effort only.
  }
}

function fileListFromInput(input: HTMLInputElement | null) {
  return Array.from(input?.files ?? []);
}

function RoomArchiveButton({
  projectSlug,
  taskId,
  epicId,
  hasActiveHistory,
  onArchived,
}: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  hasActiveHistory: boolean;
  onArchived?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"choice" | "archive" | "delete">("choice");
  const [customTitle, setCustomTitle] = useState("");
  const [isPending, startTransition] = useTransition();

  const runArchive = (moveToBin: boolean) => {
    const formData = new FormData();
    formData.append("projectSlug", projectSlug);
    if (taskId) formData.append("taskId", taskId);
    if (epicId) formData.append("epicId", epicId);
    if (customTitle.trim() && !moveToBin) {
      formData.append("customTitle", customTitle.trim());
    }
    if (moveToBin) formData.append("deleteToBin", "true");

    startTransition(async () => {
      await archiveChatRoom(formData);
      setOpen(false);
      setStep("choice");
      setCustomTitle("");
      if (!moveToBin) onArchived?.();
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        disabled={!hasActiveHistory}
        onClick={() => {
          runArchive(false);
        }}
        className="rounded-lg border border-line bg-panel px-control-x py-control-y text-micro font-semibold text-text-muted transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
      >
        New Discussion
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card backdrop-blur-sm"
          onClick={() => !isPending && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-panel border border-line bg-panel p-card-lg shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            {step === "choice" ? (
              <div className="space-y-section-gap">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-body font-semibold text-text">
                    Start a fresh room
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-heading leading-none text-text-muted transition hover:text-text cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <p className="text-body leading-relaxed text-text-muted">
                  Save the current discussion to Recent Discussions, or move it to the bin and clear this Task/Epic chat.
                </p>
                <div className="grid gap-2">
                  <button
                    type="button"
                    onClick={() => setStep("archive")}
                    className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-left text-body font-medium text-text transition hover:border-accent cursor-pointer"
                  >
                    Save current discussion
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runArchive(true)}
                    className="rounded-lg border border-crit/30 bg-crit/[0.04] px-3 py-2 text-left text-body font-medium text-crit transition hover:bg-crit/[0.08] cursor-pointer"
                  >
                    {isPending ? "Moving to bin..." : "Move current room to bin"}
                  </button>
                </div>
              </div>
            ) : null}

            {step === "archive" ? (
              <div className="space-y-section-gap">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-body font-semibold text-text">
                    Save discussion
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-heading leading-none text-text-muted transition hover:text-text cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <label className="block space-y-1.5 text-caption font-medium text-text-muted">
                  <span>Discussion title</span>
                  <input
                    type="text"
                    disabled={isPending}
                    value={customTitle}
                    onChange={(event) => setCustomTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") runArchive(false);
                    }}
                    placeholder="Optional title"
                    className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body text-text outline-none transition focus:border-accent disabled:opacity-50"
                  />
                </label>
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setStep("choice")}
                    className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium text-text-muted transition hover:border-accent hover:text-accent disabled:opacity-50 cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runArchive(false)}
                    className="rounded-lg bg-accent px-4 py-1.5 text-caption font-semibold text-bg transition hover:opacity-90 disabled:opacity-50 cursor-pointer"
                  >
                    {isPending ? "Saving..." : "Save discussion"}
                  </button>
                </div>
              </div>
            ) : null}

            {step === "delete" ? (
              <div className="space-y-section-gap">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-body font-semibold text-crit">
                    Move room to bin
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-heading leading-none text-text-muted transition hover:text-text cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <p className="text-body leading-relaxed text-text-muted">
                  This clears the active room and keeps the deleted transcript until the retention purge runs.
                </p>
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setStep("choice")}
                    className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium text-text-muted transition hover:border-accent hover:text-accent disabled:opacity-50 cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runArchive(true)}
                    className="rounded-lg bg-crit px-4 py-1.5 text-caption font-semibold text-on-crit transition hover:opacity-90 disabled:opacity-50 cursor-pointer"
                  >
                    {isPending ? "Deleting..." : "Move to bin"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function DecomposedChatRoom({
  projectSlug,
  taskId,
  epicId,
  messages,
  activeMessageCount,
  archives = [],
  binArchives = [],
  selectedArchiveId = null,
  selectedArchiveDeleted = false,
  viewingArchive = false,
  discussionTargets = [],
  defaultDiscussionTarget = null,
  pendingAgents,
  latestMessageId,
  firstUnreadMessageId = null,
  currentUserId = null,
  currentUsername = null,
  pendingProposals = [],
}: ChatRoomProps) {
  const pathname = usePathname();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollSettleTimerRef = useRef<number | null>(null);
  const optimisticRenderStartsRef = useRef<Map<string, number>>(new Map());
  const activeTab = useActiveTab();
  const [, startOptimisticTransition] = useTransition();
  const [messageText, setMessageText] = useState("");
  const [draftMessageId, setDraftMessageId] = useState(() => generateClientMessageId());
  const [composerOpen, setComposerOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [bottomReservation, setBottomReservation] = useState(88);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>(
    defaultDiscussionTarget ? [defaultDiscussionTarget] : [],
  );
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [archiveSidebarOpen, setArchiveSidebarOpen] = useState(false);
  const [archiveViewMode, setArchiveViewMode] = useState<"archives" | "bin">("archives");
  const optimisticEchoEnabled = optimisticLocalEchoEnabled();
  const [serverMessages, setServerMessages] = useState(messages);
  useEffect(() => {
    setServerMessages(messages);
  }, [messages]);
  const visibleMessages = useMemo(
    () => serverMessages.filter((message) => !isInternalWorkflowNotification(message)),
    [serverMessages],
  );
  const [failedOptimisticMessages, setFailedOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const [localLatestMessageId, setLocalLatestMessageId] = useState<string | null>(null);
  const [localPendingAgents, setLocalPendingAgents] = useState<Array<{ slug: string; username: string }>>([]);
  const [streamFinalMessages, setStreamFinalMessages] = useState<OptimisticMessage[]>([]);
  const currentUserActor = useMemo<MessageActor>(() => {
    const previousCurrentUserMessage = [...visibleMessages]
      .reverse()
      .find((message) => currentUserId && message.sender.id === currentUserId);
    if (previousCurrentUserMessage) return previousCurrentUserMessage.sender;
    return {
      id: currentUserId,
      username: "you",
      kind: "human",
      name: "You",
      avatarUpdatedAt: null,
      agent: null,
    };
  }, [visibleMessages, currentUserId]);
  const visibleMessagesWithFailures = useMemo<OptimisticMessage[]>(() => {
    if (!optimisticEchoEnabled) return visibleMessages;
    const serverIds = new Set(visibleMessages.map((message) => message.id));
    const serverFingerprints = new Set(
      visibleMessages.map((message) => `${message.sender.agent?.slug ?? message.sender.username}:${message.body}`),
    );
    return [
      ...visibleMessages,
      ...failedOptimisticMessages.filter((message) => !serverIds.has(message.id)),
      ...streamFinalMessages.filter((message) => (
        !serverIds.has(message.id)
        && !serverFingerprints.has(`${message.sender.agent?.slug ?? message.sender.username}:${message.body}`)
      )),
    ];
  }, [optimisticEchoEnabled, visibleMessages, failedOptimisticMessages, streamFinalMessages]);
  const [optimisticMessages, addOptimisticMessage] = useOptimistic(
    visibleMessagesWithFailures,
    (currentMessages: OptimisticMessage[], optimisticMessage: OptimisticMessage) => [
      ...currentMessages.filter((message) => message.id !== optimisticMessage.id),
      optimisticMessage,
    ],
  );
  const displayedMessages: OptimisticMessage[] = optimisticEchoEnabled ? optimisticMessages : visibleMessages;
  const activeLatestMessageId = localLatestMessageId ?? latestMessageId;
  const activePendingAgents = localLatestMessageId ? localPendingAgents : pendingAgents;
  const pmOptionResolutions = useMemo(() => {
    const map = new Map<string, ReturnType<typeof findPmOptionResolution>>();
    displayedMessages.forEach((message, index) => {
      const parsed = parsePmOptions(message.body);
      if (parsed.options.length === 0) return;
      map.set(
        message.id,
        findPmOptionResolution(parsed.options, displayedMessages.slice(index + 1).map((later) => later.body)),
      );
    });
    return map;
  }, [displayedMessages]);
  const selectedFilesCount = selectedFiles.length;
  const canSend = messageText.trim().length > 0 || selectedFilesCount > 0;
  const activeCount = activeMessageCount ?? visibleMessages.length;
  const canContinueArchive = viewingArchive && !selectedArchiveDeleted && activeCount === 0;
  const discussionIsVisible = activeTab === null || activeTab === "Action Plan";
  const latestEventKey = [
    viewingArchive ? "archive" : "current",
    selectedArchiveId ?? "",
    displayedMessages.length,
    displayedMessages.at(-1)?.id ?? "",
    activeLatestMessageId ?? "",
    activePendingAgents.map((agent) => agent.slug).join(","),
  ].join("|");
  const participantIndexes = useMemo(() => {
    const map = new Map<string, number>();
    for (const message of displayedMessages) {
      if (currentUserId && message.sender.id === currentUserId) continue;
      const key = messageParticipantKey(message.sender);
      if (!map.has(key)) map.set(key, map.size);
    }
    return map;
  }, [displayedMessages, currentUserId]);

  useLayoutEffect(() => {
    if (!optimisticEchoEnabled) return;

    for (const message of displayedMessages) {
      if (message.optimisticStatus !== "sending") continue;
      const startedAt = optimisticRenderStartsRef.current.get(message.id);
      if (startedAt == null) continue;

      const duration = performance.now() - startedAt;
      performance.measure("pm-channel-latency:own-message-render", {
        start: startedAt,
        duration,
        detail: { messageId: message.id },
      });
      optimisticRenderStartsRef.current.delete(message.id);
    }
  }, [optimisticEchoEnabled, displayedMessages]);

  const updatePinnedState = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return true;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isPinned = distanceFromBottom < 120;
    pinnedToBottomRef.current = isPinned;
    setShowJumpToLatest(!isPinned);
    return isPinned;
  }, []);

  const scheduleScrollToLatest = useCallback((force = false) => {
    if (!discussionIsVisible) return;
    if (!force && !pinnedToBottomRef.current) return;

    const scrollToLatest = () => {
      const container = scrollRef.current;
      if (!container) return;

      container.scrollTop = container.scrollHeight;
      pinnedToBottomRef.current = true;
      setShowJumpToLatest(false);
      if (force) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
      }
    };

    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    if (scrollSettleTimerRef.current !== null) {
      window.clearTimeout(scrollSettleTimerRef.current);
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollToLatest();
    });
    scrollSettleTimerRef.current = window.setTimeout(() => {
      scrollSettleTimerRef.current = null;
      scrollToLatest();
    }, 80);
  }, [discussionIsVisible]);

  useLayoutEffect(() => {
    if (!discussionIsVisible) return;
    scheduleScrollToLatest(!showJumpToLatest);
  }, [discussionIsVisible, latestEventKey, scheduleScrollToLatest, showJumpToLatest]);

  useEffect(() => {
    if (!discussionIsVisible || !scrollRef.current) return;

    const container = scrollRef.current;
    const handleScroll = () => {
      updatePinnedState();
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [discussionIsVisible, updatePinnedState]);

  useEffect(() => {
    if (!discussionIsVisible || !scrollContentRef.current) return;

    const observer = new ResizeObserver(() => {
      scheduleScrollToLatest();
      updatePinnedState();
    });
    observer.observe(scrollContentRef.current);

    return () => observer.disconnect();
  }, [discussionIsVisible, scheduleScrollToLatest, updatePinnedState]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (scrollSettleTimerRef.current !== null) {
        window.clearTimeout(scrollSettleTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!composerOpen || !formRef.current) {
      setBottomReservation(88);
      scheduleScrollToLatest();
      return;
    }

    const updateReservation = () => {
      const height = formRef.current?.getBoundingClientRect().height ?? 0;
      setBottomReservation(Math.max(88, height + 120));
      scheduleScrollToLatest();
    };

    updateReservation();
    const observer = new ResizeObserver(updateReservation);
    observer.observe(formRef.current);

    return () => observer.disconnect();
  }, [composerOpen, scheduleScrollToLatest]);

  useEffect(() => {
    setSelectedTargets(defaultDiscussionTarget ? [defaultDiscussionTarget] : []);
  }, [defaultDiscussionTarget]);

  const composerDraftKey = useMemo(() => composerDraftStorageKey({
    projectSlug,
    taskId,
    epicId,
    archiveId: canContinueArchive ? selectedArchiveId : null,
    selectedTargets,
  }), [canContinueArchive, epicId, projectSlug, selectedArchiveId, selectedTargets, taskId]);
  const composerDraftKeyRef = useRef(composerDraftKey);
  const composerDraftSnapshotsRef = useRef<Map<string, ComposerDraftSnapshot>>(new Map());
  const composerDraftHydratedRef = useRef(false);

  useEffect(() => {
    setMessageText(readStoredComposerDraft(composerDraftKey));
    composerDraftKeyRef.current = composerDraftKey;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const previousKey = composerDraftKeyRef.current;
    if (previousKey === composerDraftKey) return;

    composerDraftSnapshotsRef.current.set(previousKey, {
      body: messageText,
      files: selectedFiles,
    });
    writeStoredComposerDraft(previousKey, messageText);

    const snapshot = composerDraftSnapshotsRef.current.get(composerDraftKey);
    setMessageText(snapshot?.body ?? readStoredComposerDraft(composerDraftKey));
    setSelectedFiles(snapshot?.files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    composerDraftKeyRef.current = composerDraftKey;
  }, [composerDraftKey, fileInputRef, messageText, selectedFiles]);

  useEffect(() => {
    if (!composerDraftHydratedRef.current) {
      composerDraftHydratedRef.current = true;
      return;
    }
    composerDraftSnapshotsRef.current.set(composerDraftKey, { body: messageText, files: selectedFiles });
    writeStoredComposerDraft(composerDraftKey, messageText);
  }, [composerDraftKey, messageText, selectedFiles]);

  useEffect(() => {
    if (!composerOpen) return;
    textareaRef.current?.focus();
  }, [composerOpen]);

  const targetOptions: DiscussionTarget[] = [
    { value: "all-coders", label: "All Coders", group: "Groups" },
    ...discussionTargets,
  ];
  useEffect(() => {
    if (!composerOpen || viewingArchive || selectedArchiveDeleted) return;
    if (!messageText.trim() && selectedFilesCount === 0) return;
    const timeout = window.setTimeout(() => {
      const formData = new FormData();
      formData.append("projectSlug", projectSlug);
      if (taskId) formData.append("taskId", taskId);
      if (epicId) formData.append("epicId", epicId);
      formData.append("messageId", draftMessageId);
      formData.append("body", messageText);
      for (const target of selectedTargets) {
        formData.append("discussionTarget", target);
      }
      prebuildAgentChatContext(formData).catch(() => {
        // Speculative context is best-effort; send falls back to synchronous build.
      });
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [composerOpen, draftMessageId, epicId, messageText, projectSlug, selectedArchiveDeleted, selectedFilesCount, selectedTargets, taskId, viewingArchive]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) formRef.current?.requestSubmit();
    }
  };

  const resetComposerAfterSend = () => {
    setMessageText("");
    setSelectedFiles([]);
    composerDraftSnapshotsRef.current.delete(composerDraftKeyRef.current);
    writeStoredComposerDraft(composerDraftKeyRef.current, "");
    setTargetPickerOpen(false);
    setDraftMessageId(generateClientMessageId());
    if (textareaRef.current) textareaRef.current.value = "";
    if (fileInputRef.current) fileInputRef.current.value = "";
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const ensureClientMessageId = (formData: FormData) => {
    const existing = String(formData.get("messageId") ?? "").trim();
    if (existing) return existing;
    const messageId = generateClientMessageId();
    formData.set("messageId", messageId);
    return messageId;
  };

  const optimisticMessageFromForm = (formData: FormData, status: "sending" | "failed" = "sending"): OptimisticMessage => {
    const messageId = ensureClientMessageId(formData);
    const body = String(formData.get("body") ?? "").trim();
    const targets = formData
      .getAll("discussionTarget")
      .map((value) => String(value).trim())
      .filter(Boolean);
    const selectedTargetLabel = targets
      .map((value) => targetOptions.find((target) => target.value === value)?.label ?? value)
      .join(", ");
    return {
      id: messageId,
      body,
      createdAt: new Date(),
      allowDescriptionEdit: false,
      editGrantUsedAt: null,
      targetLabel: selectedTargetLabel || null,
      targetType: null,
      targetValue: null,
      sender: currentUserActor,
      deletedAt: null,
      deletedBy: null,
      optimisticStatus: status,
      optimisticTargets: targets,
    };
  };

  const pendingAgentsFromForm = (formData: FormData) => {
    const targets = formData
      .getAll("discussionTarget")
      .map((value) => String(value).trim())
      .filter(Boolean);
    const effectiveTargets = targets.length > 0 ? targets : selectedTargets;
    const agentOptions = targetOptions.filter((target) => target.group === "Agents");
    const selectedAgentOptions = effectiveTargets.includes("all-coders")
      ? agentOptions
      : agentOptions.filter((target) => effectiveTargets.includes(target.value));
    return selectedAgentOptions
      .map((target) => target.actor?.agent?.slug ? { slug: target.actor.agent.slug, username: target.actor.username ?? target.label } : null)
      .filter((agent): agent is { slug: string; username: string } => Boolean(agent));
  };

  const submitOptimisticMessage = async (formData: FormData, optimisticMessage: OptimisticMessage) => {
    const pendingAgentsForMessage = pendingAgentsFromForm(formData);
    optimisticRenderStartsRef.current.set(optimisticMessage.id, performance.now());
    startOptimisticTransition(() => addOptimisticMessage(optimisticMessage));
    setLocalLatestMessageId(optimisticMessage.id);
    setLocalPendingAgents(pendingAgentsForMessage);
    setFailedOptimisticMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
    try {
      const result = await sendAgentChatMessage(formData);
      if (result?.messageId) {
        setLocalLatestMessageId(result.messageId);
        setLocalPendingAgents(pendingAgentsForMessage);
      }
    } catch (error) {
      setLocalLatestMessageId((current) => current === optimisticMessage.id ? null : current);
      setLocalPendingAgents([]);
      setFailedOptimisticMessages((current) => [
        ...current.filter((message) => message.id !== optimisticMessage.id),
        { ...optimisticMessage, optimisticStatus: "failed" },
      ]);
      throw error;
    }
  };

  const retryOptimisticMessage = async (message: OptimisticMessage) => {
    const formData = new FormData();
    formData.append("projectSlug", projectSlug);
    if (taskId) formData.append("taskId", taskId);
    if (epicId) formData.append("epicId", epicId);
    formData.append("agentSlug", "room");
    formData.append("messageId", generateClientMessageId());
    formData.append("body", message.body);
    for (const target of message.optimisticTargets ?? []) {
      formData.append("discussionTarget", target);
    }
    const retryMessage = optimisticMessageFromForm(formData);
    setFailedOptimisticMessages((current) => current.filter((item) => item.id !== message.id));
    try {
      await submitOptimisticMessage(formData, retryMessage);
    } catch {
      // Failed state is rendered inline on the optimistic bubble.
    }
  };

  const actionHandler = async (formData: FormData) => {
    formData.delete("attachments");
    for (const file of selectedFiles) {
      formData.append("attachments", file);
    }

    if (!optimisticEchoEnabled) {
      ensureClientMessageId(formData);
      await sendAgentChatMessage(formData);
      resetComposerAfterSend();
      return;
    }

    const optimisticMessage = optimisticMessageFromForm(formData);
    try {
      await submitOptimisticMessage(formData, optimisticMessage);
      resetComposerAfterSend();
    } catch {
      // Failed state is rendered inline on the optimistic bubble.
    }
  };

  const reconcileMessages = useCallback(async () => {
    if (viewingArchive) return;
    const formData = new FormData();
    formData.append("projectSlug", projectSlug);
    if (taskId) formData.append("taskId", taskId);
    if (epicId) formData.append("epicId", epicId);
    const nextMessages = await getAgentChatRoomMessages(formData);
    setServerMessages(nextMessages as Message[]);
    // Refetching messages alone leaves the rest of the server-rendered tree
    // stale (work-item proposals, agent-edited task description, the server-
    // computed pendingAgents). The old StreamingAgentReply called router.refresh
    // on completion; preserve that so a reply that submits a proposal or edits
    // the description shows up without a manual reload.
    router.refresh();
  }, [epicId, projectSlug, router, taskId, viewingArchive]);

  // Once every optimistic stream has settled, stop shadowing the server-
  // computed latestMessageId/pendingAgents so later server updates (e.g. another
  // participant's message) can drive the typing indicators again.
  useEffect(() => {
    if (localLatestMessageId && localPendingAgents.length === 0) {
      setLocalLatestMessageId(null);
    }
  }, [localLatestMessageId, localPendingAgents.length]);

  const closeComposer = () => {
    setComposerOpen(false);
    setTargetPickerOpen(false);
  };

  useEffect(() => {
    if (!archiveSidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArchiveSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [archiveSidebarOpen]);

  return (
    <div className="relative flex h-[calc(100dvh-14rem)] min-h-[620px] flex-col overflow-hidden rounded-panel border border-line bg-panel shadow-sm max-sm:h-[100dvh] max-sm:min-h-0 max-sm:rounded-none max-sm:border-x-0">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line bg-panel-soft px-card py-control-y.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent animate-pulse" />
          <span className="text-caption font-semibold uppercase tracking-wider text-text">
            {taskId ? "Task Chat Room" : "Epic Chat Room"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!viewingArchive ? <NativePmNotificationToggle compact /> : null}
          <button
            type="button"
            onClick={() => setArchiveSidebarOpen((open) => !open)}
            className="grid h-11 w-11 place-items-center rounded-lg border border-line bg-panel text-text-muted transition hover:border-accent hover:text-accent md:h-8 md:w-8 cursor-pointer"
            aria-label={archiveSidebarOpen ? "Hide recent discussions" : "Show recent discussions"}
            title={archiveSidebarOpen ? "Hide recent discussions" : "Show recent discussions"}
          >
            {archiveSidebarOpen ? (
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M15 3v18" />
                <path d="m10 9 3 3-3 3" />
              </svg>
            ) : (
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M15 3v18" />
                <path d="m11 15-3-3 3-3" />
              </svg>
            )}
          </button>
          {viewingArchive ? (
            <span className="hidden text-nano text-text-muted uppercase tracking-wider font-semibold sm:inline">
              Archived Discussion
            </span>
          ) : null}
          {viewingArchive ? (
            <Link
              href={`${pathname}?chatRoom=current`}
              className="rounded-lg border border-line bg-panel px-control-x py-control-y text-micro font-semibold text-text-muted transition hover:border-accent hover:text-accent"
            >
              Current Room
            </Link>
          ) : (
            <RoomArchiveButton
              projectSlug={projectSlug}
              taskId={taskId}
              epicId={epicId}
              hasActiveHistory={(activeMessageCount ?? visibleMessages.length) > 0}
              onArchived={() => setComposerOpen(true)}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
      {archiveSidebarOpen ? (
        <>
        <button
          type="button"
          onClick={() => setArchiveSidebarOpen(false)}
          className="fixed inset-0 z-40 hidden bg-black/45 backdrop-blur-sm max-sm:block"
          aria-label="Close recent discussions"
        />
        <aside className="order-2 flex w-[min(22rem,42vw)] min-w-[18rem] flex-col border-l border-line bg-panel shadow-[-18px_0_35px_rgba(15,23,42,0.06)] max-sm:fixed max-sm:inset-y-0 max-sm:right-0 max-sm:z-50 max-sm:w-[85vw] max-sm:min-w-0 max-sm:max-w-[85vw] max-sm:shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div>
              <div className="flex items-center gap-1.5">
                <p className="text-caption font-semibold text-text">
                  {archiveViewMode === "archives" ? "Recent Discussions" : "Discussion bin"}
                </p>
                <span className={`rounded-full px-1.5 py-0.5 text-nano font-bold ${
                  archiveViewMode === "archives"
                    ? "bg-ok/10 text-ok"
                    : "bg-crit/10 text-crit"
                }`}>
                  {archiveViewMode === "archives" ? archives.length : binArchives.length}
                </span>
              </div>
              <p className="text-nano uppercase tracking-wider text-text-muted">
                {archiveViewMode === "archives" ? "Latest rooms" : "Deleted rooms"}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setArchiveSidebarOpen(false)}
                className="grid h-11 w-11 place-items-center rounded-md border border-line bg-panel-soft text-text-muted transition hover:border-accent hover:text-accent md:h-7 md:w-7 cursor-pointer"
                aria-label="Close action plan archives"
                title="Hide sidebar"
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M15 3v18" />
                  <path d="m10 9 3 3-3 3" />
                </svg>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1 border-b border-line bg-panel-soft p-1.5 text-caption font-semibold">
            <button
              type="button"
              onClick={() => setArchiveViewMode("archives")}
              className={`rounded-lg px-2 py-1.5 transition ${
                archiveViewMode === "archives"
                  ? "bg-panel text-text shadow-sm"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Recent <span className="text-nano text-text-muted">({archives.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setArchiveViewMode("bin")}
              className={`rounded-lg px-2 py-1.5 transition ${
                archiveViewMode === "bin"
                  ? "bg-panel text-text shadow-sm"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Bin <span className="text-nano text-text-muted">({binArchives.length})</span>
            </button>
          </div>
          <div className="flex-1 space-y-section-gap overflow-y-auto p-3">
            <Link
              href={`${pathname}?chatRoom=current`}
              className={`block rounded-lg border px-3 py-2 text-caption transition ${
                !viewingArchive
                  ? "border-accent bg-accent/[0.08] text-text"
                  : "border-line bg-panel-soft text-text-muted hover:border-accent hover:text-text"
              }`}
            >
              <span className="font-semibold">Current discussion</span>
              <span className="mt-1 block text-nano uppercase tracking-wider">
                {activeCount} message{activeCount === 1 ? "" : "s"}
              </span>
            </Link>

            {archiveViewMode === "archives" ? (
              archives.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line p-3 text-center text-caption text-text-muted">
                  No recent discussions.
                </p>
              ) : (
                <div className="space-y-3">
                  {archives.map((archive) => {
                    const selected = selectedArchiveId === archive.id && !selectedArchiveDeleted;
                    return (
                      <Link
                        key={archive.id}
                        href={`${pathname}?chatArchive=${archive.id}`}
                        className={`block rounded-card border p-2 text-caption shadow-sm transition ${
                          selected
                            ? "border-accent bg-accent/[0.04] text-text"
                            : "border-line bg-panel-soft text-text-muted hover:border-accent/30 hover:bg-panel hover:text-text"
                        }`}
                      >
                        <span className="mb-0.5 block text-pico font-semibold tracking-wider text-text-muted">
                          {formatModernDate(archive.startedAt)}
                        </span>
                        <span className="block truncate font-semibold">{archive.summary}</span>
                        <span className="mt-1 block border-t border-line/40 pt-1 text-nano uppercase tracking-wider">
                          {archive.messageCount} message{archive.messageCount === 1 ? "" : "s"}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )
            ) : binArchives.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line p-3 text-center text-caption text-text-muted">
                  No deleted action plans.
                </p>
              ) : (
                <div className="space-y-3">
                  {binArchives.map((archive) => {
                    const selected = selectedArchiveId === archive.id && selectedArchiveDeleted;
                    const purgeLabel = daysUntilPurge(archive.deletedAt);
                    return (
                      <Link
                        key={archive.id}
                        href={`${pathname}?chatArchive=${archive.id}`}
                        className={`block rounded-card border p-2 text-caption shadow-sm transition ${
                          selected
                            ? "border-crit bg-crit/[0.06] text-text"
                            : "border-line bg-panel-soft text-text-muted hover:border-crit/50 hover:bg-panel hover:text-text"
                        }`}
                      >
                        <span className="mb-0.5 block text-pico font-semibold tracking-wider text-text-muted">
                          {formatModernDate(archive.startedAt)}
                        </span>
                        <span className="block truncate font-semibold">{archive.summary}</span>
                        <span className="mt-1 flex items-center justify-between gap-2 border-t border-line/40 pt-1 text-nano uppercase tracking-wider">
                          <span>
                          {archive.messageCount} message{archive.messageCount === 1 ? "" : "s"}
                          </span>
                          {purgeLabel ? (
                            <span className="rounded-md border border-crit/10 bg-crit/[0.06] px-1.5 py-0.5 font-mono font-semibold text-crit normal-case">
                              {purgeLabel}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
          </div>
        </aside>
        </>
      ) : null}

      <div className="order-1 flex min-w-0 flex-1 flex-col">
      <MessageList
        scrollRef={scrollRef}
        scrollContentRef={scrollContentRef}
        displayedMessages={displayedMessages}
        viewingArchive={viewingArchive}
        firstUnreadMessageId={firstUnreadMessageId}
        projectSlug={projectSlug}
        currentUserId={currentUserId}
        currentUsername={currentUsername}
        taskId={taskId}
        epicId={epicId}
        pmOptionResolutions={pmOptionResolutions}
        participantIndexes={participantIndexes}
        retryOptimisticMessage={retryOptimisticMessage}
        activeLatestMessageId={activeLatestMessageId}
        activePendingAgents={activePendingAgents}
        setLocalPendingAgents={setLocalPendingAgents}
        setStreamFinalMessages={setStreamFinalMessages}
        reconcileMessages={reconcileMessages}
        pendingProposals={pendingProposals}
        bottomReservation={bottomReservation}
        setMessageText={setMessageText}
        setComposerOpen={setComposerOpen}
      />

      {showJumpToLatest ? (
        <button
          type="button"
          onClick={() => scheduleScrollToLatest(true)}
          className="fixed bottom-24 right-6 z-40 rounded-full border border-line bg-panel px-3 py-2 text-caption font-semibold text-text shadow-lg transition hover:border-accent hover:text-accent max-sm:bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] max-sm:right-4"
        >
          Jump to latest
        </button>
      ) : null}

      <Composer
        viewingArchive={viewingArchive}
        canContinueArchive={canContinueArchive}
        selectedArchiveDeleted={selectedArchiveDeleted}
        activeCount={activeCount}
        pathname={pathname}
        composerOpen={composerOpen}
        closeComposer={closeComposer}
        formRef={formRef}
        actionHandler={actionHandler}
        projectSlug={projectSlug}
        taskId={taskId}
        epicId={epicId}
        selectedTargets={selectedTargets}
        selectedArchiveId={selectedArchiveId}
        draftMessageId={draftMessageId}
        messageText={messageText}
        setMessageText={setMessageText}
        handleKeyDown={handleKeyDown}
        selectedFiles={selectedFiles}
        setSelectedFiles={setSelectedFiles}
        selectedFilesCount={selectedFilesCount}
        fileInputRef={fileInputRef}
        textareaRef={textareaRef}
        canSend={canSend}
        targetPickerOpen={targetPickerOpen}
        setTargetPickerOpen={setTargetPickerOpen}
        targetOptions={targetOptions}
        setSelectedTargets={setSelectedTargets}
        setComposerOpen={setComposerOpen}
      />      </div>
      </div>
    </div>
  );
}


const MessageList = React.memo(function MessageList(props: any) {
  const {
    scrollRef,
    scrollContentRef,
    displayedMessages,
    viewingArchive,
    firstUnreadMessageId,
    projectSlug,
    currentUserId,
    currentUsername,
    taskId,
    epicId,
    pmOptionResolutions,
    participantIndexes,
    retryOptimisticMessage,
    activeLatestMessageId,
    activePendingAgents,
    setLocalPendingAgents,
    setStreamFinalMessages,
    reconcileMessages,
    pendingProposals,
    bottomReservation,
    setMessageText,
    setComposerOpen,
  } = props;
  const [canceledMessageIds, setCanceledMessageIds] = useState<Set<string>>(() => new Set());

  if (process.env.NEXT_PUBLIC_PM_CHAT_RENDER_PROBE === "1") {
    performance.mark(`pm-chat-render:message-list:${displayedMessages.length}`);
  }

  const {
    virtualMessages,
    topSpacer,
    bottomSpacer,
    totalMessageHeight,
    measureRow,
  } = useVirtualizedMessageRows({
    messages: displayedMessages,
    scrollRef,
  });

  const cancelAndEdit = useCallback(async (message: OptimisticMessage) => {
    const pending = activeLatestMessageId === message.id ? activePendingAgents : [];
    await Promise.all(pending.map((agent: { slug: string }) => fetch("/api/openclaw/pm-channel/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: taskId
          ? { kind: "task-chat", agentSlug: agent.slug, taskId, messageId: message.id, projectSlug }
          : { kind: "epic-chat", agentSlug: agent.slug, epicId, messageId: message.id, projectSlug },
      }),
    })));
    setLocalPendingAgents([]);
    setCanceledMessageIds((current) => {
      const next = new Set(current);
      next.add(message.id);
      return next;
    });
    setMessageText(message.body);
    setComposerOpen(true);
  }, [activeLatestMessageId, activePendingAgents, epicId, projectSlug, setComposerOpen, setLocalPendingAgents, setMessageText, taskId]);

  return (
    <>
      {/* Messages List */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-card min-h-0 scrollbar-thin max-sm:p-3"
      >
        <div ref={scrollContentRef}>
        {displayedMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 border border-dashed border-line rounded-card bg-panel-soft/20">
            <span className="text-heading">💬</span>
            <p className="mt-2 text-caption font-semibold text-text">
              Welcome to the Chat Room!
            </p>
            <p className="mt-1 text-micro text-text-muted max-w-[280px]">
              Post a message to invoke default assignees/reviewers, or use <code className="px-1 py-0.5 rounded bg-panel-soft font-mono text-accent">@agent</code> to mention specific agents.
            </p>
          </div>
        ) : (
          <div
            data-virtualized-message-list="true"
            style={{ minHeight: totalMessageHeight }}
          >
            <div aria-hidden="true" style={{ height: topSpacer }} />
            {virtualMessages.map(({ message: m, index }: { message: OptimisticMessage; index: number }) => {
              const groupState = getMessageGroupState(displayedMessages, index);
              const rowClassName = groupState.isGroupedContinuation ? "mt-1" : "mt-6 first:mt-0";
              const unreadMarker = !viewingArchive && firstUnreadMessageId === m.id ? <NewMessagesMarker /> : null;
              if (m.deletedAt) {
                // Soft-deleted action-plan bubble (HOMELAB-41 / item 2).
                // Restore (↺) only offered when viewing the live room —
                // archived views stay read-only. Agents never see these
                // in their context until restored.
                return (
                  <div
                    key={m.id}
                    ref={(element) => measureRow(m.id, index, element)}
                    data-virtualized-message-row={m.id}
                    className={rowClassName}
                  >
                    {unreadMarker}
                    <DeletedMessageDivider
                      deletedAt={m.deletedAt}
                      deletedBy={m.deletedBy ?? null}
                      restore={!viewingArchive ? {
                        action: restoreChatMessage,
                        fields: { projectSlug, messageId: m.id },
                      } : undefined}
                    >
                      <span>{m.body}</span>
                    </DeletedMessageDivider>
                  </div>
                );
              }
              return (
                <div
                  key={m.id}
                  ref={(element) => measureRow(m.id, index, element)}
                  data-virtualized-message-row={m.id}
                  className={rowClassName}
                >
                  {unreadMarker}
                  <ChatBubble
                    message={m}
                    currentUserId={currentUserId}
                    projectSlug={projectSlug}
                    highlighted={Boolean(currentUsername && new RegExp(`(^|[^A-Za-z0-9_])@${currentUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "i").test(m.body))}
                    surface={taskId ? "task-chat" : "epic-chat"}
                    resolvedOption={pmOptionResolutions.get(m.id) ?? null}
                    preferShortAgentSections
                    participantIndex={participantIndexes.get(messageParticipantKey(m.sender)) ?? 0}
                    isGroupStart={groupState.isGroupStart}
                    isGroupEnd={groupState.isGroupEnd}
                    isGroupedContinuation={groupState.isGroupedContinuation}
                    deliveryStatus={(m as OptimisticMessage).optimisticStatus}
                    actions={(
                      <span className="inline-flex items-center gap-1.5">
                        {canceledMessageIds.has(m.id) ? (
                          <span className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-nano font-semibold uppercase tracking-wider text-text-muted">
                            canceled
                          </span>
                        ) : null}
                        {!viewingArchive &&
                        activeLatestMessageId === m.id &&
                        activePendingAgents.length > 0 &&
                        m.sender.kind !== "agent" &&
                        currentUserId &&
                        m.sender.id === currentUserId ? (
                          <button
                            type="button"
                            onClick={() => cancelAndEdit(m as OptimisticMessage)}
                            className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-nano font-semibold uppercase tracking-wider text-text-muted transition hover:border-crit hover:text-crit"
                          >
                            Stop and edit
                          </button>
                        ) : null}
                        {(m as OptimisticMessage).optimisticStatus === "failed" ? (
                          <button
                            type="button"
                            onClick={() => retryOptimisticMessage(m as OptimisticMessage)}
                            className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-nano font-semibold uppercase tracking-wider text-text-muted transition hover:border-accent hover:text-accent"
                          >
                            Retry
                          </button>
                        ) : !viewingArchive && !(m as OptimisticMessage).optimisticStatus ? (
                          <ConfirmedDeleteButton
                            action={deleteChatMessage}
                            fields={{ projectSlug, messageId: m.id }}
                            label="×"
                            title="Delete message"
                            description="The action plan bubble will be hidden behind a collapsed dotted divider that humans can expand. Agents will never see it in their context again."
                            confirmLabel="Delete message"
                            buttonTitle="Delete message"
                            ariaLabel="Delete message"
                            className="text-caption font-bold text-text-muted opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 hover:text-crit cursor-pointer"
                          />
                        ) : null}
                      </span>
                    )}
                  />
                </div>
              );
            })}
            <div aria-hidden="true" style={{ height: bottomSpacer }} />
          </div>
        )}

        <StreamController
          viewingArchive={viewingArchive}
          activeLatestMessageId={activeLatestMessageId}
          activePendingAgents={activePendingAgents}
          taskId={taskId}
          epicId={epicId}
          setLocalPendingAgents={setLocalPendingAgents}
          setStreamFinalMessages={setStreamFinalMessages}
          reconcileMessages={reconcileMessages}
        />

        {/* Proposal Reviews */}
        {!viewingArchive && pendingProposals.length > 0 && (
          <div className="mt-4 border-t border-line pt-4">
            <ProposalReview
              proposals={pendingProposals.map((p: any) => ({
                id: p.id,
                summary: p.summary,
                operations: p.operations,
                validation: p.validation,
                createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
                projectName: p.project.name,
                agentSlug: p.agentSlug,
              }))}
            />
          </div>
        )}
          <div aria-hidden="true" style={{ height: bottomReservation }} />
        </div>
      </div>
    </>
  );
});

const StreamController = React.memo(function StreamController(props: any) {
  const {
    viewingArchive,
    activeLatestMessageId,
    activePendingAgents,
    taskId,
    epicId,
    setLocalPendingAgents,
    setStreamFinalMessages,
    reconcileMessages,
  } = props;

  if (process.env.NEXT_PUBLIC_PM_CHAT_RENDER_PROBE === "1") {
    performance.mark(`pm-chat-render:stream-controller:${activeLatestMessageId ?? "none"}`);
  }

  if (viewingArchive || !activeLatestMessageId) return null;

  return activePendingAgents.map((agent: { slug: string; username: string }) => (
    <StreamingAgentReply
      key={`${activeLatestMessageId}:${agent.slug}`}
      targetKind={taskId ? "task-chat" : "epic-chat"}
      agentSlug={agent.slug}
      messageId={activeLatestMessageId}
      taskId={taskId}
      epicId={epicId}
      label={agent.username}
      roomId={ChatStreamManager.roomId({
        targetKind: taskId ? "task-chat" : "epic-chat",
        agentSlug: agent.slug,
        taskId,
        epicId,
      })}
      anonymizeTyping
      onFinal={async ({ text, status }: { text: string; status: string }) => {
        // Clear this agent's typing indicator on ANY terminal status. The old
        // early-return on error left the indicator spinning forever and skipped
        // the reconcile that refreshes the rest of the server tree.
        setLocalPendingAgents((current: Array<{ slug: string; username: string }>) => current.filter((item) => item.slug !== agent.slug));
        if (status === "done" && text.trim()) {
          setStreamFinalMessages((current: OptimisticMessage[]) => [
            ...current.filter((message) => message.id !== `stream-final-${activeLatestMessageId}-${agent.slug}`),
            {
              id: `stream-final-${activeLatestMessageId}-${agent.slug}`,
              body: text,
              createdAt: new Date(),
              allowDescriptionEdit: false,
              editGrantUsedAt: null,
              targetLabel: null,
              targetType: null,
              targetValue: null,
              sender: {
                username: agent.slug,
                kind: "agent",
                name: agent.username,
                agent: { slug: agent.slug, name: agent.username, avatar: "placeholder" },
              },
              deletedAt: null,
              deletedBy: null,
            },
          ]);
        }
        await reconcileMessages();
      }}
      onCanceled={({ agentSlug }: { agentSlug: string }) => {
        setLocalPendingAgents((current: Array<{ slug: string; username: string }>) => current.filter((item) => item.slug !== agentSlug));
      }}
    />
  ));
});

const Composer = React.memo(function Composer(props: any) {
  const {
    viewingArchive,
    canContinueArchive,
    selectedArchiveDeleted,
    activeCount,
    pathname,
    composerOpen,
    closeComposer,
    formRef,
    actionHandler,
    projectSlug,
    taskId,
    epicId,
    selectedTargets,
    selectedArchiveId,
    draftMessageId,
    messageText,
    setMessageText,
    handleKeyDown,
    selectedFiles,
    setSelectedFiles,
    selectedFilesCount,
    fileInputRef,
    textareaRef,
    canSend,
    targetPickerOpen,
    setTargetPickerOpen,
    targetOptions,
    setSelectedTargets,
    setComposerOpen,
  } = props;

  if (process.env.NEXT_PUBLIC_PM_CHAT_RENDER_PROBE === "1") {
    performance.mark(`pm-chat-render:composer:${messageText.length}`);
  }

  return (
    <>
      {/* Input Form */}
      {viewingArchive && !canContinueArchive ? (
        <div className="border-t border-line bg-panel-soft p-3 text-caption text-text-muted shrink-0">
          {selectedArchiveDeleted ? (
            "Deleted action plans are read-only."
          ) : activeCount > 0 ? (
            "Save the current discussion before continuing from this recent discussion."
          ) : (
            "Recent Discussions are read-only."
          )}{" "}
          <Link href={`${pathname}?chatRoom=current`} className="font-semibold text-accent hover:underline">
            Open the current action plan
          </Link>
          .
        </div>
      ) : (
        <>
          {composerOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-3 backdrop-blur-[1px] sm:items-center sm:p-6"
              onClick={closeComposer}
            >
              <form
                ref={formRef}
                action={actionHandler}
                encType="multipart/form-data"
                onClick={(event) => event.stopPropagation()}
                className="max-h-[85vh] w-full max-w-2xl space-y-3 overflow-y-auto rounded-panel border border-line bg-panel p-card shadow-2xl"
              >
                <input type="hidden" name="projectSlug" value={projectSlug} />
                {taskId ? (
                  <input type="hidden" name="taskId" value={taskId} />
                ) : (
                  <input type="hidden" name="epicId" value={epicId} />
                )}
                <input type="hidden" name="agentSlug" value="room" />
                <input type="hidden" name="messageId" value={draftMessageId} />
                {selectedTargets.map((target: string) => (
                  <input key={target} type="hidden" name="discussionTarget" value={target} />
                ))}
                {canContinueArchive && selectedArchiveId ? (
                  <>
                    <input type="hidden" name="baseArchiveId" value={selectedArchiveId} />
                    <input type="hidden" name="continueFromArchive" value="1" />
                  </>
                ) : null}

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                      {canContinueArchive ? "Continue action plan" : "Action plan message"}
                    </div>
                    <p className="mt-1 text-caption text-text-muted">
                      Choose recipients, attach files, and send the room a message.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeComposer}
                    aria-label="Close action plan composer"
                    className="grid h-11 w-11 place-items-center rounded-lg text-heading leading-none text-text-muted transition hover:bg-panel-soft hover:text-text md:h-8 md:w-8"
                  >
                    &times;
                  </button>
                </div>

                <DiscussionRecipientPicker
                  options={targetOptions}
                  values={selectedTargets}
                  onChange={setSelectedTargets}
                  open={targetPickerOpen}
                  onOpenChange={setTargetPickerOpen}
                />

                <MaximizableTextarea
                  ref={textareaRef}
                  name="body"
                  value={messageText}
                  onValueChange={setMessageText}
                  rows={5}
                  maxLength={8000}
                  placeholder={canContinueArchive ? "Continue this action plan..." : "Message the action plan..."}
                  onKeyDown={handleKeyDown}
                  expandedTitle={canContinueArchive ? "Continue Action Plan" : "Action Plan Message"}
                  className="w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 text-caption outline-none focus:border-accent"
                />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-1.5 rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-semibold text-text-muted transition hover:border-accent hover:text-accent cursor-pointer select-none">
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    <span>{selectedFilesCount > 0 ? `${selectedFilesCount} selected` : "Attach files"}</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      onChange={(event) => setSelectedFiles(fileListFromInput(event.currentTarget))}
                      className="hidden"
                    />
                  </label>
                  {selectedFiles.length > 0 ? (
                    <div className="min-w-0 flex-1 text-micro text-text-muted" aria-live="polite">
                      <span className="font-semibold text-text">Ready to attach:</span>{" "}
                      {selectedFiles.map((file: File) => file.name).join(", ")}
                    </div>
                  ) : null}
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="rounded-lg bg-accent px-4 py-1.5 text-caption font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer select-none"
                  >
                    {canContinueArchive ? "Continue" : "Send"}
                  </button>
                </div>
              </form>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            aria-label={canContinueArchive ? "Continue action plan" : "Message action plan"}
            data-task-local-fab
            data-task-quick-action="action-plan"
            className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-3xl leading-none text-bg shadow-lg transition hover:opacity-90 max-sm:bottom-[calc(env(safe-area-inset-bottom)+1rem)] max-sm:right-4"
          >
            <span className="-mt-0.5">+</span>
          </button>
        </>
      )}
    </>
  );
});
