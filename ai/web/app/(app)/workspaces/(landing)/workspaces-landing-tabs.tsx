"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { boardChromeSlotId } from "@/lib/board-chrome";
import { useStickyState } from "@/lib/use-sticky-state";
import { useBoardToolbarGeometry } from "@/lib/use-board-toolbar-geometry";

export default function WorkspacesLandingTabs({
  boardChromeScope,
  isOwner,
}: {
  boardChromeScope: string;
  isOwner: boolean;
}) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarStuck = useStickyState(toolbarRef);
  useBoardToolbarGeometry(toolbarRef);
  const interceptedTaskActive = /^\/projects\/[^/]+\/tasks\/[^/]+\/?$/.test(pathname);
  const archivedActive = searchParams?.get("archived") === "1";
  const boardActive = !archivedActive && (pathname === "/workspaces" || pathname === "/workspaces/" || interceptedTaskActive);

  const tabClass = (active: boolean) => active
    ? "rounded-lg bg-accent px-3 py-2 font-semibold text-bg shadow-[var(--shadow-xs)]"
    : "rounded-lg px-3 py-2 font-medium text-text-muted transition hover:bg-panel-soft hover:text-text";

  return (
    <div
      ref={toolbarRef}
      data-board-toolbar
      className="sticky top-0 z-30 mb-5 rounded-xl border border-line bg-panel/95 shadow-[var(--shadow-sm)] backdrop-blur"
    >
      <div className="scrollbar-none overflow-x-auto p-1.5 text-body">
        <div className="flex w-full min-w-max items-center gap-2">
          {toolbarStuck ? (
            <Link
              data-board-toolbar-name
              href="/workspaces"
              title="Workspaces"
              className="hidden max-w-72 shrink-0 items-center border-r border-line px-3 py-2 font-semibold text-text 4xl:inline-flex"
            >
              <span className="truncate">Workspaces</span>
            </Link>
          ) : null}
          <nav aria-label="Workspace sections" className="flex shrink-0 items-center gap-1">
            <Link
              href="/workspaces"
              aria-current={boardActive ? "page" : undefined}
              className={tabClass(boardActive)}
            >
              Board
            </Link>
            <Link
              href="/workspaces?archived=1"
              aria-current={archivedActive ? "page" : undefined}
              className={tabClass(archivedActive)}
            >
              Archived
            </Link>
          </nav>
          <div
            id={boardChromeSlotId(boardChromeScope, "controls")}
            data-board-controls-slot
            className="ml-auto hidden min-w-0 flex-1 items-center justify-end 4xl:flex"
          />
        </div>
      </div>
    </div>
  );
}
