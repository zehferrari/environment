"use client";

import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { archiveChatRoom, getAgentChatRoomMessages, sendAgentChatMessage, deleteChatMessage, restoreChatMessage } from "@/lib/agents/chat-actions";
import ChatBubble from "@/components/chat-bubble";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import MaximizableTextarea from "@/components/maximizable-textarea";
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
import { generateClientMessageId } from "@/lib/agents/client-message-id";
import { getMessageGroupState, messageParticipantKey } from "@/lib/agents/message-grouping";

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

interface DiscussionTarget {
  value: string;
  label: string;
  group: "Groups" | "Users" | "Agents";
  actor?: MessageActor | null;
}

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
  currentUserId?: string | null;
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
}: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  hasActiveHistory: boolean;
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
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        disabled={!hasActiveHistory}
        onClick={() => {
          setStep("choice");
          setCustomTitle("");
          setOpen(true);
        }}
        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
      >
        New Action Plan
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => !isPending && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            {step === "choice" ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--color-text)]">
                    Start a fresh room
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-lg leading-none text-[var(--color-text-muted)] transition hover:text-[var(--color-text)] cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">
                  Archive the current room to keep the transcript, or move it to the bin and clear this Task/Epic chat.
                </p>
                <div className="grid gap-2">
                  <button
                    type="button"
                    onClick={() => setStep("archive")}
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-left text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] cursor-pointer"
                  >
                    Archive current room
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runArchive(true)}
                    className="rounded-lg border border-[var(--color-crit)]/30 bg-[var(--color-crit)]/[0.04] px-3 py-2 text-left text-sm font-medium text-[var(--color-crit)] transition hover:bg-[var(--color-crit)]/[0.08] cursor-pointer"
                  >
                    {isPending ? "Moving to bin..." : "Move current room to bin"}
                  </button>
                </div>
              </div>
            ) : null}

            {step === "archive" ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--color-text)]">
                    Archive room
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-lg leading-none text-[var(--color-text-muted)] transition hover:text-[var(--color-text)] cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <label className="block space-y-1.5 text-xs font-medium text-[var(--color-text-muted)]">
                  <span>Archive title</span>
                  <input
                    type="text"
                    disabled={isPending}
                    value={customTitle}
                    onChange={(event) => setCustomTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") runArchive(false);
                    }}
                    placeholder="Optional title"
                    className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)] disabled:opacity-50"
                  />
                </label>
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setStep("choice")}
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50 cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runArchive(false)}
                    className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-bg)] transition hover:opacity-90 disabled:opacity-50 cursor-pointer"
                  >
                    {isPending ? "Archiving..." : "Archive room"}
                  </button>
                </div>
              </div>
            ) : null}

            {step === "delete" ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--color-crit)]">
                    Move room to bin
                  </h3>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setOpen(false)}
                    className="text-lg leading-none text-[var(--color-text-muted)] transition hover:text-[var(--color-text)] cursor-pointer"
                  >
                    &times;
                  </button>
                </div>
                <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">
                  This clears the active room and keeps the deleted transcript until the retention purge runs.
                </p>
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setStep("choice")}
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50 cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => runArchive(true)}
                    className="rounded-lg bg-[var(--color-crit)] px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50 cursor-pointer"
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

