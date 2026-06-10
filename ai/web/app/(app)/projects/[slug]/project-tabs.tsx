"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function ProjectTabs({
  slug,
  hasSummary = false,
  hasCode = false,
  hasBin = false,
}: {
  slug: string;
  hasSummary?: boolean;
  hasCode?: boolean;
  hasBin?: boolean;
}) {
  const pathname = usePathname() ?? "";
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
    { href: "/settings", label: "Settings" },
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
  return (
    <nav className="mb-4 flex items-center gap-1 border-b border-[var(--color-line)] text-sm">
      {tabs.map((t) => {
        const active = isActive(t.href);
        return (
          <Link
            key={t.href}
            href={`${base}${t.href}`}
            className={
              active
                ? "border-b-2 border-[var(--color-accent)] px-3 py-2 -mb-px font-medium text-[var(--color-text)]"
                : "border-b-2 border-transparent px-3 py-2 -mb-px text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
