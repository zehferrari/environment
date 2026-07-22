"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AttachmentUploadFab, { type AttachmentUploadTarget } from "@/components/attachment-upload-fab";
import CommentComposerFab from "@/components/comment-composer-fab";
import { useActiveTab } from "@/components/task-tabs";

type TaskQuickAddFabProps = {
  projectSlug: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  epicId?: string;
  epicTitle?: string;
  canCreateProject: boolean;
  maxAttachmentLabel: string;
  uploadAttachmentAction: (formData: FormData) => Promise<void>;
  createCommentAction: (formData: FormData) => Promise<void>;
};

export default function TaskQuickAddFab({
  projectSlug,
  projectName,
  taskId,
  taskTitle,
  epicId,
  epicTitle,
  canCreateProject,
  maxAttachmentLabel,
  uploadAttachmentAction,
  createCommentAction,
}: TaskQuickAddFabProps) {
  const pathname = usePathname();
  const activeTab = useActiveTab();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuWasOpenRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [paneSlot, setPaneSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setPaneSlot(document.querySelector<HTMLElement>("[data-task-fab-slot]"));
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (menuOpen) {
      menuWasOpenRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        menuRef.current
          ?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
          ?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (menuWasOpenRef.current) {
      menuWasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [menuOpen]);

  const attachmentTargets = useMemo<AttachmentUploadTarget[]>(() => [
    { value: "task", label: `Task · ${taskTitle}`, taskId },
    ...(epicId ? [{ value: "epic" as const, label: `Epic · ${epicTitle ?? "Parent epic"}`, epicId }] : []),
    { value: "project", label: `Project · ${projectName}` },
  ], [epicId, epicTitle, projectName, taskId, taskTitle]);

  const newTaskHref = `/projects/${projectSlug}?newTask=1${epicId ? `&epicId=${encodeURIComponent(epicId)}` : ""}`;

  const openActionPlanComposer = () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-task-quick-add-context] [data-task-quick-action="action-plan"]',
    );
    setMenuOpen(false);
    trigger?.click();
  };

  const content = (
    <div
      ref={menuRef}
      data-task-quick-add
      className={paneSlot
        ? "pointer-events-auto relative"
        : "pointer-events-auto fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6"}
    >
      {menuOpen ? (
        <div
          id="task-quick-add-menu"
          role="menu"
          aria-label="Add to Mission Control"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
            if (items.length === 0) return;
            event.preventDefault();
            const current = items.indexOf(document.activeElement as HTMLElement);
            const next = event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : event.key === "ArrowUp"
                  ? (current <= 0 ? items.length - 1 : current - 1)
                  : (current + 1) % items.length;
            items[next]?.focus();
          }}
          className="absolute bottom-[calc(100%+0.75rem)] right-0 w-72 overflow-hidden rounded-xl border border-line bg-panel p-2 text-body text-text shadow-[var(--shadow-float)]"
        >
          <div className="px-2 pb-2 pt-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
            Create or add
          </div>
          {canCreateProject ? (
            <QuickAddLink href="/projects?newProject=1" label="New project" detail="Create in a workspace" onSelect={() => setMenuOpen(false)} />
          ) : (
            <QuickAddDisabled label="New project" detail="Mission Control owner only" />
          )}
          <QuickAddLink href={`/projects/${projectSlug}/epics?newEpic=1`} label="New epic" detail={projectName} onSelect={() => setMenuOpen(false)} />
          <QuickAddLink href={newTaskHref} label="New task" detail={epicId ? `Defaults to ${epicTitle ?? "parent epic"}` : projectName} onSelect={() => setMenuOpen(false)} />
          <QuickAddButton
            label="Attachments"
            detail="Choose task, parent epic, or project"
            onSelect={() => {
              setMenuOpen(false);
              setAttachmentOpen(true);
            }}
          />
          <QuickAddButton
            label="Comment"
            detail={`On ${taskTitle}`}
            onSelect={() => {
              setMenuOpen(false);
              setCommentOpen(true);
            }}
          />
          {activeTab === "Action Plan" ? (
            <QuickAddButton label="Action plan message" detail="Continue the open task discussion" onSelect={openActionPlanComposer} />
          ) : null}
        </div>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((current) => !current)}
        aria-label="Open create and add menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls="task-quick-add-menu"
        className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-bg shadow-[var(--shadow-float)] transition-[transform,background-color,box-shadow] hover:-translate-y-0.5 hover:bg-accent-strong md:h-12"
      >
        <span className={`text-2xl leading-none transition-transform ${menuOpen ? "rotate-45" : ""}`} aria-hidden="true">+</span>
        <span className="text-body font-semibold">Add</span>
      </button>

      <AttachmentUploadFab
        projectSlug={projectSlug}
        maxLabel={maxAttachmentLabel}
        uploadAction={uploadAttachmentAction}
        targets={attachmentTargets}
        open={attachmentOpen}
        onOpenChange={setAttachmentOpen}
        hideTrigger
      />
      <CommentComposerFab
        projectSlug={projectSlug}
        taskId={taskId}
        action={createCommentAction}
        title="Task Comment"
        placeholder="Write a comment — **markdown** and @mentions supported"
        open={commentOpen}
        onOpenChange={setCommentOpen}
        hideTrigger
      />
    </div>
  );

  return paneSlot ? createPortal(content, paneSlot) : content;
}

function QuickAddLink({
  href,
  label,
  detail,
  onSelect,
}: {
  href: string;
  label: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onSelect}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition hover:bg-accent-soft hover:text-accent"
    >
      <QuickAddGlyph />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </Link>
  );
}

function QuickAddButton({ label, detail, onSelect }: { label: string; detail: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent-soft hover:text-accent"
    >
      <QuickAddGlyph />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

function QuickAddDisabled({ label, detail }: { label: string; detail: string }) {
  return (
    <span role="menuitem" aria-disabled="true" className="flex items-center gap-3 rounded-lg px-3 py-2.5 opacity-45">
      <QuickAddGlyph />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </span>
  );
}

function QuickAddGlyph() {
  return (
    <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel-soft text-lg font-medium">
      +
    </span>
  );
}
