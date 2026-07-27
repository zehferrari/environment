"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import AsyncCombobox, { type AsyncOption } from "@/components/async-combobox";
import PrivateToggle from "@/components/private-toggle";
import { useToast } from "@/components/toast";
import { useRouteContext } from "@/components/use-route-context";
import type { CreateResult } from "@/lib/create/result";
import { createEpic } from "@/lib/epics/actions";
import {
  createProjectFromFab,
  createTaskFromFab,
  createWorkspaceFromFab,
  postCommentFromFab,
  uploadAttachmentFromFab,
} from "@/lib/create/actions";
import {
  loadProjectDefaults,
  resolvePickerOption,
  searchProjectAttachTargets,
  searchProjectEpics,
} from "@/lib/create/pickers";

export type CreateFabWorkspace = { id: string; slug: string; name: string };
export type CreateFabProject = {
  id: string;
  slug: string;
  name: string;
  workspaceId: string | null;
  workspaceSlug: string | null;
  workspaceName: string;
};

type FormKind = "workspace" | "project" | "epic" | "task" | "attachment" | "comment";

const FORM_TITLES: Record<FormKind, string> = {
  workspace: "New workspace",
  project: "New project",
  epic: "New epic",
  task: "New task",
  attachment: "Upload attachment",
  comment: "New comment",
};

// A menu row is either a form (opens a modal) or the special "plan" action
// (delegates to the on-page action-plan composer). `kind` is the discriminator.
type MenuKind = FormKind | "plan";

