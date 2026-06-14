"use client";

import React, { useState, useMemo, useTransition } from "react";
import Link from "next/link";
import {
  deleteDirectAgentArchive,
  restoreDirectAgentArchive,
  emptyDirectAgentChatBin,
  updateDirectAgentArchiveTitle,
} from "@/lib/agents/chat/direct/actions";
import ConfirmPopup from "@/components/confirm-popup";

type PendingPrompt =
  | { kind: "empty-bin" }
  | { kind: "delete-archive"; archiveId: string };

interface Archive {
  id: string;
  summary: string;
  startedAt: string; // ISO string
  endedAt: string; // ISO string
  parentArchiveId: string | null;
  messageCount: number;
  hasAttachments?: boolean;
  totalSizeKB?: number;
  deletedAt?: string | null;
}

interface ArchiveSidebarClientProps {
  archives: Archive[];
  binArchives: Archive[];
  slug: string;
  selectedArchiveId: string | null;
}

function formatModernDate(startedAtStr: string) {
  const d = new Date(startedAtStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  
  const time = new Intl.DateTimeFormat("en-AU", { timeStyle: "short" }).format(d);
  
  if (isToday) {
    return `Today · ${time}`;
  }
  if (isYesterday) {
    return `Yesterday · ${time}`;
  }
  
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric"
  }).format(d);
  
  return `${datePart} · ${time}`;
}

