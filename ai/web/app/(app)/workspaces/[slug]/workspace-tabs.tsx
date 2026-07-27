"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { boardChromeSlotId } from "@/lib/board-chrome";
import { useStickyState } from "@/lib/use-sticky-state";
import { useBoardToolbarGeometry } from "@/lib/use-board-toolbar-geometry";

export default function WorkspaceTabs({
  slug,
  name,
  boardChromeScope,
  canAccessSettings,
}: {
  slug: string;
  name: string;
  boardChromeScope: string;
  canAccessSettings: boolean;
}) {
  const pathname = usePathname() ?? "";
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarStuck = useStickyState(toolbarRef);
  useBoardToolbarGeometry(toolbarRef);
  const base = `/workspaces/${slug}`;
  const interceptedTaskActive = /^\/projects\/[^/]+\/tasks\/[^/]+\/?$/.test(pathname);
  const boardActive = pathname === base || pathname === `${base}/` || interceptedTaskActive;
  const settingsActive = pathname === `${base}/settings` || pathname.startsWith(`${base}/settings/`);

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
              href={base}
              title={name}
              className="hidden max-w-72 shrink-0 items-center border-r border-line px-3 py-2 font-semibold text-text 4xl:inline-flex"
            >
              <span className="truncate">{name}</span>
            </Link>
          ) : null}
          <nav aria-label="Workspace sections" className="flex shrink-0 items-center gap-1">
            <Link
              href={base}
              aria-current={boardActive ? "page" : undefined}
              className={tabClass(boardActive)}
            >
              Board
            </Link>
            {canAccessSettings ? (
              <Link
                href={`${base}/settings`}
                aria-current={settingsActive ? "page" : undefined}
                className={tabClass(settingsActive)}
              >
                Settings
              </Link>
            ) : null}
          </nav>
          <div
            id={boardChromeSlotId(boardChromeScope, "controls")}
            data-board-controls-slot
            className="ml-auto hidden min-w-0 flex-1 items-center justify-end xl:flex"
          />
        </div>
      </div>
    </div>
  );
}
