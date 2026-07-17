"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Lightweight tab set for the task form. Server-rendered panels are passed
// as children of <TabPanel> (the standard "server content inside a client
// component" pattern), so each panel can keep its own server actions
// (sub-task / comment / upload forms).
//
// Panels are kept MOUNTED and toggled with a `hidden` class rather than
// unmounted — that keeps the Description textarea (which posts through the
// card's single Save via form="taskMain") in the DOM no matter which tab is
// showing, so a Save from any tab still includes the description.
//
// Initial tab is fixed ("Description"), so server and client first render
// agree — no hydration mismatch.

type TabsCtx = { active: string; setActive: (tab: string) => void };
const Ctx = createContext<TabsCtx | null>(null);

function tabParam(tab: string) {
  return tab
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function TabsProvider({
  defaultTab,
  children,
}: {
  defaultTab: string;
  children: ReactNode;
}) {
  const [active, setActive] = useState(defaultTab);
  useEffect(() => {
    setActive(defaultTab);
  }, [defaultTab]);
  return <Ctx.Provider value={{ active, setActive }}>{children}</Ctx.Provider>;
}

export function TabsNav({
  tabs,
  sticky = false,
  badges = {},
}: {
  tabs: readonly string[];
  sticky?: boolean;
  badges?: Partial<Record<string, number>>;
}) {
  const ctx = useContext(Ctx);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (!ctx) return null;
  const selectTab = (tab: string) => {
    ctx.setActive(tab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tabParam(tab));
    if (tab !== "Action Plan") {
      params.delete("chatArchive");
      params.delete("chatRoom");
    }
    if (tab !== "Changes") {
      params.delete("commit");
      params.delete("file");
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return (
    <div
      role="tablist"
      className={`flex flex-wrap gap-1 border-b border-line ${
        sticky
          ? "sticky top-[70px] z-20 -mx-5 bg-panel px-5 shadow-sm"
          : ""
      }`}
    >
      {tabs.map((tab) => {
        const selected = ctx.active === tab;
        const badge = badges[tab] ?? 0;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => selectTab(tab)}
            className={`-mb-px border-b-2 px-3 py-2 text-body font-medium transition ${
              selected
                ? "border-accent text-text"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <span>{tab}</span>
              {badge > 0 ? (
                <span className="rounded-full bg-crit px-1.5 py-0.5 text-nano font-semibold leading-none text-on-crit">
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function useActiveTab() {
  return useContext(Ctx)?.active ?? null;
}

export function TabPanel({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <div role="tabpanel" className={ctx.active === name ? "" : "hidden"}>
      {children}
    </div>
  );
}
