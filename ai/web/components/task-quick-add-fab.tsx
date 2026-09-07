"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AttachmentUploadFab, { type AttachmentUploadTarget } from "@/components/attachment-upload-fab";
import CommentComposerFab from "@/components/comment-composer-fab";
import { useActiveTab } from "@/components/task-tabs";
import { openVisibleActionPlanComposer } from "@/lib/client/action-plan-composer";

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
    setMenuOpen(false);
    openVisibleActionPlanComposer();
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
            <QuickAddLink href="/projects?newProject=1" label="New project" detail="Create in a workspace" icon={<ProjectIcon />} onSelect={() => setMenuOpen(false)} />
          ) : (
            <QuickAddDisabled label="New project" detail="Mission Control owner only" icon={<ProjectIcon />} />
          )}
          <QuickAddLink href={`/projects/${projectSlug}/epics?newEpic=1`} label="New epic" detail={projectName} icon={<EpicIcon />} onSelect={() => setMenuOpen(false)} />
          <QuickAddLink href={newTaskHref} label="New task" detail={epicId ? `Defaults to ${epicTitle ?? "parent epic"}` : projectName} icon={<TaskIcon />} onSelect={() => setMenuOpen(false)} />
          <QuickAddButton
            label="Attachments"
            detail="Choose task, parent epic, or project"
            icon={<AttachmentIcon />}
            onSelect={() => {
              setMenuOpen(false);
              setAttachmentOpen(true);
            }}
          />
          <QuickAddButton
            label="Comment"
            detail={`On ${taskTitle}`}
            icon={<CommentIcon />}
            onSelect={() => {
              setMenuOpen(false);
              setCommentOpen(true);
            }}
          />
          {activeTab === "Action Plan" ? (
            <QuickAddButton label="Action plan message" detail="Continue the open task discussion" icon={<ActionPlanIcon />} onSelect={openActionPlanComposer} />
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
        className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-bg shadow-[var(--shadow-float)] transition-[transform,background-color,box-shadow] hover:-translate-y-0.5 hover:bg-accent-strong md:h-12 md:w-12"
      >
        <span className={`text-2xl leading-none transition-transform ${menuOpen ? "rotate-45" : ""}`} aria-hidden="true">+</span>
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
  icon,
  onSelect,
}: {
  href: string;
  label: string;
  detail: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onSelect}
      className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition hover:bg-accent-soft hover:text-accent"
    >
      <QuickAddGlyph icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </Link>
  );
}

function QuickAddButton({ label, detail, icon, onSelect }: { label: string; detail: string; icon: React.ReactNode; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent-soft hover:text-accent"
    >
      <QuickAddGlyph icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

function QuickAddDisabled({ label, detail, icon }: { label: string; detail: string; icon: React.ReactNode }) {
  return (
    <span role="menuitem" aria-disabled="true" className="flex items-center gap-3 rounded-lg px-3 py-2.5 opacity-45">
      <QuickAddGlyph icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </span>
  );
}

function QuickAddGlyph({ icon }: { icon: React.ReactNode }) {
  return (
    <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel-soft text-text-muted">
      {icon}
    </span>
  );
}

function ProjectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function EpicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <path d="M4 22v-7" />
    </svg>
  );
}

function TaskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function AttachmentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ActionPlanIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}
