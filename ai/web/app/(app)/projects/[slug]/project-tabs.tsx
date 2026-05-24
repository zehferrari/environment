"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "", label: "Board" },
  { href: "/epics", label: "Epics" },
  { href: "/library", label: "Library" },
  { href: "/settings", label: "Settings" },
  { href: "/bin", label: "Bin" },
] as const;

export default function ProjectTabs({ slug }: { slug: string }) {
  const pathname = usePathname() ?? "";
  const base = `/projects/${slug}`;
  const sub = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  // The board is the only tab whose href is the bare base — match it
  // when sub is empty OR points at a tasks/[id] subroute (those open
  // from board cards and conceptually belong to the board view).
  function isActive(href: string): boolean {
    if (href === "") {
      return sub === "" || sub.startsWith("/tasks/");
    }
    if (href === "/epics") {
      return sub === "/epics" || sub.startsWith("/epics/");
    }
    return sub === href || sub.startsWith(href + "/");
  }
  return (
    <nav className="mb-4 flex items-center gap-1 border-b border-[var(--color-line)] text-sm">
      {TABS.map((t) => {
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
