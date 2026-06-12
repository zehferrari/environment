"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export type SidebarAgent = {
  slug: string;
  name: string;
  role: string;
  avatarSrc: string | null;
  status: string;
  // Visual treatment derived from status: grayscale for stale/offline,
  // a glowing pulse ring for busy. live/idle render plain colour.
  grayscale: boolean;
  pulse: boolean;
  // Whether this agent has unread direct-chat messages for the viewer.
  unread: boolean;
};

export type SidebarProject = {
  slug: string;
  name: string;
};

type SidebarNavProps = {
  isAdmin: boolean;
  agents: SidebarAgent[];
  projects: SidebarProject[];
  meName: string;
  meKind: string | null;
  userId: string | null;
  userAvatarVersion: number | null;
  signOutAction: () => Promise<void>;
};

const STORAGE_KEY = "pm:sidebar:collapsed";

/** Per-option tile colors (soft background + saturated glyph). Inline styles
 *  mirror the agent status-dot pattern so they render regardless of scanning. */
type TileColor = { bg: string; fg: string };
const NAV_COLORS: Record<string, TileColor> = {
  projects: { bg: "rgba(108,92,231,0.14)", fg: "#6c5ce7" }, // indigo / accent
  agents: { bg: "rgba(14,165,233,0.14)", fg: "#0ea5e9" }, // sky
  settings: { bg: "rgba(100,116,139,0.16)", fg: "#475569" }, // slate
  activity: { bg: "rgba(245,158,11,0.16)", fg: "#d97706" }, // amber
  users: { bg: "rgba(16,185,129,0.14)", fg: "#059669" }, // emerald
  signOut: { bg: "rgba(239,68,68,0.14)", fg: "#dc2626" }, // rose
};

/** Lucide-style icons (24×24, stroke=currentColor) to match the rest of the app. */
const icons = {
  projects: (
    <>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </>
  ),
  agents: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  signOut: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </>
  ),
  collapse: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
    </>
  ),
  expand: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </>
  ),
};

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A 32px rounded tile holding an icon — same footprint as the agent avatars,
 *  so every row's leading element is identical in size and left position. */
function NavTile({ icon, color }: { icon: React.ReactNode; color: TileColor }) {
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
      style={{ backgroundColor: color.bg, color: color.fg }}
    >
      <Icon>{icon}</Icon>
    </span>
  );
}

function NavItem({
  href,
  icon,
  label,
  color,
  collapsed,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  color: TileColor;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={`flex items-center gap-3 rounded-lg py-1.5 font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] ${
        collapsed ? "justify-center px-0" : "px-3"
      }`}
    >
      <NavTile icon={icon} color={color} />
      {!collapsed ? <span className="truncate">{label}</span> : null}
    </Link>
  );
}

