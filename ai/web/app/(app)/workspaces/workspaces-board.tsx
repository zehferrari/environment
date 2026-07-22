"use client";

// Unified cross-workspace task board (ENV-111). Renders every accessible
// workspace as a colour-bordered group; each project inside it shows its
// tasks on a translucent tint of the project colour. Filtering is pure
// client-side state — the server page already scoped the data to the viewer,
// so narrowing the view never needs a round trip.

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { fallbackBoardColor, hexWithAlpha } from "@/lib/board-colors";

export type BoardTask = {
  id: string;
  title: string;
  status: string;
  workItemKey: string | null;
  parentTaskId: string | null;
};

export type BoardProject = {
  id: string;
  slug: string;
  name: string;
  backgroundColor: string | null;
  tasks: BoardTask[];
};

export type BoardWorkspace = {
  id: string;
  slug: string;
  name: string;
  type: string;
  borderColor: string | null;
  projects: BoardProject[];
};

const PROJECT_TINT_ALPHA = 0.12;

function statusPillClass(status: string) {
  switch (status) {
    case "In Progress":
      return "border-ok/50 bg-ok/10 text-ok";
    case "Review":
      return "border-amber-500/60 bg-amber-500/10 text-amber-700";
    case "Done":
      return "border-lime-500/60 bg-lime-500/10 text-lime-700";
    case "To Do":
      return "border-accent/40 bg-accent-soft text-accent";
    default:
      return "border-line bg-panel-soft text-text-muted";
  }
}