export default function ChatRoom({
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
  currentUserId = null,
  pendingProposals = [],
}: ChatRoomProps) {
  const pathname = usePathname();
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
  const [composerOpen, setComposerOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [bottomReservation, setBottomReservation] = useState(88);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>(
    defaultDiscussionTarget ? [defaultDiscussionTarget] : [],
  );
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [archiveSidebarOpen, setArchiveSidebarOpen] = useState(false);
  // Only surface the archive affordances when there is something to show: hide
  // the sidebar toggle entirely when both lists are empty, and within the
  // sidebar show each sub-tab only when it has items.
  const hasArchives = archives.length > 0;
  const hasBinArchives = binArchives.length > 0;
  const hasAnyArchive = hasArchives || hasBinArchives;
  const [archiveViewMode, setArchiveViewMode] = useState<"archives" | "bin">(
    !hasArchives && hasBinArchives ? "bin" : "archives",
  );
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
  const selectedTargetOptions = selectedTargets
    .map((value) => targetOptions.find((target) => target.value === value))
    .filter((target): target is DiscussionTarget => Boolean(target));
  const targetButtonLabel = selectedTargetOptions.length === 0
    ? "Default recipient"
    : selectedTargetOptions.map((target) => target.label).join(", ");

  function toggleTarget(target: DiscussionTarget) {
    setSelectedTargets((current) => {
      if (target.group === "Groups") {
        return current.includes(target.value) ? [] : [target.value];
      }
      const withoutGroups = current.filter((value) => {
        const option = targetOptions.find((candidate) => candidate.value === value);
        return option?.group !== "Groups";
      });
      if (withoutGroups.includes(target.value)) {
        return withoutGroups.filter((value) => value !== target.value);
      }
      return [...withoutGroups, target.value];
    });
  }

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
  }, [epicId, projectSlug, taskId, viewingArchive]);

  const closeComposer = () => {
    setComposerOpen(false);
    setTargetPickerOpen(false);
  };

  return (
    <div className="relative flex h-[calc(100dvh-14rem)] min-h-[620px] flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text)]">
            {taskId ? "Task Chat Room" : "Epic Chat Room"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasAnyArchive ? (
            <button
              type="button"
              onClick={() => setArchiveSidebarOpen((open) => !open)}
              className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer"
              aria-label={archiveSidebarOpen ? "Hide action plan archives" : "Show action plan archives"}
              title={archiveSidebarOpen ? "Hide action plan archives" : "Show action plan archives"}
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
          ) : null}
          {viewingArchive ? (
            <span className="hidden text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider font-semibold sm:inline">
              Archived Room
            </span>
          ) : null}
          {viewingArchive ? (
            <Link
              href={`${pathname}?chatRoom=current`}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Current Room
            </Link>
          ) : (
            <RoomArchiveButton
              projectSlug={projectSlug}
              taskId={taskId}
              epicId={epicId}
              hasActiveHistory={(activeMessageCount ?? visibleMessages.length) > 0}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
      {archiveSidebarOpen ? (
        <aside className="order-2 flex w-[min(22rem,42vw)] min-w-[18rem] flex-col border-l border-[var(--color-line)] bg-[var(--color-panel)] shadow-[-18px_0_35px_rgba(15,23,42,0.06)]">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-2">
            <div>
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-semibold text-[var(--color-text)]">
                  {archiveViewMode === "archives" ? "Archived action plans" : "Action plan bin"}
                </p>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  archiveViewMode === "archives"
                    ? "bg-[var(--color-ok)]/10 text-[var(--color-ok)]"
                    : "bg-[var(--color-crit)]/10 text-[var(--color-crit)]"
                }`}>
                  {archiveViewMode === "archives" ? archives.length : binArchives.length}
                </span>
              </div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                {archiveViewMode === "archives" ? "Latest rooms" : "Deleted rooms"}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setArchiveSidebarOpen(false)}
                className="grid h-7 w-7 place-items-center rounded-md border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer"
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
          <div className={`grid gap-1 border-b border-[var(--color-line)] bg-[var(--color-panel-soft)] p-1.5 text-xs font-semibold ${
            hasArchives && hasBinArchives ? "grid-cols-2" : "grid-cols-1"
          }`}>
            {hasArchives ? (
              <button
                type="button"
                onClick={() => setArchiveViewMode("archives")}
                className={`rounded-lg px-2 py-1.5 transition ${
                  archiveViewMode === "archives"
                    ? "bg-[var(--color-panel)] text-[var(--color-text)] shadow-sm"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                Archive <span className="text-[10px] text-[var(--color-text-muted)]">({archives.length})</span>
              </button>
            ) : null}
            {hasBinArchives ? (
              <button
                type="button"
                onClick={() => setArchiveViewMode("bin")}
                className={`rounded-lg px-2 py-1.5 transition ${
                  archiveViewMode === "bin"
                    ? "bg-[var(--color-panel)] text-[var(--color-text)] shadow-sm"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                Bin <span className="text-[10px] text-[var(--color-text-muted)]">({binArchives.length})</span>
              </button>
            ) : null}
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-3">
            <Link
              href={`${pathname}?chatRoom=current`}
              className={`block rounded-lg border px-3 py-2 text-xs transition ${
                !viewingArchive
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.08] text-[var(--color-text)]"
                  : "border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              }`}
            >
              <span className="font-semibold">Current action plan</span>
              <span className="mt-1 block text-[10px] uppercase tracking-wider">
                {activeCount} message{activeCount === 1 ? "" : "s"}
              </span>
            </Link>

            {archiveViewMode === "archives" ? (
              archives.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[var(--color-line)] p-3 text-center text-xs text-[var(--color-text-muted)]">
                  No archived action plans.
                </p>
              ) : (
                <div className="space-y-3">
                  {archives.map((archive) => {
                    const selected = selectedArchiveId === archive.id && !selectedArchiveDeleted;
                    return (
                      <Link
                        key={archive.id}
                        href={`${pathname}?chatArchive=${archive.id}`}
                        className={`block rounded-xl border p-2 text-xs shadow-sm transition ${
                          selected
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.04] text-[var(--color-text)]"
                            : "border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]/30 hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <span className="mb-0.5 block text-[9px] font-semibold tracking-wider text-[var(--color-text-muted)]">
                          {formatModernDate(archive.startedAt)}
                        </span>
                        <span className="block truncate font-semibold">{archive.summary}</span>
                        <span className="mt-1 block border-t border-[var(--color-line)]/40 pt-1 text-[10px] uppercase tracking-wider">
                          {archive.messageCount} message{archive.messageCount === 1 ? "" : "s"}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )
            ) : binArchives.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[var(--color-line)] p-3 text-center text-xs text-[var(--color-text-muted)]">
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
                        className={`block rounded-xl border p-2 text-xs shadow-sm transition ${
                          selected
                            ? "border-[var(--color-crit)] bg-[var(--color-crit)]/[0.06] text-[var(--color-text)]"
                            : "border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[var(--color-text-muted)] hover:border-[var(--color-crit)]/50 hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <span className="mb-0.5 block text-[9px] font-semibold tracking-wider text-[var(--color-text-muted)]">
                          {formatModernDate(archive.startedAt)}
                        </span>
                        <span className="block truncate font-semibold">{archive.summary}</span>
                        <span className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--color-line)]/40 pt-1 text-[10px] uppercase tracking-wider">
                          <span>
                          {archive.messageCount} message{archive.messageCount === 1 ? "" : "s"}
                          </span>
                          {purgeLabel ? (
                            <span className="rounded-md border border-[var(--color-crit)]/10 bg-[var(--color-crit)]/[0.06] px-1.5 py-0.5 font-mono font-semibold text-[var(--color-crit)] normal-case">
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
      ) : null}

      <div className="order-1 flex min-w-0 flex-1 flex-col">
      {/* Messages List */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 min-h-0 scrollbar-thin"
      >
        <div ref={scrollContentRef}>
        {displayedMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 border border-dashed border-[var(--color-line)] rounded-xl bg-[var(--color-panel-soft)]/20">
            <span className="text-xl">💬</span>
            <p className="mt-2 text-xs font-semibold text-[var(--color-text)]">
              Welcome to the Chat Room!
            </p>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)] max-w-[280px]">
              Post a message to invoke default assignees/reviewers, or use <code className="px-1 py-0.5 rounded bg-[var(--color-panel-soft)] font-mono text-[var(--color-accent)]">@agent</code> to mention specific agents.
            </p>
          </div>
        ) : (
          displayedMessages.map((m, index) => {
            const groupState = getMessageGroupState(displayedMessages, index);
            if (m.deletedAt) {
              // Soft-deleted action-plan bubble (HOMELAB-41 / item 2).
              // Restore (↺) only offered when viewing the live room —
              // archived views stay read-only. Agents never see these
              // in their context until restored.
              return (
                <DeletedMessageDivider
                  key={m.id}
                  deletedAt={m.deletedAt}
                  deletedBy={m.deletedBy ?? null}
                  restore={!viewingArchive ? {
                    action: restoreChatMessage,
                    fields: { projectSlug, messageId: m.id },
                  } : undefined}
                >
                  <span>{m.body}</span>
                </DeletedMessageDivider>
              );
            }
            return (
              <ChatBubble
                key={m.id}
                message={m}
                currentUserId={currentUserId}
                projectSlug={projectSlug}
                surface={taskId ? "task-chat" : "epic-chat"}
                resolvedOption={pmOptionResolutions.get(m.id) ?? null}
                preferShortAgentSections
                participantIndex={participantIndexes.get(messageParticipantKey(m.sender)) ?? 0}
                isGroupStart={groupState.isGroupStart}
                isGroupEnd={groupState.isGroupEnd}
                isGroupedContinuation={groupState.isGroupedContinuation}
                className={groupState.isGroupedContinuation ? "mt-1" : "mt-6 first:mt-0"}
                deliveryStatus={(m as OptimisticMessage).optimisticStatus}
                actions={(m as OptimisticMessage).optimisticStatus === "failed" ? (
                  <button
                    type="button"
                    onClick={() => retryOptimisticMessage(m as OptimisticMessage)}
                    className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
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
                    className="text-[12px] font-bold text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 hover:text-[var(--color-crit)] cursor-pointer"
                  />
                ) : null}
              />
            );
          })
        )}

        {/* Streaming Replies */}
        {!viewingArchive && activeLatestMessageId && activePendingAgents.map((agent) => (
          <StreamingAgentReply
            key={`${activeLatestMessageId}:${agent.slug}`}
            targetKind={taskId ? "task-chat" : "epic-chat"}
            agentSlug={agent.slug}
            messageId={activeLatestMessageId}
            taskId={taskId}
            epicId={epicId}
            label={agent.username}
            anonymizeTyping
            onFinal={async ({ text, status }) => {
              if (status !== "done") return;
              setLocalPendingAgents((current) => current.filter((item) => item.slug !== agent.slug));
              if (text.trim()) {
                setStreamFinalMessages((current) => [
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
          />
        ))}

        {/* Proposal Reviews */}
        {!viewingArchive && pendingProposals.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-line)] pt-4">
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

      {showJumpToLatest ? (
        <button
          type="button"
          onClick={() => scheduleScrollToLatest(true)}
          className="fixed bottom-24 right-6 z-40 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-xs font-semibold text-[var(--color-text)] shadow-lg transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          Jump to latest
        </button>
      ) : null}

      {/* Input Form */}
      {viewingArchive && !canContinueArchive ? (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3 text-xs text-[var(--color-text-muted)] shrink-0">
          {selectedArchiveDeleted ? (
            "Deleted action plans are read-only."
          ) : activeCount > 0 ? (
            "Archive the current action plan before continuing from this archived action plan."
          ) : (
            "Archived action plans are read-only."
          )}{" "}
          <Link href={`${pathname}?chatRoom=current`} className="font-semibold text-[var(--color-accent)] hover:underline">
            Open the current action plan
          </Link>
          .
        </div>
      ) : (
        <>
          {composerOpen ? (
            <div
              className="fixed inset-0 z-50 bg-black/10 p-4 backdrop-blur-[1px]"
              onClick={closeComposer}
            >
              <form
                ref={formRef}
                action={actionHandler}
                encType="multipart/form-data"
                onClick={(event) => event.stopPropagation()}
                className="absolute bottom-24 right-4 w-[calc(100vw-2rem)] max-w-2xl space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-2xl sm:right-6"
              >
                <input type="hidden" name="projectSlug" value={projectSlug} />
                {taskId ? (
                  <input type="hidden" name="taskId" value={taskId} />
                ) : (
                  <input type="hidden" name="epicId" value={epicId} />
                )}
                <input type="hidden" name="agentSlug" value="room" />
                {selectedTargets.map((target) => (
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
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      {canContinueArchive ? "Continue action plan" : "Action plan message"}
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      Choose recipients, attach files, and send the room a message.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeComposer}
                    aria-label="Close action plan composer"
                    className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
                  >
                    &times;
                  </button>
                </div>

                <div className="relative text-xs text-[var(--color-text-muted)]">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-semibold">To</span>
                    {selectedTargets.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setSelectedTargets([])}
                        className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setTargetPickerOpen((open) => !open)}
                    className="flex min-h-10 w-full items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-left text-xs text-[var(--color-text)] outline-none transition hover:border-[var(--color-accent)]"
                    aria-expanded={targetPickerOpen}
                  >
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      {selectedTargetOptions.length === 0 ? (
                        <span className="text-[var(--color-text-muted)]">Default recipient</span>
                      ) : selectedTargetOptions.map((target) => (
                        <span
                          key={target.value}
                          className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1"
                        >
                          {target.actor ? <MessageAvatar actor={target.actor} size="sm" /> : <span className="grid h-7 w-7 place-items-center rounded-full border border-[var(--color-line)] text-[10px] font-semibold">G</span>}
                          <span className="max-w-[9rem] truncate">{target.label}</span>
                        </span>
                      ))}
                    </span>
                    <span className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">
                      {targetPickerOpen ? "▴" : "▾"}
                    </span>
                  </button>
                  <span className="sr-only">{targetButtonLabel}</span>
                  {targetPickerOpen ? (
                    <div className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-2 shadow-2xl">
                      {["Groups", "Users", "Agents"].map((group) => {
                        const options = targetOptions.filter((target) => target.group === group);
                        if (options.length === 0) return null;
                        return (
                          <div key={group} className="py-1">
                            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                              {group}
                            </div>
                            <div className="space-y-1">
                              {options.map((target) => {
                                const selected = selectedTargets.includes(target.value);
                                return (
                                  <button
                                    key={target.value}
                                    type="button"
                                    onClick={() => toggleTarget(target)}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                                      selected
                                        ? "bg-[var(--color-accent)]/[0.12] text-[var(--color-text)]"
                                        : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
                                    }`}
                                  >
                                    {target.actor ? <MessageAvatar actor={target.actor} size="sm" /> : <span className="grid h-7 w-7 place-items-center rounded-full border border-[var(--color-line)] text-[10px] font-semibold">G</span>}
                                    <span className="min-w-0 flex-1 truncate">{target.actor ? actorDisplayName(target.actor) : target.label}</span>
                                    <span className="text-[10px] font-semibold uppercase tracking-wider">
                                      {selected ? "Selected" : target.group}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

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
                  className="w-full resize-none rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)]"
                />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer select-none">
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
                    <div className="min-w-0 flex-1 text-[11px] text-[var(--color-text-muted)]" aria-live="polite">
                      <span className="font-semibold text-[var(--color-text)]">Ready to attach:</span>{" "}
                      {selectedFiles.map((file: File) => file.name).join(", ")}
                    </div>
                  ) : null}
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-bg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer select-none"
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
            className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-3xl leading-none text-[var(--color-bg)] shadow-lg transition hover:opacity-90"
          >
            <span className="-mt-0.5">+</span>
          </button>
        </>
      )}
      </div>
      </div>
    </div>
  );
}
