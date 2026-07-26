"use client";

import { createContext, useContext } from "react";
import { usePathname, useRouter } from "next/navigation";

// The pane knows which board hosts the open task; the close control lives in
// the task form header (a client component nested in the server-rendered
// children), so the destination travels down as context rather than a prop.
const TaskCloseHrefContext = createContext<string | null>(null);

export function useTaskCloseHref(fallback: string) {
  return useContext(TaskCloseHrefContext) ?? fallback;
}

// Hosts an intercepted task-detail route beside either a project or workspace
// board once the @container/ws content area is wide enough. Thresholds are
// container widths, not viewport widths: 146rem (2336px) fits the 1120px
// pane beside a >=1200px board; 185rem (2960px) widens the pane to 1200px
// while keeping room for six >=284px board tracks. Below 146rem the pane
// takes the full content width and the board (children slot) is hidden via
// group-has, which visually matches the plain task route. Pathname guard:
// parallel-route slots keep their previous content on soft navigation, so
// the pane must render nothing once the URL leaves /tasks/[taskId].
export default function WorkspacePane({
  closeHref,
  children,
}: {
  closeHref: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const open = /\/tasks\/[^/]+\/?$/.test(pathname);
  if (!open) return null;
  return (
    <section
      data-ws-open
      aria-label="Task detail workspace"
      className="relative min-w-0 4xl:sticky 4xl:top-[var(--board-sticky-top)] 4xl:flex 4xl:h-[var(--board-available-height)] 4xl:max-h-[var(--board-available-height)] 4xl:flex-col 4xl:overflow-hidden @min-[146rem]/ws:w-[70rem] @min-[146rem]/ws:shrink-0 @min-[185rem]/ws:w-[75rem]"
    >
      {/* The split pane owns its close chrome: the form's own overhang button
          would be clipped by this section's overflow-hidden, so instead a round
          × sits on the pane's own top-right corner, above the scrolling body
          and never clipped. Ultra-wide only, matching the form's button. */}
      <button
        type="button"
        onClick={() => router.push(closeHref)}
        aria-label="Close task"
        title="Close"
        className="absolute right-3 top-3 z-40 hidden h-9 w-9 place-items-center rounded-full border border-crit/40 bg-crit text-on-crit shadow-[var(--shadow-md)] ring-2 ring-panel transition hover:scale-105 hover:opacity-90 4xl:grid"
      >
        <span className="text-xl leading-none" aria-hidden="true">×</span>
      </button>
      <div
        data-task-pane-scroll
        className="4xl:min-h-0 4xl:flex-1 4xl:overflow-hidden"
      >
        <TaskCloseHrefContext.Provider value={closeHref}>
          {children}
        </TaskCloseHrefContext.Provider>
      </div>
      <div
        data-task-fab-slot
        className="pointer-events-none fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6 4xl:absolute 4xl:bottom-4 4xl:right-4"
      />
    </section>
  );
}