export default function WorkspacesBoard({
  workspaces,
  isOwner,
}: {
  workspaces: BoardWorkspace[];
  isOwner: boolean;
}) {
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");

  // Projects can belong to several workspaces; dedupe by slug for the
  // filter options and the (+) menu project picker.
  const allProjects = useMemo(() => {
    const seen = new Map<string, { slug: string; name: string }>();
    for (const workspace of workspaces) {
      if (workspaceFilter && workspace.slug !== workspaceFilter) continue;
      for (const project of workspace.projects) {
        if (!seen.has(project.slug)) seen.set(project.slug, { slug: project.slug, name: project.name });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [workspaces, workspaceFilter]);

  // Keep the project filter coherent when the workspace filter narrows the
  // option list underneath it.
  useEffect(() => {
    if (projectFilter && !allProjects.some((project) => project.slug === projectFilter)) {
      setProjectFilter("");
    }
  }, [allProjects, projectFilter]);

  const visibleWorkspaces = useMemo(() => {
    return workspaces
      .filter((workspace) => !workspaceFilter || workspace.slug === workspaceFilter)
      .map((workspace) => ({
        ...workspace,
        projects: workspace.projects.filter(
          (project) => !projectFilter || project.slug === projectFilter,
        ),
      }))
      .filter((workspace) => (projectFilter ? workspace.projects.length > 0 : true));
  }, [workspaces, workspaceFilter, projectFilter]);

  const singleWorkspace = visibleWorkspaces.length === 1 ? visibleWorkspaces[0] : null;
  const hasFilter = Boolean(workspaceFilter || projectFilter);
  const selectCls =
    "rounded-lg border border-line bg-bg px-control-x py-control-y text-caption outline-none focus:border-accent";

  return (
    <section aria-label="Unified task board" className="space-y-card">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">
              Workspace
            </span>
            <select
              value={workspaceFilter}
              onChange={(event) => setWorkspaceFilter(event.currentTarget.value)}
              className={selectCls}
            >
              <option value="">All workspaces</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.slug}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">
              Project
            </span>
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.currentTarget.value)}
              className={selectCls}
            >
              <option value="">All projects</option>
              {allProjects.map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {hasFilter ? (
            <button
              type="button"
              onClick={() => {
                setWorkspaceFilter("");
                setProjectFilter("");
              }}
              className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent"
            >
              Clear filters
            </button>
          ) : null}
        </div>
        {singleWorkspace && isOwner ? (
          <Link
            href={`/workspaces/${singleWorkspace.slug}/settings`}
            aria-label={`${singleWorkspace.name} workspace settings`}
            title={`${singleWorkspace.name} settings`}
            className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel text-text-muted shadow-sm hover:border-accent hover:text-accent"
          >
            <GearIcon />
          </Link>
        ) : null}
      </div>

      {visibleWorkspaces.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line bg-panel p-card text-body text-text-muted">
          No workspaces match the current filters.
          <button
            type="button"
            onClick={() => {
              setWorkspaceFilter("");
              setProjectFilter("");
            }}
            className="ml-2 font-medium text-accent hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="space-y-card">
          {visibleWorkspaces.map((workspace) => {
            const borderColor = workspace.borderColor ?? fallbackBoardColor(workspace.id);
            return (
              <section
                key={workspace.id}
                aria-label={`${workspace.name} workspace`}
                className="rounded-panel border-2 bg-panel p-card shadow-sm"
                style={{ borderColor }}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: borderColor }} />
                  <Link
                    href={`/workspaces/${workspace.slug}`}
                    className="text-base font-semibold tracking-tight hover:text-accent"
                  >
                    {workspace.name}
                  </Link>
                  <span className="rounded-full border border-line bg-panel-soft px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-text-muted">
                    {workspace.type}
                  </span>
                  <span className="text-caption text-text-muted">/{workspace.slug}</span>
                </div>

                {workspace.projects.length === 0 ? (
                  <p className="rounded-panel border border-dashed border-line p-4 text-caption text-text-muted">
                    No active projects in this workspace.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-card lg:grid-cols-2 2xl:grid-cols-3">
                    {workspace.projects.map((project) => (
                      <ProjectGroup key={project.id} workspace={workspace} project={project} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <CreateMenu isOwner={isOwner} projects={allProjects} />
    </section>
  );
}

function ProjectGroup({
  workspace,
  project,
}: {
  workspace: BoardWorkspace;
  project: BoardProject;
}) {
  const tint = hexWithAlpha(project.backgroundColor ?? fallbackBoardColor(project.id), PROJECT_TINT_ALPHA);
  return (
    <section
      aria-label={`${project.name} tasks`}
      className="rounded-panel border border-line p-3"
      style={{ backgroundColor: tint }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          href={`/projects/${project.slug}`}
          className="truncate text-body font-semibold tracking-tight hover:text-accent"
        >
          {project.name}
        </Link>
        <span className="shrink-0 text-nano uppercase tracking-wider text-text-muted">
          {project.tasks.length} task{project.tasks.length === 1 ? "" : "s"}
        </span>
      </div>
      {project.tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-panel/60 px-3 py-2 text-caption text-text-muted">
          No tasks yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {project.tasks.map((task) => (
            <li key={task.id} className="rounded-lg border border-line bg-panel px-3 py-2 shadow-sm">
              <div className={`flex items-start justify-between gap-2 ${task.parentTaskId ? "ml-4 border-l-2 border-line pl-3" : ""}`}>
                <Link
                  href={`/projects/${project.slug}/tasks/${task.id}`}
                  className="min-w-0 flex-1 text-body font-medium text-text hover:text-accent"
                >
                  {task.parentTaskId ? <span className="mr-1 text-text-muted" aria-hidden="true">↳</span> : null}
                  {task.workItemKey ? (
                    <span className="mr-1.5 font-mono text-caption text-text-muted">{task.workItemKey}</span>
                  ) : null}
                  {task.title}
                </Link>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-nano font-semibold uppercase tracking-wider ${statusPillClass(task.status)}`}
                >
                  {task.status}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-text-muted">
                <Link href={`/workspaces/${workspace.slug}`} className="hover:text-accent hover:underline">
                  {workspace.name}
                </Link>
                <Link href={`/projects/${project.slug}`} className="hover:text-accent hover:underline">
                  {project.name}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// (+) button at the bottom of the board. Workspace/Project reuse the existing
// creation flows (#new-workspace form on this page, /projects?newProject=1
// modal); Epic/Task first ask for a target project, then hand off to that
// project's own FAB via the ?newEpic=1 / ?newTask=1 auto-open hooks.
function CreateMenu({
  isOwner,
  projects,
}: {
  isOwner: boolean;
  projects: Array<{ slug: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pickFor, setPickFor] = useState<"task" | "epic" | null>(null);
  const [pickedProject, setPickedProject] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setPickFor(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setPickFor(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setPickFor(null);
    setPickedProject("");
  };

  const itemCls =
    "block w-full rounded-lg px-3 py-2 text-left text-body text-text hover:bg-panel-soft focus-visible:bg-panel-soft outline-none";

  return (
    <div ref={containerRef} className="relative flex justify-center pb-2">
      {open ? (
        <div className="absolute bottom-full mb-2 w-64 rounded-panel border border-line bg-panel p-2 shadow-2xl">
          {pickFor === null ? (
            <div role="menu" aria-label="Create menu" className="space-y-0.5">
              {isOwner ? (
                <a role="menuitem" href="#new-workspace" onClick={close} className={itemCls}>
                  New workspace
                </a>
              ) : null}
              {isOwner ? (
                <Link role="menuitem" href="/projects?newProject=1" onClick={close} className={itemCls}>
                  New project
                </Link>
              ) : null}
              <button role="menuitem" type="button" onClick={() => setPickFor("epic")} className={itemCls}>
                New epic…
              </button>
              <button role="menuitem" type="button" onClick={() => setPickFor("task")} className={itemCls}>
                New task…
              </button>
            </div>
          ) : (
            <form
              className="space-y-2 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (!pickedProject) return;
                const target =
                  pickFor === "epic"
                    ? `/projects/${pickedProject}/epics?newEpic=1`
                    : `/projects/${pickedProject}?newTask=1`;
                close();
                router.push(target);
              }}
            >
              <div className="text-nano font-semibold uppercase tracking-wider text-text-muted">
                New {pickFor} — choose a project
              </div>
              {projects.length === 0 ? (
                <p className="text-caption text-text-muted">No accessible projects yet.</p>
              ) : (
                <select
                  autoFocus
                  required
                  value={pickedProject}
                  onChange={(event) => setPickedProject(event.currentTarget.value)}
                  className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent"
                >
                  <option value="" disabled>
                    Select a project…
                  </option>
                  {projects.map((project) => (
                    <option key={project.slug} value={project.slug}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPickFor(null)}
                  className="rounded-lg border border-line px-3 py-1.5 text-caption font-medium text-text-muted hover:text-text"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={!pickedProject}
                  className="rounded-lg bg-accent px-3 py-1.5 text-caption font-semibold text-bg hover:opacity-90 disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Create workspace, project, epic, or task"
        onClick={() => (open ? close() : setOpen(true))}
        className="grid h-11 w-11 place-items-center rounded-full bg-accent text-2xl font-semibold leading-none text-bg shadow-lg hover:opacity-90"
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
