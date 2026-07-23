"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import AttachmentUploadFab, { type AttachmentUploadTarget } from "@/components/attachment-upload-fab";

type ProjectOption = { slug: string; name: string; workspaceName: string };

type WorkspacesCreateFabProps = {
  isOwner: boolean;
  projects: ProjectOption[];
  maxAttachmentLabel: string;
  uploadAttachmentAction: (formData: FormData) => Promise<void>;
  createWorkspaceAction: (formData: FormData) => Promise<void>;
};

type PickerView = "epic" | "task" | "attachment";

// (+) speed-dial on the /workspaces landing board. Workspace/Project/Epic/
// Task reuse the existing creation flows (modal here, /projects?newProject=1,
// and the ?newEpic=1 / ?newTask=1 auto-open hooks on the target project);
// Attachments uploads project-scoped files through the shared upload modal.
// When a task route is open (including the ultra-wide side pane) the task
// page's own quick-add FAB takes over with task/epic attachment targets,
// comment, and action-plan actions, so this trigger hides itself.
export default function WorkspacesCreateFab({
  isOwner,
  projects,
  maxAttachmentLabel,
  uploadAttachmentAction,
  createWorkspaceAction,
}: WorkspacesCreateFabProps) {
  const pathname = usePathname();
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuWasOpenRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState<PickerView | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [attachmentProject, setAttachmentProject] = useState<ProjectOption | null>(null);

  const taskOpen = /\/tasks\/[^/]+\/?$/.test(pathname ?? "");

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
    setPicker(null);
    if (menuWasOpenRef.current) {
      menuWasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [menuOpen]);

  const attachmentTargets = useMemo<AttachmentUploadTarget[]>(
    () => attachmentProject
      ? [{ value: "project", label: `Project · ${attachmentProject.name}` }]
      : [],
    [attachmentProject],
  );

  if (taskOpen) return null;

  const pickProject = (project: ProjectOption) => {
    setMenuOpen(false);
    if (picker === "epic") {
      router.push(`/projects/${project.slug}/epics?newEpic=1`);
    } else if (picker === "task") {
      router.push(`/projects/${project.slug}?newTask=1`);
    } else if (picker === "attachment") {
      setAttachmentProject(project);
    }
  };

  const pickerTitle = picker === "epic"
    ? "New epic — choose a project"
    : picker === "task"
      ? "New task — choose a project"
      : "Attachments — choose a project";

  return (
    <div
      ref={menuRef}
      data-workspaces-create
      className="pointer-events-auto fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6"
    >
      {menuOpen ? (
        <div
          id="workspaces-create-menu"
          role="menu"
          aria-label="Create or add"
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
          {picker === null ? (
            <>
              <div className="px-2 pb-2 pt-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                Create or add
              </div>
              {isOwner ? (
                <MenuButton
                  label="New workspace"
                  detail="Group projects and agent pools"
                  icon={<WorkspaceIcon />}
                  onSelect={() => {
                    setMenuOpen(false);
                    setWorkspaceOpen(true);
                  }}
                />
              ) : (
                <MenuDisabled label="New workspace" detail="Mission Control owner only" icon={<WorkspaceIcon />} />
              )}
              {isOwner ? (
                <MenuLink href="/projects?newProject=1" label="New project" detail="Create in a workspace" icon={<ProjectIcon />} onSelect={() => setMenuOpen(false)} />
              ) : (
                <MenuDisabled label="New project" detail="Mission Control owner only" icon={<ProjectIcon />} />
              )}
              <MenuButton label="New epic" detail="Choose a project first" icon={<EpicIcon />} onSelect={() => setPicker("epic")} />
              <MenuButton label="New task" detail="Choose a project first" icon={<TaskIcon />} onSelect={() => setPicker("task")} />
              <MenuButton label="Attachments" detail="Upload to a project" icon={<AttachmentIcon />} onSelect={() => setPicker("attachment")} />
            </>
          ) : (
            <>
              <div className="px-2 pb-2 pt-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                {pickerTitle}
              </div>
              {projects.length === 0 ? (
                <div className="px-3 py-2 text-caption text-text-muted">No accessible projects yet.</div>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {projects.map((project) => (
                    <MenuButton
                      key={project.slug}
                      label={project.name}
                      detail={project.workspaceName}
                      icon={<ProjectIcon />}
                      onSelect={() => pickProject(project)}
                    />
                  ))}
                </div>
              )}
              <MenuButton label="Back" detail="Return to create menu" icon={<BackIcon />} onSelect={() => setPicker(null)} />
            </>
          )}
        </div>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((current) => !current)}
        aria-label="Open create and add menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls="workspaces-create-menu"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-bg shadow-[var(--shadow-float)] transition-[transform,background-color,box-shadow] hover:-translate-y-0.5 hover:bg-accent-strong md:h-12 md:w-12"
      >
        <span className={`text-2xl leading-none transition-transform ${menuOpen ? "rotate-45" : ""}`} aria-hidden="true">+</span>
      </button>

      {attachmentProject ? (
        <AttachmentUploadFab
          projectSlug={attachmentProject.slug}
          maxLabel={maxAttachmentLabel}
          uploadAction={uploadAttachmentAction}
          targets={attachmentTargets}
          open
          onOpenChange={(open) => {
            if (!open) setAttachmentProject(null);
          }}
          hideTrigger
        />
      ) : null}

      {workspaceOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-card"
          onClick={() => setWorkspaceOpen(false)}
        >
          <form
            action={createWorkspaceAction}
            onClick={(event) => event.stopPropagation()}
            className="max-h-[calc(100vh-2rem)] w-full max-w-lg space-y-3 overflow-y-auto rounded-panel border border-line bg-panel p-card-lg shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                New workspace
              </div>
              <button
                type="button"
                onClick={() => setWorkspaceOpen(false)}
                aria-label="Close"
                className="text-heading leading-none text-text-muted hover:text-text"
              >
                ×
              </button>
            </div>
            <input
              name="name"
              required
              autoFocus
              maxLength={200}
              placeholder="Workspace name"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent"
            />
            <input
              name="slug"
              required
              pattern="[a-z0-9]+([._-][a-z0-9]+)*"
              placeholder="workspace-slug"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-body outline-none focus:border-accent"
            />
            <label className="block text-caption">
              <span className="mb-1 block text-text-muted">Type</span>
              <select
                name="type"
                defaultValue="internal"
                className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption outline-none focus:border-accent"
              >
                <option value="internal">Internal</option>
                <option value="client">Client</option>
                <option value="personal">Personal</option>
                <option value="other">Other</option>
              </select>
            </label>
            <textarea
              name="description"
              rows={3}
              placeholder="Description (optional)"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body leading-relaxed outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setWorkspaceOpen(false)}
                className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-body font-medium hover:border-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg hover:opacity-90"
              >
                Create workspace
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function MenuLink({
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
      <MenuGlyph icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </Link>
  );
}

function MenuButton({ label, detail, icon, onSelect }: { label: string; detail: string; icon: React.ReactNode; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent-soft hover:text-accent"
    >
      <MenuGlyph icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

function MenuDisabled({ label, detail, icon }: { label: string; detail: string; icon: React.ReactNode }) {
  return (
    <span role="menuitem" aria-disabled="true" className="flex items-center gap-3 rounded-lg px-3 py-2.5 opacity-45">
      <MenuGlyph icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-caption text-text-muted">{detail}</span>
      </span>
    </span>
  );
}

function MenuGlyph({ icon }: { icon: React.ReactNode }) {
  return (
    <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel-soft text-text-muted">
      {icon}
    </span>
  );
}

function WorkspaceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
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

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18-6-6 6-6" />
      <path d="M3 12h14" />
    </svg>
  );
}