export default function CreateFab({
  isOwner,
  workspaces,
  projects,
  principals,
  maxAttachmentLabel,
}: {
  isOwner: boolean;
  workspaces: CreateFabWorkspace[];
  projects: CreateFabProject[];
  principals: AvatarComboboxOption[];
  maxAttachmentLabel: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const route = useRouteContext();

  const [menuOpen, setMenuOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [form, setForm] = useState<FormKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Shared workspace -> project cascade (the pickers write into this state and
  // the forms render hidden inputs from it).
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [projectSlug, setProjectSlug] = useState<string>("");
  const [defaults, setDefaults] = useState<{ defaultAssigneeId: string | null; defaultReviewerId: string | null }>(
    { defaultAssigneeId: null, defaultReviewerId: null },
  );
  // Attach/comment target parsed from the target picker (task XOR epic).
  const [attachTarget, setAttachTarget] = useState<{ taskId: string; epicId: string }>({ taskId: "", epicId: "" });
  // Pre-selected epic/task options resolved from route context.
  const [initialEpic, setInitialEpic] = useState<AsyncOption | null>(null);
  const [initialAttach, setInitialAttach] = useState<AsyncOption | null>(null);

  const projectBySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);
  const currentProject = projectSlug ? projectBySlug.get(projectSlug) ?? null : null;
  const projectId = currentProject?.id ?? "";
  const hasWorkItem = Boolean(route.taskId || route.epicId);

  // Derive workspace/project defaults from the current route whenever the menu
  // is about to be used.
  const seedContext = useCallback(() => {
    let wsId = "";
    let projSlug = "";
    const routeProject = route.projectSlug ? projectBySlug.get(route.projectSlug) : null;
    if (routeProject) {
      projSlug = routeProject.slug;
      wsId = routeProject.workspaceId ?? "";
    }
    if (!wsId && route.workspaceSlug) {
      const ws = workspaces.find((w) => w.slug === route.workspaceSlug);
      if (ws) wsId = ws.id;
    }
    setWorkspaceId(wsId);
    setProjectSlug(projSlug);
  }, [route.projectSlug, route.workspaceSlug, projectBySlug, workspaces]);

  // Load per-project defaults + resolve route epic/task labels when the chosen
  // project changes.
  useEffect(() => {
    let cancelled = false;
    if (!projectSlug) {
      setDefaults({ defaultAssigneeId: null, defaultReviewerId: null });
      return;
    }
    void loadProjectDefaults(projectSlug).then((d) => {
      if (!cancelled) setDefaults(d);
    });
    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  const openForm = useCallback(
    async (kind: FormKind) => {
      seedContext();
      setError(null);
      setDirty(false);
      setAttachTarget({ taskId: "", epicId: "" });
      setInitialEpic(null);
      setInitialAttach(null);
      setForm(kind);
      setMenuOpen(false);

      // Pre-select the epic (task form) or attach/comment target from the route.
      if (route.projectSlug && route.epicId && kind === "task") {
        const opt = await resolvePickerOption(route.projectSlug, "epic", route.epicId);
        if (opt) setInitialEpic(opt);
      }
      if (route.projectSlug && (kind === "attachment" || kind === "comment")) {
        if (route.taskId) {
          const opt = await resolvePickerOption(route.projectSlug, "task", route.taskId);
          if (opt) {
            setInitialAttach({ ...opt, value: `task:${opt.value}` });
            setAttachTarget({ taskId: route.taskId, epicId: "" });
          }
        } else if (route.epicId) {
          const opt = await resolvePickerOption(route.projectSlug, "epic", route.epicId);
          if (opt) {
            setInitialAttach({ ...opt, value: `epic:${opt.value}` });
            setAttachTarget({ taskId: "", epicId: route.epicId });
          }
        }
      }
    },
    [seedContext, route.projectSlug, route.epicId, route.taskId],
  );

  // Plan of Action delegates to the on-page action-plan composer (the rich
  // agent-chat surface). Its trigger is kept mounted but hidden by CSS inside
  // [data-task-quick-add-context]; clicking it programmatically still fires its
  // handler. If the Action Plan tab isn't active yet, click the real tab first
  // (which mounts the trigger), then open the composer.
  const openActionPlan = useCallback(() => {
    setMenuOpen(false);
    const clickComposer = () => {
      const el = document.querySelector<HTMLElement>('[data-task-quick-action="action-plan"]');
      if (el) {
        el.click();
        return true;
      }
      return false;
    };
    if (clickComposer()) return;
    const tabButton = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) =>
      (b.textContent ?? "").trim().toLowerCase().startsWith("action plan"),
    );
    tabButton?.click();
    let tries = 0;
    const timer = window.setInterval(() => {
      if (clickComposer() || ++tries > 40) window.clearInterval(timer);
    }, 50);
  }, []);

  const attemptClose = useCallback(() => {
    if (submitting) return;
    if (dirty && !window.confirm("Discard your changes?")) return;
    setForm(null);
    setError(null);
    setDirty(false);
  }, [submitting, dirty]);

  // ---- Picker loaders ------------------------------------------------------
  const workspaceLoader = useCallback(
    (query: string): Promise<AsyncOption[]> => {
      const q = query.trim().toLowerCase();
      return Promise.resolve(
        workspaces
          .filter((w) => !q || w.name.toLowerCase().includes(q) || w.slug.toLowerCase().includes(q))
          .slice(0, 30)
          .map((w) => ({ value: w.id, label: w.name, hint: w.slug })),
      );
    },
    [workspaces],
  );

  const projectLoader = useCallback(
    (query: string): Promise<AsyncOption[]> => {
      const q = query.trim().toLowerCase();
      return Promise.resolve(
        projects
          .filter((p) => !workspaceId || p.workspaceId === workspaceId)
          .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
          .slice(0, 40)
          .map((p) => ({ value: p.slug, label: p.name, hint: p.workspaceName })),
      );
    },
    [projects, workspaceId],
  );

  const epicLoader = useCallback(
    (query: string): Promise<AsyncOption[]> =>
      projectSlug ? searchProjectEpics(projectSlug, query) : Promise.resolve([]),
    [projectSlug],
  );

  const attachLoader = useCallback(
    (query: string): Promise<AsyncOption[]> =>
      projectSlug ? searchProjectAttachTargets(projectSlug, query) : Promise.resolve([]),
    [projectSlug],
  );

  // Comments must target a task or epic — drop the project-level option.
  const commentLoader = useCallback(
    (query: string): Promise<AsyncOption[]> =>
      projectSlug
        ? searchProjectAttachTargets(projectSlug, query).then((opts) => opts.filter((o) => o.value !== "project"))
        : Promise.resolve([]),
    [projectSlug],
  );

  const initialWorkspaceOption: AsyncOption | null = useMemo(() => {
    const ws = workspaces.find((w) => w.id === workspaceId);
    return ws ? { value: ws.id, label: ws.name, hint: ws.slug } : null;
  }, [workspaces, workspaceId]);

  const initialProjectOption: AsyncOption | null = useMemo(() => {
    return currentProject
      ? { value: currentProject.slug, label: currentProject.name, hint: currentProject.workspaceName }
      : null;
  }, [currentProject]);

  // ---- Submit --------------------------------------------------------------
  const submit = useCallback(
    async (action: (fd: FormData) => Promise<CreateResult>, formEl: HTMLFormElement) => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const result = await action(new FormData(formEl));
        if (result.ok) {
          setForm(null);
          setDirty(false);
          toast.show({ message: result.message, href: result.href, linkLabel: "Open" });
          router.refresh();
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, toast, router],
  );

  const onProjectChange = (slug: string) => {
    setProjectSlug(slug);
    const proj = projectBySlug.get(slug);
    if (proj?.workspaceId) setWorkspaceId(proj.workspaceId);
    setAttachTarget({ taskId: "", epicId: "" });
    setInitialEpic(null);
    setInitialAttach(null);
  };

  const routeProjectName = route.projectSlug ? projectBySlug.get(route.projectSlug)?.name ?? null : null;

  // Menu rows in the order requested: Workspace, Project, Epic, Task,
  // Attachment, Plan of Action, Comment. The last two only appear when a task
  // or epic is the current context.
  const menuItems: { kind: MenuKind; label: string; detail: string; icon: React.ReactNode; show: boolean }[] = [
    {
      kind: "workspace",
      label: "New workspace",
      detail: "Top-level workspace",
      icon: <WorkspaceIcon />,
      show: isOwner,
    },
    {
      kind: "project",
      label: "New project",
      detail: route.workspaceSlug ? "In the current workspace" : "Pick a workspace",
      icon: <ProjectIcon />,
      show: isOwner,
    },
    {
      kind: "epic",
      label: "New epic",
      detail: routeProjectName ?? "Pick a project",
      icon: <EpicIcon />,
      show: true,
    },
    {
      kind: "task",
      label: "New task",
      detail: route.epicId ? "Under the current epic" : routeProjectName ?? "Standalone or in a project",
      icon: <TaskIcon />,
      show: true,
    },
    {
      kind: "attachment",
      label: "Upload attachment",
      detail: "Task, epic, or project",
      icon: <AttachmentIcon />,
      show: true,
    },
    {
      kind: "plan",
      label: "Plan of Action",
      detail: "Message the action plan",
      icon: <ActionPlanIcon />,
      show: hasWorkItem && isOwner,
    },
    {
      kind: "comment",
      label: "Comment",
      detail: route.taskId ? "On the current task" : "On the current epic",
      icon: <CommentIcon />,
      show: hasWorkItem,
    },
  ];

  // ---- Ultra-wide placement: portal the trigger into the header/pane slot ---
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () =>
      setSlot(
        document.querySelector<HTMLElement>("[data-task-fab-slot]") ??
          document.querySelector<HTMLElement>("[data-board-controls-slot]"),
      );
    find();
    // Slots are rendered by the page; re-find shortly after navigation/paint.
    const t = setTimeout(find, 120);
    return () => clearTimeout(t);
  }, [route.projectSlug, route.taskId, route.epicId, route.workspaceSlug]);

  // ---- Menu open/close (anchored, body-portaled so it never clips) ---------
  const toggleMenu = useCallback(
    (el: HTMLElement) => {
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      setAnchorRect(el.getBoundingClientRect());
      setMenuOpen(true);
    },
    [menuOpen],
  );

  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (menuRef.current?.contains(target)) return;
      if (target?.closest?.("[data-create-fab-trigger]")) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onResize = () => setMenuOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen]);

  // Modal: Escape closes (with a dirty-confirm); clicking outside does NOT.
  useEffect(() => {
    if (!form) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        attemptClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [form, attemptClose]);

  const triggerButton = (variant: "corner" | "slot") => (
    <button
      type="button"
      data-create-fab-trigger
      onClick={(event) => toggleMenu(event.currentTarget)}
      aria-label="Create"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      className={
        variant === "corner"
          ? `grid h-14 w-14 place-items-center rounded-full bg-accent text-bg shadow-[var(--shadow-float)] transition hover:-translate-y-0.5 hover:bg-accent-strong md:h-12 md:w-12`
          : `grid h-9 w-9 place-items-center rounded-lg bg-accent text-bg shadow-[var(--shadow-sm)] transition hover:bg-accent-strong`
      }
    >
      <span className={`leading-none ${variant === "corner" ? "text-2xl" : "text-xl"} ${menuOpen ? "rotate-45" : ""} transition-transform`} aria-hidden="true">
        +
      </span>
    </button>
  );

  const menu =
    menuOpen && anchorRect
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Create or add"
            style={menuStyle(anchorRect)}
            className="overflow-y-auto rounded-xl border border-line bg-panel p-2 text-body text-text shadow-[var(--shadow-float)]"
          >
            <div className="px-2 pb-2 pt-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
              Create or add
            </div>
            {menuItems
              .filter((item) => item.show)
              .map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="menuitem"
                  onClick={() => (item.kind === "plan" ? openActionPlan() : void openForm(item.kind))}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent-soft hover:text-accent"
                >
                  <span
                    aria-hidden="true"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel-soft text-text-muted"
                  >
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{item.label}</span>
                    <span className="block truncate text-caption text-text-muted">{item.detail}</span>
                  </span>
                </button>
              ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {/* Corner FAB — hidden on ultra-wide when a header/pane slot is available. */}
      <div
        className={`fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6 ${slot ? "4xl:hidden" : ""}`}
      >
        {triggerButton("corner")}
      </div>

      {/* Ultra-wide: render the trigger inside the header controls / task-pane slot. */}
      {slot
        ? createPortal(
            <div className="hidden 4xl:block">{triggerButton("slot")}</div>,
            slot,
          )
        : null}

      {menu}

      {form ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={FORM_TITLES[form]}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-3 backdrop-blur-[1px] sm:items-center sm:p-6"
        >
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-panel border border-line bg-panel p-card shadow-2xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-heading font-semibold">{FORM_TITLES[form]}</h2>
              <button
                type="button"
                onClick={attemptClose}
                aria-label="Close"
                disabled={submitting}
                className="grid h-8 w-8 place-items-center rounded-lg text-heading leading-none text-text-muted transition hover:bg-panel-soft hover:text-text disabled:opacity-50"
              >
                &times;
              </button>
            </div>

            {error ? (
              <p role="alert" className="mb-3 rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-caption text-crit">
                {error}
              </p>
            ) : null}

            <FabForm
              form={form}
              submitting={submitting}
              submit={submit}
              onDirty={() => setDirty(true)}
              // cascade
              workspaceId={workspaceId}
              projectSlug={projectSlug}
              projectId={projectId}
              onWorkspaceChange={(id) => {
                setWorkspaceId(id);
                setProjectSlug("");
              }}
              onProjectChange={onProjectChange}
              onAttachChange={(value) => {
                if (value.startsWith("task:")) setAttachTarget({ taskId: value.slice(5), epicId: "" });
                else if (value.startsWith("epic:")) setAttachTarget({ taskId: "", epicId: value.slice(5) });
                else setAttachTarget({ taskId: "", epicId: "" });
              }}
              attachTarget={attachTarget}
              // pickers
              workspaceLoader={workspaceLoader}
              projectLoader={projectLoader}
              epicLoader={epicLoader}
              attachLoader={attachLoader}
              commentLoader={commentLoader}
              initialWorkspaceOption={initialWorkspaceOption}
              initialProjectOption={initialProjectOption}
              initialEpic={initialEpic}
              initialAttach={initialAttach}
              // roles
              isOwner={isOwner}
              principals={principals}
              defaults={defaults}
              maxAttachmentLabel={maxAttachmentLabel}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

// Position the body-portaled menu, anchored to the trigger's viewport rect.
// Opens downward from a top-of-page trigger and upward from the corner FAB;
// living on <body> means the sticky-toolbar overflow can't clip it.
function menuStyle(rect: DOMRect): React.CSSProperties {
  const width = 288;
  const gap = 8;
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openUp = spaceBelow < 360 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(200, (openUp ? spaceAbove : spaceBelow) - gap - margin);
  return openUp
    ? { position: "fixed", left, bottom: window.innerHeight - rect.top + gap, width, maxHeight, zIndex: 60 }
    : { position: "fixed", left, top: rect.bottom + gap, width, maxHeight, zIndex: 60 };
}

// The field sets per form kind. Kept in one component so all share the cascade
// props; each renders its own <form> with an id the comboboxes bind to.
function FabForm(props: {
  form: FormKind;
  submitting: boolean;
  submit: (action: (fd: FormData) => Promise<CreateResult>, formEl: HTMLFormElement) => void | Promise<void>;
  onDirty: () => void;
  workspaceId: string;
  projectSlug: string;
  projectId: string;
  onWorkspaceChange: (id: string) => void;
  onProjectChange: (slug: string) => void;
  onAttachChange: (value: string) => void;
  attachTarget: { taskId: string; epicId: string };
  workspaceLoader: (q: string) => Promise<AsyncOption[]>;
  projectLoader: (q: string) => Promise<AsyncOption[]>;
  epicLoader: (q: string) => Promise<AsyncOption[]>;
  attachLoader: (q: string) => Promise<AsyncOption[]>;
  commentLoader: (q: string) => Promise<AsyncOption[]>;
  initialWorkspaceOption: AsyncOption | null;
  initialProjectOption: AsyncOption | null;
  initialEpic: AsyncOption | null;
  initialAttach: AsyncOption | null;
  isOwner: boolean;
  principals: AvatarComboboxOption[];
  defaults: { defaultAssigneeId: string | null; defaultReviewerId: string | null };
  maxAttachmentLabel: string;
}) {
  const {
    form,
    submitting,
    submit,
    onDirty,
    workspaceId,
    projectSlug,
    projectId,
    onWorkspaceChange,
    onProjectChange,
    onAttachChange,
    attachTarget,
    workspaceLoader,
    projectLoader,
    epicLoader,
    attachLoader,
    commentLoader,
    initialWorkspaceOption,
    initialProjectOption,
    initialEpic,
    initialAttach,
    isOwner,
    principals,
    defaults,
    maxAttachmentLabel,
  } = props;

  const formRef = useRef<HTMLFormElement>(null);
  const formId = `create-fab-${form}`;
  const actionFor: Record<FormKind, (fd: FormData) => Promise<CreateResult>> = {
    workspace: createWorkspaceFromFab,
    project: createProjectFromFab,
    epic: createEpic,
    task: createTaskFromFab,
    attachment: uploadAttachmentFromFab,
    comment: postCommentFromFab,
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(actionFor[form], event.currentTarget);
  };

  const needsProject = form === "project" || form === "epic" || form === "task" || form === "attachment" || form === "comment";
  const showWorkspace = needsProject;
  const needsTarget = form === "comment";
  const targetMissing = needsTarget && !attachTarget.taskId && !attachTarget.epicId;

  return (
    <form
      id={formId}
      ref={formRef}
      onSubmit={onSubmit}
      onInput={onDirty}
      onChange={onDirty}
      className="space-y-3"
    >
      {/* --- Context cascade --------------------------------------------- */}
      {showWorkspace ? (
        <Field label={form === "project" ? "Workspace" : "Workspace (context)"}>
          <AsyncCombobox
            name="workspaceId"
            formId={formId}
            loadOptions={workspaceLoader}
            initialOption={initialWorkspaceOption}
            placeholder="Select a workspace…"
            ariaLabel="Workspace"
            allowClear={form !== "project"}
            onChange={(value) => onWorkspaceChange(value)}
          />
        </Field>
      ) : null}

      {needsProject ? (
        <Field label="Project">
          <AsyncCombobox
            name="projectSlug"
            formId={formId}
            loadOptions={projectLoader}
            initialOption={initialProjectOption}
            placeholder="Select a project…"
            ariaLabel="Project"
            resetSignal={workspaceId}
            onChange={(value) => onProjectChange(value)}
          />
          <input type="hidden" name="projectId" value={projectId} form={formId} />
        </Field>
      ) : null}

      {form === "task" ? (
        <Field label="Epic (optional)">
          <AsyncCombobox
            name="epicId"
            formId={formId}
            loadOptions={epicLoader}
            initialOption={initialEpic}
            placeholder={projectSlug ? "No epic (standalone)…" : "Choose a project first"}
            ariaLabel="Epic"
            allowClear
            disabled={!projectSlug}
            resetSignal={projectSlug}
          />
        </Field>
      ) : null}

      {form === "attachment" ? (
        <Field label="Attach to">
          <AsyncCombobox
            name="_attachTarget"
            formId={formId}
            loadOptions={attachLoader}
            initialOption={initialAttach}
            placeholder={projectSlug ? "Project-level…" : "Choose a project first"}
            ariaLabel="Attach to"
            allowClear
            disabled={!projectSlug}
            resetSignal={projectSlug}
            onChange={(value) => onAttachChange(value)}
          />
          <input type="hidden" name="taskId" value={attachTarget.taskId} form={formId} />
          <input type="hidden" name="epicId" value={attachTarget.epicId} form={formId} />
        </Field>
      ) : null}

      {form === "comment" ? (
        <Field label="On (task or epic)">
          <AsyncCombobox
            name="_commentTarget"
            formId={formId}
            loadOptions={commentLoader}
            initialOption={initialAttach}
            placeholder={projectSlug ? "Choose a task or epic…" : "Choose a project first"}
            ariaLabel="Comment on"
            disabled={!projectSlug}
            resetSignal={projectSlug}
            onChange={(value) => onAttachChange(value)}
          />
          <input type="hidden" name="taskId" value={attachTarget.taskId} form={formId} />
          <input type="hidden" name="epicId" value={attachTarget.epicId} form={formId} />
        </Field>
      ) : null}

      {/* --- Per-kind fields --------------------------------------------- */}
      {form === "workspace" ? (
        <>
          <Field label="Name">
            <TextInput name="name" required maxLength={200} placeholder="e.g. Environment" formId={formId} />
          </Field>
          <Field label="Slug (optional)">
            <TextInput name="slug" maxLength={60} placeholder="auto from name" formId={formId} mono />
          </Field>
          <Field label="Type">
            <select
              name="type"
              form={formId}
              defaultValue="internal"
              className="h-9 w-full rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
            >
              <option value="internal">Internal</option>
              <option value="client">Client</option>
              <option value="personal">Personal</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Description (optional)">
            <TextArea name="description" formId={formId} />
          </Field>
        </>
      ) : null}

      {form === "project" ? (
        <>
          <Field label="Name">
            <TextInput name="name" required maxLength={200} placeholder="e.g. Environment" formId={formId} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Slug">
              <TextInput name="slug" required placeholder="environment" formId={formId} mono />
            </Field>
            <Field label="Project key">
              <TextInput name="workItemKeyPrefix" required placeholder="ENV" formId={formId} mono />
            </Field>
          </div>
          <Field label="Repository folder">
            <TextInput name="repositoryPath" required placeholder="/srv/Code/…" formId={formId} mono />
          </Field>
          {isOwner ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Default assignee">
                <AvatarCombobox formId={formId} name="defaultAssigneeId" options={principals} emptyLabel="None" ariaLabel="Default assignee" />
              </Field>
              <Field label="Default reviewer">
                <AvatarCombobox formId={formId} name="defaultReviewerId" options={principals} emptyLabel="None" ariaLabel="Default reviewer" />
              </Field>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Git user name (optional)">
              <TextInput name="defaultGitUserName" formId={formId} />
            </Field>
            <Field label="Git user email (optional)">
              <TextInput name="defaultGitUserEmail" formId={formId} />
            </Field>
          </div>
          <Field label="Auto-archive Done after (days)">
            <TextInput name="doneTtlDays" placeholder="5" formId={formId} />
          </Field>
          <Field label="Description (optional)">
            <TextArea name="description" formId={formId} />
          </Field>
        </>
      ) : null}

      {form === "epic" ? (
        <>
          <Field label="Title">
            <TextInput name="title" required maxLength={200} placeholder="Epic title" formId={formId} />
          </Field>
          <Field label="Description (optional)">
            <TextArea name="description" formId={formId} />
          </Field>
          {isOwner ? (
            <>
              <Field label="Worker pool">
                <AvatarCombobox formId={formId} name="assigneeId" options={principals} emptyLabel="No workers" ariaLabel="Worker pool" multiple />
                <input form={formId} type="hidden" name="workerPoolSubmitted" value="1" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Acting manager">
                  <AvatarCombobox formId={formId} name="actingManagerId" options={principals} emptyLabel="None" ariaLabel="Acting manager" />
                </Field>
                <Field label="Deploy reviewer">
                  <AvatarCombobox formId={formId} name="deployReviewerId" options={principals} emptyLabel="Use Monitor" ariaLabel="Deploy reviewer" />
                </Field>
              </div>
            </>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch (optional)">
              <TextInput name="branchName" formId={formId} mono />
            </Field>
            <Field label="Commit prefix (optional)">
              <TextInput name="commitPrefix" formId={formId} mono />
            </Field>
          </div>
          {isOwner ? (
            <div className="flex items-center gap-2">
              <PrivateToggle formId={formId} defaultChecked={false} includeSubmittedField />
            </div>
          ) : null}
        </>
      ) : null}

      {form === "task" ? (
        <>
          <Field label="Title">
            <TextInput name="title" required maxLength={200} placeholder="Task title" formId={formId} />
          </Field>
          <Field label="Description (optional)">
            <TextArea name="description" formId={formId} />
          </Field>
          {isOwner ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Assignee">
                  <AvatarCombobox
                    key={`asg-${defaults.defaultAssigneeId ?? "none"}`}
                    formId={formId}
                    name="assigneeId"
                    defaultValue={defaults.defaultAssigneeId ?? ""}
                    options={principals}
                    emptyLabel="Unassigned"
                    ariaLabel="Assignee"
                  />
                </Field>
                <Field label="Reviewer">
                  <AvatarCombobox
                    key={`rev-${defaults.defaultReviewerId ?? "none"}`}
                    formId={formId}
                    name="actingManagerId"
                    defaultValue={defaults.defaultReviewerId ?? ""}
                    options={principals}
                    emptyLabel="No reviewer"
                    ariaLabel="Reviewer"
                  />
                </Field>
              </div>
              <div className="flex items-center gap-2">
                <PrivateToggle formId={formId} defaultChecked={false} includeSubmittedField />
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {form === "attachment" ? (
        <Field label={`Files (max ${maxAttachmentLabel} each)`}>
          <input
            type="file"
            name="files"
            multiple
            required
            form={formId}
            className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption file:mr-2 file:rounded file:border-0 file:bg-panel-soft file:px-2 file:py-1 file:text-caption"
          />
        </Field>
      ) : null}

      {form === "comment" ? (
        <Field label="Comment">
          <textarea
            name="body"
            form={formId}
            rows={5}
            required
            maxLength={8000}
            placeholder="Write a comment — **markdown** and @mentions supported"
            className="w-full resize-none rounded-lg border border-line bg-bg px-2 py-1.5 text-caption outline-none focus:border-accent"
          />
        </Field>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting || (needsProject && !projectSlug) || targetMissing}
          className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting ? "Saving…" : form === "comment" ? "Post comment" : "Create"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  name,
  required,
  maxLength,
  placeholder,
  formId,
  mono,
}: {
  name: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  formId: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      name={name}
      form={formId}
      required={required}
      maxLength={maxLength}
      placeholder={placeholder}
      className={`h-9 w-full rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent ${mono ? "font-mono" : ""}`}
    />
  );
}

function TextArea({ name, formId }: { name: string; formId: string }) {
  return (
    <textarea
      name={name}
      form={formId}
      rows={3}
      maxLength={8000}
      className="w-full resize-none rounded-lg border border-line bg-bg px-2 py-1.5 text-caption outline-none focus:border-accent"
    />
  );
}

// --- Menu icons (shared visual language with the task quick-add menu) -------
function WorkspaceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
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

function ActionPlanIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      <path d="m9 11 3 3L22 4" />
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
