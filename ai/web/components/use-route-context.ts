"use client";

import { usePathname } from "next/navigation";

// Derive the current work-item context from the URL so the unified create FAB
// can pre-select its Workspace / Project / Epic / Task comboboxes. Kept as a
// pure parser (exported for tests) plus a hook wrapper.
//
// Route shapes handled:
//   /workspaces/<slug>[/...]                       -> workspaceSlug
//   /projects/<slug>[/...]                          -> projectSlug
//   /projects/<slug>/epics/<epicId>[/...]           -> projectSlug + epicId
//   /projects/<slug>/tasks/<taskId>[/...]           -> projectSlug + taskId
// The workspace for a project is resolved by the FAB from its projects list
// (the URL doesn't carry it), so projectSlug is enough here.

export type RouteContext = {
  workspaceSlug: string | null;
  projectSlug: string | null;
  epicId: string | null;
  taskId: string | null;
};

// Segments under /projects that are list views, not real project slugs.
const NON_PROJECT_SEGMENTS = new Set(["archive", "bin"]);

export function parseRouteContext(pathname: string | null): RouteContext {
  const ctx: RouteContext = {
    workspaceSlug: null,
    projectSlug: null,
    epicId: null,
    taskId: null,
  };
  if (!pathname) return ctx;
  const segments = pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  if (segments[0] === "workspaces" && segments[1]) {
    ctx.workspaceSlug = segments[1];
  }

  if (segments[0] === "projects" && segments[1] && !NON_PROJECT_SEGMENTS.has(segments[1])) {
    ctx.projectSlug = segments[1];
    if (segments[2] === "epics" && segments[3]) ctx.epicId = segments[3];
    if (segments[2] === "tasks" && segments[3]) ctx.taskId = segments[3];
  }

  return ctx;
}

export function useRouteContext(): RouteContext {
  return parseRouteContext(usePathname());
}
