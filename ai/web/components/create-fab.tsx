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

type FormKind = "workspace" | "project" | "epic" | "task" | "attachment";

const FORM_TITLES: Record<FormKind, string> = {
  workspace: "New workspace",
  project: "New project",
  epic: "New epic",
  task: "New task",
  attachment: "Upload attachment",
};

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
  const [form, setForm] = useState<FormKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared workspace -> project cascade (the pickers write into this state and
  // the forms render hidden inputs from it).
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [projectSlug, setProjectSlug] = useState<string>("");
  const [defaults, setDefaults] = useState<{ defaultAssigneeId: string | null; defaultReviewerId: string | null }>(
    { defaultAssigneeId: null, defaultReviewerId: null },
  );
  // Attachment target parsed from the attach-to picker.
  const [attachTarget, setAttachTarget] = useState<{ taskId: string; epicId: string }>({ taskId: "", epicId: "" });
  // Pre-selected epic/task options resolved from route context.
  const [initialEpic, setInitialEpic] = useState<AsyncOption | null>(null);
  const [initialAttach, setInitialAttach] = useState<AsyncOption | null>(null);

  const projectBySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);
  const currentProject = projectSlug ? projectBySlug.get(projectSlug) ?? null : null;
  const projectId = currentProject?.id ?? "";

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
      setAttachTarget({ taskId: "", epicId: "" });
      setInitialEpic(null);
      setInitialAttach(null);
      setForm(kind);
      setMenuOpen(false);

      // Pre-select the epic (task form) or attach target (attachment form) from
      // the current route.
      if (route.projectSlug && route.epicId && kind === "task") {
        const opt = await resolvePickerOption(route.projectSlug, "epic", route.epicId);
        if (opt) setInitialEpic(opt);
      }
      if (route.projectSlug && kind === "attachment") {
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

  const closeForm = useCallback(() => {
    if (submitting) return;
    setForm(null);
    setError(null);
  }, [submitting]);

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

  const menuItems: { kind: FormKind; label: string; show: boolean }[] = [
    { kind: "task", label: "New task", show: true },
    { kind: "epic", label: "New epic", show: true },
    { kind: "attachment", label: "Upload attachment", show: true },
    { kind: "project", label: "New project", show: isOwner },
    { kind: "workspace", label: "New workspace", show: isOwner },
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

  const triggerButton = (variant: "corner" | "slot") => (
    <button
      type="button"
      onClick={() => setMenuOpen((v) => !v)}
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
    menuOpen ? (
      <div
        role="menu"
        className="absolute bottom-[calc(100%+0.6rem)] right-0 w-60 overflow-hidden rounded-xl border border-line bg-panel p-1.5 text-body shadow-[var(--shadow-float)]"
      >
        {menuItems
          .filter((item) => item.show)
          .map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              onClick={() => void openForm(item.kind)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-caption text-text transition hover:bg-panel-soft"
            >
              <span aria-hidden="true" className="text-accent">+</span>
              {item.label}
            </button>
          ))}
      </div>
    ) : null;

  // Task- and epic-detail pages keep their own richer quick-add FAB (which also
  // carries comment / action-plan / attachment), so the unified create FAB
  // steps aside there to avoid a second floating affordance.
  if (route.taskId || route.epicId) return null;

  return (
    <>
      {/* Corner FAB — hidden on ultra-wide when a header/pane slot is available. */}
      <div
        className={`fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6 ${slot ? "4xl:hidden" : ""}`}
      >
        <div className="relative">
          {menu}
          {triggerButton("corner")}
        </div>
      </div>

      {/* Ultra-wide: render the trigger inside the header controls / task-pane slot. */}
      {slot
        ? createPortal(
            <div className="relative hidden 4xl:block">
              {menu}
              {triggerButton("slot")}
            </div>,
            slot,
          )
        : null}

      {form ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-3 backdrop-blur-[1px] sm:items-center sm:p-6"
          onClick={closeForm}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-panel border border-line bg-panel p-card shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-heading font-semibold">{FORM_TITLES[form]}</h2>
              <button
                type="button"
                onClick={closeForm}
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

// The field sets per form kind. Kept in one component so all share the cascade
// props; each renders its own <form> with an id the comboboxes bind to.
function FabForm(props: {
  form: FormKind;
  submitting: boolean;
  submit: (action: (fd: FormData) => Promise<CreateResult>, formEl: HTMLFormElement) => void | Promise<void>;
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
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit(actionFor[form], event.currentTarget);
  };

  const needsProject = form === "project" || form === "epic" || form === "task" || form === "attachment";
  const showWorkspace = form === "project" || form === "epic" || form === "task" || form === "attachment";

  return (
    <form id={formId} ref={formRef} onSubmit={onSubmit} className="space-y-3">
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

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={submitting || (needsProject && !projectSlug)}
          className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting ? "Creating…" : "Create"}
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
