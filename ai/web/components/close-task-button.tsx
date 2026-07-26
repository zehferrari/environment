"use client";

import { useRouter } from "next/navigation";

import { useTaskCloseHref } from "@/components/workspace-pane";

// A round × that overhangs the top-right corner of the CANONICAL full-page
// task form, ultra-wide only. In the split pane the pane owns its own close
// button (WorkspacePane), because this section's overhang would be clipped by
// the pane's overflow-hidden — so this component is only rendered when the
// task is NOT contained. It lives in the sticky header so it stays put while
// the form scrolls.
export default function CloseTaskButton({ slug }: { slug: string }) {
  const router = useRouter();
  // Inside a split pane the task returns to the board that opened it (a
  // workspace board keeps its own URL); the canonical route falls back to the
  // task's project board.
  const closeHref = useTaskCloseHref(`/projects/${slug}`);
  return (
    <button
      type="button"
      onClick={() => router.push(closeHref)}
      className="absolute -right-3 -top-3 z-30 hidden h-9 w-9 place-items-center rounded-full border border-crit/40 bg-crit text-on-crit shadow-[var(--shadow-md)] ring-2 ring-panel transition hover:scale-105 hover:opacity-90 4xl:grid"
      aria-label="Close task"
      title="Close"
    >
      <span className="text-xl leading-none">×</span>
    </button>
  );
}
