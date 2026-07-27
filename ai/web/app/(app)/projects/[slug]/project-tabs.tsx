"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { boardChromeSlotId } from "@/lib/board-chrome";
import { useStickyState } from "@/lib/use-sticky-state";
import { useBoardToolbarGeometry } from "@/lib/use-board-toolbar-geometry";

export default function ProjectTabs({
  slug,
  name,
  boardChromeScope,
  hasSummary = false,
  hasCode = false,
  hasBin = false,
  canAccessSettings = false,
}: {
  slug: string;
  name: string;
  boardChromeScope: string;
  hasSummary?: boolean;
  hasCode?: boolean;
  hasBin?: boolean;
  canAccessSettings?: boolean;
}) {
  const pathname = usePathname() ?? "";
  const activeTabRef = useRef<HTMLAnchorElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarStuck = useStickyState(toolbarRef);
  useBoardToolbarGeometry(toolbarRef);
  const base = `/projects/${slug}`;
  const sub = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  // Tab order: Summary (repo README) leads when present; Code/Changes sit after
  // Library; Activity is only its own tab when there is no Summary to host it;
  // the Bin tab only appears when the bin holds something.
  const tabs = [
    ...(hasSummary ? [{ href: "/summary", label: "Summary" }] : []),
    { href: "", label: "Board" },
    { href: "/epics", label: "Epics" },
    { href: "/tasks", label: "Tasks" },
    { href: "/library", label: "Library" },
    ...(hasCode ? [{ href: "/code", label: "Code" }] : []),
    ...(hasCode ? [{ href: "/changes", label: "Changes" }] : []),
    ...(canAccessSettings ? [{ href: "/settings", label: "Settings" }] : []),
    ...(hasSummary ? [] : [{ href: "/activity", label: "Activity" }]),
    ...(hasBin ? [{ href: "/bin", label: "Bin" }] : []),
  ];
  // The board is the only tab whose href is the bare base.
  function isActive(href: string): boolean {
    if (href === "") {
      return sub === "";
    }
    if (href === "/epics") {
      return sub === "/epics" || sub.startsWith("/epics/");
    }
    return sub === href || sub.startsWith(href + "/");
  }
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

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
          <nav aria-label="Project sections" className="flex shrink-0 items-center gap-1">
            {tabs.map((t) => {
              const active = isActive(t.href);
              return (
                <Link
                  key={t.href}
                  ref={active ? activeTabRef : undefined}
                  href={`${base}${t.href}`}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "rounded-lg bg-accent px-3 py-2 font-semibold text-bg shadow-[var(--shadow-xs)]"
                      : "rounded-lg px-3 py-2 font-medium text-text-muted transition hover:bg-panel-soft hover:text-text"
                  }
                >
                  {t.label}
                </Link>
              );
            })}
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