function daysUntilPurge(deletedAtStr: string) {
  const deletedAt = new Date(deletedAtStr);
  const ttlDays = 7;
  const expiry = new Date(deletedAt.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const diffMs = expiry.getTime() - Date.now();
  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return "purging soon";
  if (diffDays === 1) return "purge in 1d";
  return `purge in ${diffDays}d`;
}

export default function ArchiveSidebarClient({
  archives,
  binArchives,
  slug,
  selectedArchiveId,
}: ArchiveSidebarClientProps) {
  const [viewMode, setViewMode] = useState<"archives" | "bin">("archives");
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<PendingPrompt | null>(null);

  // Inline rename states
  const [editingArchiveId, setEditingArchiveId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState("");

  // Calendar month/year navigation state
  const latestArchiveDate = useMemo(() => {
    if (archives.length === 0) return new Date();
    return new Date(archives[0].startedAt);
  }, [archives]);

  const [currentYear, setCurrentYear] = useState(latestArchiveDate.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(latestArchiveDate.getMonth()); // 0-indexed

  // Toggle calendar view
  const [showCalendar, setShowCalendar] = useState(false);
  // Selected date filter
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);

  // Hover sync states
  const [hoveredDateStr, setHoveredDateStr] = useState<string | null>(null);
  const [hoveredArchiveId, setHoveredArchiveId] = useState<string | null>(null);

  // Filter archives by selected date
  const filteredArchives = useMemo(() => {
    if (!selectedDateStr) return archives;
    return archives.filter((archive) => {
      const dateStr = new Date(archive.startedAt).toISOString().split("T")[0];
      return dateStr === selectedDateStr;
    });
  }, [archives, selectedDateStr]);

  // Group archives by date (YYYY-MM-DD)
  const archivesByDate = useMemo(() => {
    const map = new Map<string, Archive[]>();
    for (const archive of archives) {
      const dateStr = new Date(archive.startedAt).toISOString().split("T")[0];
      const existing = map.get(dateStr) ?? [];
      existing.push(archive);
      map.set(dateStr, existing);
    }
    return map;
  }, [archives]);

  // Lookup children maps (archiveId -> list of child continuation archives)
  const childrenMap = useMemo(() => {
    const map = new Map<string, Archive[]>();
    for (const archive of archives) {
      if (archive.parentArchiveId) {
        const existing = map.get(archive.parentArchiveId) ?? [];
        existing.push(archive);
        map.set(archive.parentArchiveId, existing);
      }
    }
    return map;
  }, [archives]);

  // Generate calendar days for the currentMonth/currentYear
  const calendarDays = useMemo(() => {
    const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay(); // Day of week (0-6)
    const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate(); // Days in month (28-31)
    
    const days: Array<{ day: number | null; dateStr: string | null }> = [];
    
    // Padding for previous month
    for (let i = 0; i < firstDayIndex; i++) {
      days.push({ day: null, dateStr: null });
    }

    // Days in current month
    for (let day = 1; day <= totalDays; day++) {
      const monthStr = String(currentMonth + 1).padStart(2, "0");
      const dayStr = String(day).padStart(2, "0");
      days.push({
        day,
        dateStr: `${currentYear}-${monthStr}-${dayStr}`,
      });
    }

    return days;
  }, [currentMonth, currentYear]);

  // Navigation handlers
  const handlePrevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear((y) => y - 1);
    } else {
      setCurrentMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear((y) => y + 1);
    } else {
      setCurrentMonth((m) => m + 1);
    }
  };

  const handleSaveTitle = (archiveId: string) => {
    if (!editTitleValue.trim()) return;
    const formData = new FormData();
    formData.append("agentSlug", slug);
    formData.append("archiveId", archiveId);
    formData.append("title", editTitleValue.trim());

    startTransition(async () => {
      try {
        await updateDirectAgentArchiveTitle(formData);
        setEditingArchiveId(null);
      } catch (err) {
        console.error("Rename error", err);
      }
    });
  };

  const handleRestore = (archiveId: string) => {
    const formData = new FormData();
    formData.append("agentSlug", slug);
    formData.append("archiveId", archiveId);

    startTransition(async () => {
      try {
        await restoreDirectAgentArchive(formData);
      } catch (err) {
        console.error("Restore error", err);
      }
    });
  };

  const handleEmptyBin = () => {
    setPending({ kind: "empty-bin" });
  };

  const runEmptyBin = () => {
    const formData = new FormData();
    formData.append("agentSlug", slug);
    startTransition(async () => {
      try {
        await emptyDirectAgentChatBin(formData);
      } catch (err) {
        console.error("Empty bin error", err);
      } finally {
        setPending(null);
      }
    });
  };

  const runDeleteArchive = (archiveId: string) => {
    const formData = new FormData();
    formData.append("agentSlug", slug);
    formData.append("archiveId", archiveId);
    startTransition(async () => {
      try {
        await deleteDirectAgentArchive(formData);
      } catch (err) {
        console.error("Delete archive error", err);
      } finally {
        setPending(null);
      }
    });
  };

  const monthName = new Intl.DateTimeFormat("en-AU", { month: "long" }).format(
    new Date(currentYear, currentMonth, 1)
  );

  return (
    <aside className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm flex flex-col h-full min-h-0 select-none">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-2 shrink-0">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold">
              {viewMode === "archives" ? "Recent Chats" : "Trash Bin"}
            </p>
            {viewMode === "archives" ? (
              archives.length > 0 && (
                <span className="rounded-full bg-[var(--color-ok)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-ok)]">
                  {archives.length}
                </span>
              )
            ) : (
              binArchives.length > 0 && (
                <span className="rounded-full bg-[var(--color-crit)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-crit)]">
                  {binArchives.length}
                </span>
              )
            )}
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            {viewMode === "archives" ? "Recent conversations" : "Deleted conversations"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {viewMode === "archives" && (
            <button
              onClick={() => setShowCalendar(!showCalendar)}
              className={`rounded-md border p-1 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors cursor-pointer ${
                showCalendar
                  ? "border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  : "border-[var(--color-line)] bg-[var(--color-panel-soft)]"
              }`}
              title={showCalendar ? "Hide Calendar" : "Show Calendar"}
            >
              {showCalendar ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m2 2 20 20"/>
                </svg>
              )}
            </button>
          )}

          <Link
            href={`/agents/${slug}/chat`}
            className={`rounded-md border px-2 py-1 text-xs font-medium transition-all ${
              selectedArchiveId === null && !selectedDateStr && viewMode === "archives"
                ? "border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-line)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            }`}
          >
            Active
          </Link>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-1 text-xs font-semibold shrink-0">
        <button
          type="button"
          onClick={() => {
            setViewMode("archives");
            setSelectedDateStr(null);
          }}
          className={`rounded-lg px-2 py-1.5 transition ${
            viewMode === "archives"
              ? "bg-[var(--color-panel)] text-[var(--color-text)] shadow-sm"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          Recent <span className="text-[10px] text-[var(--color-text-muted)]">({archives.length})</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setViewMode("bin");
            setSelectedDateStr(null);
          }}
          className={`rounded-lg px-2 py-1.5 transition ${
            viewMode === "bin"
              ? "bg-[var(--color-panel)] text-[var(--color-text)] shadow-sm"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          Bin <span className="text-[10px] text-[var(--color-text-muted)]">({binArchives.length})</span>
        </button>
      </div>

      {/* Mini Calendar View */}
      {viewMode === "archives" && showCalendar && (
        <div className="mb-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-2 shrink-0">
          {/* Calendar Nav */}
          <div className="flex items-center justify-between mb-1.5">
            <button
              onClick={handlePrevMonth}
              className="p-0.5 rounded hover:bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <span className="text-[11px] font-bold text-[var(--color-text)]">
              {monthName} {currentYear}
            </span>
            <button
              onClick={handleNextMonth}
              className="p-0.5 rounded hover:bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>

          {/* Days Header */}
          <div className="grid grid-cols-7 gap-0.5 text-center text-[9px] font-bold text-[var(--color-text-muted)] mb-0.5">
            <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
          </div>

          {/* Days Grid */}
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {calendarDays.map((cell, idx) => {
              if (!cell.day || !cell.dateStr) {
                return <div key={`empty-${idx}`} className="h-5.5 w-5.5" />;
              }

              const dayArchives = archivesByDate.get(cell.dateStr) ?? [];
              const hasChat = dayArchives.length > 0;
              const isHovered = hoveredDateStr === cell.dateStr;
              const isArchiveHoverActive = dayArchives.some(a => a.id === hoveredArchiveId);
              const isSelected = selectedDateStr === cell.dateStr;

              return (
                <div
                  key={cell.dateStr}
                  onMouseEnter={() => hasChat && setHoveredDateStr(cell.dateStr)}
                  onMouseLeave={() => setHoveredDateStr(null)}
                  onClick={() => hasChat && setSelectedDateStr(isSelected ? null : cell.dateStr)}
                  className={`relative h-5.5 w-5.5 rounded-md flex items-center justify-center text-[10px] font-medium transition-all ${
                    hasChat
                      ? isSelected
                        ? "bg-[var(--color-accent)] text-white font-bold"
                        : "bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-semibold border border-[var(--color-accent)]/20 cursor-pointer hover:bg-[var(--color-accent)] hover:text-white"
                      : "text-[var(--color-text-muted)]/60"
                  } ${
                    isHovered || isArchiveHoverActive
                      ? "ring-1 ring-[var(--color-accent)] scale-110 shadow-sm z-10"
                      : ""
                  }`}
                  title={hasChat ? `${dayArchives.length} chat${dayArchives.length === 1 ? "" : "s"} on this day` : undefined}
                >
                  {cell.day}
                  {hasChat && (
                    <span className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 h-0.5 w-0.5 rounded-full ${isSelected ? "bg-white" : "bg-[var(--color-accent)]"}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Date Filter Selected Banner */}
      {viewMode === "archives" && selectedDateStr && (
        <div className="mb-3 rounded-lg border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/10 px-3 py-1.5 flex items-center justify-between text-xs text-[var(--color-accent)] font-semibold shrink-0">
          <span>Active on: {selectedDateStr}</span>
          <button
            onClick={() => setSelectedDateStr(null)}
            className="hover:underline font-bold cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      {/* Flat List of Archives */}
      <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-3 scrollbar-thin">
        {viewMode === "archives" ? (
          filteredArchives.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">No recent chats match.</p>
          ) : (
            filteredArchives.map((archive) => {
              const selected = selectedArchiveId === archive.id;
              const dayDateStr = new Date(archive.startedAt).toISOString().split("T")[0];
              const isDateHoverActive = hoveredDateStr === dayDateStr;
              const isCardHovered = hoveredArchiveId === archive.id;

              const children = childrenMap.get(archive.id) ?? [];
              const hasChildren = children.length > 0;
              const isEditing = editingArchiveId === archive.id;

              return (
                <div
                  key={archive.id}
                  onMouseEnter={() => setHoveredArchiveId(archive.id)}
                  onMouseLeave={() => setHoveredArchiveId(null)}
                  className={`rounded-xl border p-2 transition-all duration-200 shadow-sm relative group ${
                    selected
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.04] shadow-[var(--color-accent)]/[0.02]"
                      : "border-[var(--color-line)] bg-[var(--color-panel-soft)] hover:border-[var(--color-accent)]/30 hover:bg-[var(--color-panel)]"
                  } ${
                    isDateHoverActive || isCardHovered
                      ? "ring-1 ring-[var(--color-accent)]/40 border-[var(--color-accent)]/40 scale-[1.01]"
                      : ""
                  }`}
                >
                  {isEditing ? (
                    <div className="space-y-2 py-1">
                      <input
                        type="text"
                        disabled={isPending}
                        value={editTitleValue}
                        onChange={(e) => setEditTitleValue(e.target.value)}
                        className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveTitle(archive.id);
                          if (e.key === "Escape") setEditingArchiveId(null);
                        }}
                        autoFocus
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => setEditingArchiveId(null)}
                          className="rounded border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2 py-0.5 text-[9px] font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] transition cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => handleSaveTitle(archive.id)}
                          className="rounded bg-[var(--color-accent)] px-2.5 py-0.5 text-[9px] font-medium text-[var(--color-bg)] hover:opacity-90 transition cursor-pointer"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <Link href={`/agents/${slug}/chat?archive=${archive.id}`} className="block">
                        <span className="text-[9px] font-semibold text-[var(--color-text-muted)] tracking-wider block mb-0.5">
                          {formatModernDate(archive.startedAt)}
                        </span>
                        
                        <div className="flex items-start justify-between gap-1.5 mb-1.5">
                          <p className="line-clamp-2 text-[11px] font-semibold text-[var(--color-text)] leading-relaxed flex-1">
                            {archive.summary}
                          </p>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setEditingArchiveId(archive.id);
                              setEditTitleValue(archive.summary);
                            }}
                            className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-opacity p-0.5 rounded hover:bg-[var(--color-panel)] cursor-pointer"
                            title="Rename Archive"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                            </svg>
                          </button>
                        </div>
                      </Link>

                      <div className="flex items-center justify-between text-[9px] text-[var(--color-text-muted)] border-t border-[var(--color-line)]/40 pt-1.5 shrink-0">
                        <span className="flex items-center gap-1.5">
                          <span>
                            {archive.messageCount} msg{archive.messageCount === 1 ? "" : "s"}
                          </span>
                          {archive.hasAttachments && (
                            <span className="text-[var(--color-accent)] flex items-center" title="Has attachments">
                              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                              </svg>
                            </span>
                          )}
                          {archive.totalSizeKB !== undefined && (
                            <span className="bg-[var(--color-panel)] border border-[var(--color-line)] px-1 rounded text-[8px] font-mono font-semibold" title="Total memory size including attachments">
                              {archive.totalSizeKB} KB
                            </span>
                          )}
                        </span>
                        
                        <button
                          type="button"
                          disabled={hasChildren || isPending}
                          onClick={() => setPending({ kind: "delete-archive", archiveId: archive.id })}
                          aria-label={hasChildren ? "Cannot delete parent of a continuation" : "Delete archived chat"}
                          title={hasChildren ? "Cannot delete: this archive has active continuation children" : "Delete archived chat"}
                          className={`rounded px-1.5 py-0.5 text-[8px] font-medium transition-all ${
                            hasChildren
                              ? "bg-[var(--color-line)]/20 text-[var(--color-text-muted)]/40 border border-transparent cursor-not-allowed"
                              : "border border-[var(--color-line)] text-[var(--color-text-muted)] hover:border-[var(--color-crit)] hover:bg-[var(--color-crit)]/[0.04] hover:text-[var(--color-crit)] cursor-pointer"
                          }`}
                        >
                          {hasChildren ? "Locked" : "Delete"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )
        ) : (
          binArchives.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">Trash bin is empty.</p>
          ) : (
            binArchives.map((archive) => {
              const selected = selectedArchiveId === archive.id;
              return (
                <div
                  key={archive.id}
                  className={`rounded-xl border p-2 transition-all duration-200 shadow-sm relative ${
                    selected
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/[0.04] shadow-[var(--color-accent)]/[0.02]"
                      : "border-[var(--color-line)] bg-[var(--color-panel-soft)] hover:border-[var(--color-accent)]/30"
                  }`}
                >
                  <Link href={`/agents/${slug}/chat?archive=${archive.id}`} className="block">
                    <span className="text-[9px] font-semibold text-[var(--color-text-muted)] tracking-wider block mb-0.5">
                      {formatModernDate(archive.startedAt)}
                    </span>
                    <p className="line-clamp-2 text-[11px] font-semibold text-[var(--color-text)] leading-relaxed mb-1.5">
                      {archive.summary}
                    </p>
                  </Link>

                  <div className="flex items-center justify-between text-[9px] text-[var(--color-text-muted)] border-t border-[var(--color-line)]/40 pt-1.5 shrink-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span>
                        {archive.messageCount} msg{archive.messageCount === 1 ? "" : "s"}
                      </span>
                      {archive.hasAttachments && (
                        <span className="text-[var(--color-accent)] flex items-center" title="Has attachments">
                          <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                          </svg>
                        </span>
                      )}
                      {archive.totalSizeKB !== undefined && (
                        <span className="bg-[var(--color-panel)] border border-[var(--color-line)] px-1 rounded text-[8px] font-mono font-semibold" title="Total memory size including attachments">
                          {archive.totalSizeKB} KB
                        </span>
                      )}
                      <span className="text-[var(--color-crit)] font-semibold font-mono bg-[var(--color-crit)]/[0.06] border border-[var(--color-crit)]/10 px-1.5 py-0.5 rounded-md">
                        {daysUntilPurge(archive.deletedAt!)}
                      </span>
                    </span>

                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleRestore(archive.id)}
                      className="rounded border border-[var(--color-accent)]/30 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/[0.04] px-1.5 py-0.5 text-[8px] font-semibold cursor-pointer disabled:opacity-50"
                    >
                      Restore
                    </button>
                  </div>
                </div>
              );
            })
          )
        )}
      </div>

      {/* Empty Bin Button at bottom of Bin View */}
      {viewMode === "bin" && binArchives.length > 0 && (
        <div className="pt-3 border-t border-[var(--color-line)] mt-3 shrink-0">
          <button
            type="button"
            disabled={isPending}
            onClick={handleEmptyBin}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-crit)]/30 bg-[var(--color-crit)]/[0.04] py-2 text-xs font-semibold text-[var(--color-crit)] hover:bg-[var(--color-crit)]/[0.08] transition cursor-pointer disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>
            </svg>
            [Empty Bin]
          </button>
        </div>
      )}

      <ConfirmPopup
        open={pending !== null}
        title={
          pending?.kind === "empty-bin"
            ? "Empty the trash bin"
            : pending?.kind === "delete-archive"
              ? "Move archive to bin"
              : ""
        }
        description={
          pending?.kind === "empty-bin"
            ? "Permanently empty the bin? This will erase all soft-deleted chats and files and cannot be undone."
            : pending?.kind === "delete-archive"
              ? "Move this archive to the bin? It will be permanently deleted in 7 days."
              : null
        }
        confirmLabel={pending?.kind === "empty-bin" ? "Empty Bin" : "Move to bin"}
        danger
        busy={isPending}
        onConfirm={() => {
          if (pending?.kind === "empty-bin") runEmptyBin();
          else if (pending?.kind === "delete-archive") runDeleteArchive(pending.archiveId);
        }}
        onCancel={() => setPending(null)}
      />
    </aside>
  );
}