export default function SidebarNav({
  isAdmin,
  agents,
  projects,
  meName,
  meKind,
  userId,
  userAvatarVersion,
  signOutAction,
}: SidebarNavProps) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  // Read persisted state after mount to avoid an SSR/hydration mismatch.
  useEffect(() => {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
  }, []);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  const meInitial = (meName || "?").slice(0, 1).toUpperCase();

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      <div className="border-b border-[var(--color-line)] px-3 py-4">
        <div
          className={
            collapsed
              ? "flex flex-col items-center gap-3"
              : "flex items-center justify-between gap-2"
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--color-accent)] text-sm font-bold text-white shadow-sm">
              Z
            </div>
            {!collapsed ? (
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-tight">
                  Zero Latency
                </div>
                <div className="truncate text-xs text-[var(--color-text-muted)]">
                  Mission Control
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={toggle}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
          >
            <Icon>{collapsed ? icons.expand : icons.collapse}</Icon>
          </button>
        </div>

        <div
          className={
            collapsed
              ? "mt-4 flex justify-center"
              : "mt-4 flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2"
          }
        >
          <div
            className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] text-[11px] font-semibold text-[var(--color-text)]"
            title={collapsed ? meName : undefined}
          >
            {userAvatarVersion != null && userId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/users/${userId}/avatar?v=${userAvatarVersion}`}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              meInitial
            )}
          </div>
          {!collapsed ? (
            <div className="min-w-0 text-xs text-[var(--color-text-muted)]">
              <div className="truncate text-[var(--color-text)]">{meName}</div>
              {meKind ? <div className="truncate">{meKind}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 text-sm">
        <div className="space-y-1">
          <NavItem
            href="/projects"
            icon={icons.projects}
            label="Projects"
            color={NAV_COLORS.projects}
            collapsed={collapsed}
          />
          {projects.map((project) => {
            const href = `/projects/${project.slug}`;
            const active = pathname === href || pathname?.startsWith(`${href}/`);
            return (
              <Link
                key={project.slug}
                href={href}
                title={collapsed ? project.name : undefined}
                className={`flex items-center gap-3 rounded-lg py-1.5 hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] ${
                  active
                    ? "text-[var(--color-accent)]"
                    : "text-[var(--color-text-muted)]"
                } ${collapsed ? "justify-center px-0" : "px-3"}`}
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[11px] font-semibold uppercase text-[var(--color-text)]"
                  aria-hidden="true"
                >
                  {project.name.slice(0, 1)}
                </span>
                {!collapsed ? (
                  <span className="truncate text-xs font-medium">{project.name}</span>
                ) : null}
              </Link>
            );
          })}
        </div>

        <div className="my-4 border-t border-[var(--color-line)]" />

        <div className="space-y-1">
          <NavItem
            href="/agents"
            icon={icons.agents}
            label="Agents"
            color={NAV_COLORS.agents}
            collapsed={collapsed}
          />
          {agents.map((agent) => {
            const href = `/agents/${agent.slug}/chat`;
            const active = pathname?.startsWith(`/agents/${agent.slug}`);
            return (
              <Link
                key={agent.slug}
                href={href}
                title={collapsed ? `${agent.name} · ${agent.status}` : undefined}
                className={`flex items-center gap-3 rounded-lg py-1.5 hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] ${
                  active ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"
                } ${collapsed ? "justify-center px-0" : "px-3"}`}
              >
                {/* Avatar: busy → discreet pulsing ring (opacity only, kept
                    within bounds so the collapsed rail never scrolls);
                    stale/offline → grayscale; unread → red dot. */}
                <div className="relative h-8 w-8 shrink-0">
                  {agent.pulse ? (
                    <span
                      className="pointer-events-none absolute -inset-1 animate-ping rounded-lg bg-[var(--color-accent)] opacity-30"
                      aria-hidden="true"
                    />
                  ) : null}
                  <div className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-xs font-semibold text-[var(--color-text)]">
                    {agent.avatarSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={agent.avatarSrc}
                        alt={`${agent.name} avatar`}
                        decoding="async"
                        className={`h-full w-full object-cover ${
                          agent.grayscale ? "grayscale" : ""
                        }`}
                      />
                    ) : (
                      agent.name.slice(0, 1)
                    )}
                  </div>
                  {agent.unread ? (
                    <span
                      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-[var(--color-panel)] bg-red-500"
                      title="Unread messages"
                      aria-label="Unread messages"
                    />
                  ) : null}
                </div>

                {!collapsed ? (
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate text-xs font-semibold text-[var(--color-text)]">
                      {agent.name}
                      {agent.unread ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                      ) : null}
                    </span>
                    <span className="block truncate text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      {agent.role}
                    </span>
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="space-y-1 border-t border-[var(--color-line)] px-3 py-3 text-sm">
        <NavItem
          href="/system/settings"
          icon={icons.settings}
          label="Settings"
          color={NAV_COLORS.settings}
          collapsed={collapsed}
        />
        <NavItem
          href="/system/activity"
          icon={icons.activity}
          label="Logs & Activity"
          color={NAV_COLORS.activity}
          collapsed={collapsed}
        />
        {isAdmin ? (
          <NavItem
            href="/system/users"
            icon={icons.users}
            label="Users"
            color={NAV_COLORS.users}
            collapsed={collapsed}
          />
        ) : null}
      </div>

      <form action={signOutAction} className="border-t border-[var(--color-line)] px-3 py-3">
        <button
          type="submit"
          title={collapsed ? "Sign out" : undefined}
          className={`flex w-full items-center gap-3 rounded-lg py-1.5 text-sm font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] ${
            collapsed ? "justify-center px-0" : "px-3"
          }`}
        >
          <NavTile icon={icons.signOut} color={NAV_COLORS.signOut} />
          {!collapsed ? <span className="truncate">Sign out</span> : null}
        </button>
      </form>
    </aside>
  );
}
