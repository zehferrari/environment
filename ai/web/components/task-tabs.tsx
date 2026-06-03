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

export function TabsNav({ tabs, sticky = false }: { tabs: readonly string[]; sticky?: boolean }) {
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
      className={`flex flex-wrap gap-1 border-b border-[var(--color-line)] ${
        sticky
          ? "sticky top-[70px] z-20 -mx-5 bg-[var(--color-panel)] px-5 shadow-sm"
          : ""
      }`}
    >
      {tabs.map((tab) => {
        const selected = ctx.active === tab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => selectTab(tab)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              selected
                ? "border-[var(--color-accent)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {tab}
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
