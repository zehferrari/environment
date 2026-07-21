"use client";

import { usePathname, useRouter } from "next/navigation";

// ENV-110 split workspace: hosts the intercepted task-detail route beside the
// board at 4xl+. Below 4xl the pane takes the full content width and the
// board (children slot) is hidden via group-has, which visually matches the
// plain task route. Pathname guard: parallel-route slots keep their previous
// content on soft navigation, so the pane must render nothing once the URL
// leaves /tasks/[taskId].
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
      className="min-w-0 4xl:w-[70rem] 4xl:shrink-0 5xl:w-[75rem]"
    >
      <div className="hidden items-center justify-end pb-2 4xl:flex">
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
