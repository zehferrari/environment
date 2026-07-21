"use client";

import { usePathname, useRouter } from "next/navigation";

// ENV-110 split workspace: hosts the intercepted task-detail route beside the
// board once the @container/ws content area is wide enough. Thresholds are
// container widths, not viewport widths: 146rem (2336px) fits the 1120px
// pane beside a >=1200px board; 185rem (2960px) widens the pane to 1200px
// while keeping room for six >=284px board tracks. Below 146rem the pane
// takes the full content width and the board (children slot) is hidden via
// group-has, which visually matches the plain task route. Pathname guard:
// parallel-route slots keep their previous content on soft navigation, so
// the pane must render nothing once the URL leaves /tasks/[taskId].
export default function WorkspacePane({
  slug,
  children,
}: {
  slug: string;
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
      className="min-w-0 @min-[146rem]/ws:w-[70rem] @min-[146rem]/ws:shrink-0 @min-[185rem]/ws:w-[75rem]"
    >
      <div className="hidden items-center justify-end pb-2 @min-[146rem]/ws:flex">
        <button
          type="button"
          onClick={() => router.push(`/projects/${slug}`)}
          className="rounded-lg px-2.5 py-1 text-caption font-medium text-text-muted transition hover:bg-panel-soft hover:text-text"
          aria-label="Close task workspace"
        >
          Close ×
        </button>
      </div>
      {children}
    </section>
  );
}
