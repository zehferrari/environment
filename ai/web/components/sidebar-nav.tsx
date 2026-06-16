"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg md:h-8 md:w-8"
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
  active = false,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  color: TileColor;
  collapsed: boolean;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg py-1.5 font-medium hover:bg-accent-soft hover:text-accent ${
        active ? "text-accent" : "text-text-muted"
      } ${collapsed ? "justify-center px-0" : "px-3"}`}
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileSheetRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
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
  const isProjectsActive = pathname === "/projects" || pathname?.startsWith("/projects/");
  const isAgentsActive = pathname === "/agents" || pathname?.startsWith("/agents/");
  const isActivityActive = pathname === "/system/activity";
  const isSettingsActive = pathname === "/system/settings";
  const hasUnreadAgents = agents.some((agent) => agent.unread);
  const mobilePrimaryItems = [
    { href: "/projects", icon: icons.projects, label: "Projects", active: isProjectsActive },
    { href: "/agents", icon: icons.agents, label: "Agents", active: isAgentsActive, badge: hasUnreadAgents },
    { href: "/system/activity", icon: icons.activity, label: "Activity", active: isActivityActive },
    { href: "/system/settings", icon: icons.settings, label: "Settings", active: isSettingsActive },
  ];

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstFocusable = mobileSheetRef.current?.querySelector<HTMLElement>(
      'a, button, [tabindex]:not([tabindex="-1"])',
    );
    firstFocusable?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        mobileMenuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !mobileSheetRef.current) return;

      const focusable = Array.from(
        mobileSheetRef.current.querySelectorAll<HTMLElement>(
          'a, button, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileMenuOpen]);

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  return (
    <>
    <aside
      className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200 md:flex ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      <div className="border-b border-line px-3 py-4">
        <div
          className={
            collapsed
              ? "flex flex-col items-center gap-3"
              : "flex items-center justify-between gap-2"
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-body font-bold text-white shadow-sm">
              Z
            </div>
            {!collapsed ? (
              <div className="min-w-0">
                <div className="truncate text-body font-semibold tracking-tight">
                  Zero Latency
                </div>
                <div className="truncate text-caption text-text-muted">
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
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted hover:bg-accent-soft hover:text-accent"
          >
            <Icon>{collapsed ? icons.expand : icons.collapse}</Icon>
          </button>
        </div>

        <div
          className={
            collapsed
              ? "mt-4 flex justify-center"
              : "mt-4 flex items-center gap-2 rounded-lg border border-line bg-panel-soft px-3 py-2"
          }
        >
          <div
            className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-panel text-micro font-semibold text-text"
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
            <div className="min-w-0 text-caption text-text-muted">
              <div className="truncate text-text">{meName}</div>
              {meKind ? <div className="truncate">{meKind}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 text-body">
        <div className="space-y-1">
          <NavItem
            href="/projects"
            icon={icons.projects}
            label="Projects"
            color={NAV_COLORS.projects}
            collapsed={collapsed}
            active={isProjectsActive}
          />
          {projects.map((project) => {
            const href = `/projects/${project.slug}`;
            const active = pathname === href || pathname?.startsWith(`${href}/`);
            return (
              <Link
                key={project.slug}
                href={href}
                title={collapsed ? project.name : undefined}
                className={`flex items-center gap-3 rounded-lg py-1.5 hover:bg-accent-soft hover:text-accent ${
                  active
                    ? "text-accent"
                    : "text-text-muted"
                } ${collapsed ? "justify-center px-0" : "px-3"}`}
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel-soft text-micro font-semibold uppercase text-text"
                  aria-hidden="true"
                >
                  {project.name.slice(0, 1)}
                </span>
                {!collapsed ? (
                  <span className="truncate text-caption font-medium">{project.name}</span>
                ) : null}
              </Link>
            );
          })}
        </div>

        <div className="my-4 border-t border-line" />

        <div className="space-y-1">
          <NavItem
            href="/agents"
            icon={icons.agents}
            label="Agents"
            color={NAV_COLORS.agents}
            collapsed={collapsed}
            active={isAgentsActive}
          />
          {agents.map((agent) => {
            const href = `/agents/${agent.slug}/chat`;
            const active = pathname?.startsWith(`/agents/${agent.slug}`);
            return (
              <Link
                key={agent.slug}
                href={href}
                title={collapsed ? `${agent.name} · ${agent.status}` : undefined}
                className={`flex items-center gap-3 rounded-lg py-1.5 hover:bg-accent-soft hover:text-accent ${
                  active ? "text-accent" : "text-text-muted"
                } ${collapsed ? "justify-center px-0" : "px-3"}`}
              >
                {/* Avatar: busy → discreet pulsing ring (opacity only, kept
                    within bounds so the collapsed rail never scrolls);
                    stale/offline → grayscale; unread → red dot. */}
                <div className="relative h-8 w-8 shrink-0">
                  {agent.pulse ? (
                    <span
                      className="pointer-events-none absolute -inset-1 animate-ping rounded-lg bg-accent opacity-30"
                      aria-hidden="true"
                    />
                  ) : null}
                  <div className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-lg border border-line bg-panel-soft text-caption font-semibold text-text">
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
                      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-panel bg-red-500"
                      title="Unread messages"
                      aria-label="Unread messages"
                    />
                  ) : null}
                </div>

                {!collapsed ? (
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate text-caption font-semibold text-text">
                      {agent.name}
                      {agent.unread ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                      ) : null}
                    </span>
                    <span className="block truncate text-nano uppercase tracking-wider text-text-muted">
                      {agent.role}
                    </span>
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="space-y-1 border-t border-line px-3 py-3 text-body">
        <NavItem
          href="/system/settings"
          icon={icons.settings}
          label="Settings"
          color={NAV_COLORS.settings}
          collapsed={collapsed}
          active={isSettingsActive}
        />
        <NavItem
          href="/system/activity"
          icon={icons.activity}
          label="Logs & Activity"
          color={NAV_COLORS.activity}
          collapsed={collapsed}
          active={isActivityActive}
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

      <form action={signOutAction} className="border-t border-line px-3 py-3">
        <button
          type="submit"
          title={collapsed ? "Sign out" : undefined}
          className={`flex w-full items-center gap-3 rounded-lg py-1.5 text-body font-medium text-text-muted hover:bg-accent-soft hover:text-accent ${
            collapsed ? "justify-center px-0" : "px-3"
          }`}
        >
          <NavTile icon={icons.signOut} color={NAV_COLORS.signOut} />
          {!collapsed ? <span className="truncate">Sign out</span> : null}
        </button>
      </form>
    </aside>

    <button
      ref={mobileMenuButtonRef}
      type="button"
      onClick={() => setMobileMenuOpen(true)}
      aria-label="Open full navigation"
      aria-haspopup="dialog"
      aria-expanded={mobileMenuOpen}
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] left-4 z-40 grid h-12 w-12 place-items-center rounded-2xl bg-accent text-body font-bold text-white shadow-lg shadow-black/20 md:hidden"
    >
      Z
      {hasUnreadAgents ? (
        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-panel bg-red-500" aria-hidden="true" />
      ) : null}
    </button>

    <nav
      aria-label="Mobile primary navigation"
      className="fixed inset-x-3 bottom-3 z-40 rounded-3xl border border-line bg-panel/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl shadow-black/20 backdrop-blur md:hidden"
    >
      <div className="grid grid-cols-4 gap-1">
        {mobilePrimaryItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            aria-current={item.active ? "page" : undefined}
            className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-nano font-semibold transition-colors hover:bg-accent-soft hover:text-accent ${
              item.active ? "text-accent" : "text-text-muted"
            }`}
          >
            <span className="relative grid h-8 w-8 place-items-center">
              <Icon>{item.icon}</Icon>
              {item.badge ? (
                <span className="absolute -right-0.5 top-0 h-2.5 w-2.5 rounded-full border border-panel bg-red-500" aria-label="Unread messages" />
              ) : null}
            </span>
            <span className="truncate">{item.label}</span>
            {item.active ? (
              <span className="absolute left-1/2 top-1 h-1 w-5 -translate-x-1/2 rounded-full bg-accent" aria-hidden="true" />
            ) : null}
          </Link>
        ))}
      </div>
    </nav>

    {mobileMenuOpen ? (
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm md:hidden"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeMobileMenu();
        }}
      >
        <div
          ref={mobileSheetRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-nav-title"
          className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-hidden rounded-t-[2rem] border border-line bg-panel shadow-2xl"
        >
          <div className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-line" aria-hidden="true" />
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent text-body font-bold text-white shadow-sm">Z</div>
              <div className="min-w-0">
                <h2 id="mobile-nav-title" className="truncate text-body font-semibold tracking-tight">Zero Latency</h2>
                <p className="truncate text-caption text-text-muted">Full navigation</p>
              </div>
            </div>
            <button
              type="button"
              onClick={closeMobileMenu}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-text-muted hover:bg-accent-soft hover:text-accent"
              aria-label="Close navigation"
            >
              ×
            </button>
          </div>

          <div className="max-h-[calc(85vh-5rem)] overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4">
            <div className="mb-4 flex items-center gap-3 rounded-2xl border border-line bg-panel-soft px-3 py-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-panel text-caption font-semibold text-text">
                {userAvatarVersion != null && userId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/users/${userId}/avatar?v=${userAvatarVersion}`} alt="" className="h-full w-full object-cover" />
                ) : (
                  meInitial
                )}
              </div>
              <div className="min-w-0 text-caption text-text-muted">
                <div className="truncate text-text">{meName}</div>
                {meKind ? <div className="truncate">{meKind}</div> : null}
              </div>
            </div>

            <section aria-labelledby="mobile-projects-heading" className="space-y-1">
              <h3 id="mobile-projects-heading" className="px-2 text-nano font-semibold uppercase tracking-wider text-text-muted">Projects</h3>
              <NavSheetLink href="/projects" icon={icons.projects} label="All projects" color={NAV_COLORS.projects} active={isProjectsActive} onNavigate={closeMobileMenu} />
              {projects.map((project) => {
                const href = `/projects/${project.slug}`;
                const active = pathname === href || pathname?.startsWith(`${href}/`);
                return (
                  <Link
                    key={project.slug}
                    href={href}
                    onClick={closeMobileMenu}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-11 items-center gap-3 rounded-2xl px-3 py-2.5 text-body hover:bg-accent-soft hover:text-accent ${active ? "text-accent" : "text-text-muted"}`}
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line bg-panel-soft text-caption font-semibold uppercase text-text" aria-hidden="true">
                      {project.name.slice(0, 1)}
                    </span>
                    <span className="truncate font-medium">{project.name}</span>
                  </Link>
                );
              })}
            </section>

            <div className="my-4 border-t border-line" />

            <section aria-labelledby="mobile-agents-heading" className="space-y-1">
              <h3 id="mobile-agents-heading" className="px-2 text-nano font-semibold uppercase tracking-wider text-text-muted">Agents</h3>
              <NavSheetLink href="/agents" icon={icons.agents} label="All agents" color={NAV_COLORS.agents} active={isAgentsActive} badge={hasUnreadAgents} onNavigate={closeMobileMenu} />
              {agents.map((agent) => {
                const href = `/agents/${agent.slug}/chat`;
                const active = pathname?.startsWith(`/agents/${agent.slug}`);
                return (
                  <Link
                    key={agent.slug}
                    href={href}
                    onClick={closeMobileMenu}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-11 items-center gap-3 rounded-2xl px-3 py-2.5 hover:bg-accent-soft hover:text-accent ${active ? "text-accent" : "text-text-muted"}`}
                  >
                    <div className="relative h-11 w-11 shrink-0">
                      {agent.pulse ? <span className="pointer-events-none absolute -inset-1 animate-ping rounded-xl bg-accent opacity-30" aria-hidden="true" /> : null}
                      <div className="relative grid h-11 w-11 place-items-center overflow-hidden rounded-xl border border-line bg-panel-soft text-caption font-semibold text-text">
                        {agent.avatarSrc ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={agent.avatarSrc} alt={`${agent.name} avatar`} decoding="async" className={`h-full w-full object-cover ${agent.grayscale ? "grayscale" : ""}`} />
                        ) : (
                          agent.name.slice(0, 1)
                        )}
                      </div>
                      {agent.unread ? <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-panel bg-red-500" aria-label="Unread messages" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 truncate text-caption font-semibold text-text">
                        {agent.name}
                        {agent.unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" /> : null}
                      </span>
                      <span className="block truncate text-nano uppercase tracking-wider text-text-muted">{agent.role}</span>
                    </div>
                  </Link>
                );
              })}
            </section>

            <div className="my-4 border-t border-line" />

            <section aria-label="System navigation" className="space-y-1">
              <NavSheetLink href="/system/activity" icon={icons.activity} label="Logs & Activity" color={NAV_COLORS.activity} active={isActivityActive} onNavigate={closeMobileMenu} />
              <NavSheetLink href="/system/settings" icon={icons.settings} label="Settings" color={NAV_COLORS.settings} active={isSettingsActive} onNavigate={closeMobileMenu} />
              {isAdmin ? <NavSheetLink href="/system/users" icon={icons.users} label="Users" color={NAV_COLORS.users} active={pathname === "/system/users"} onNavigate={closeMobileMenu} /> : null}
            </section>

            <form action={signOutAction} className="mt-4 border-t border-line pt-4">
              <button type="submit" className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-body font-medium text-text-muted hover:bg-accent-soft hover:text-accent">
                <NavTile icon={icons.signOut} color={NAV_COLORS.signOut} />
                <span className="truncate">Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    ) : null}
    </>

  );
}

function NavSheetLink({
  href,
  icon,
  label,
  color,
  active,
  badge = false,
  onNavigate,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  color: TileColor;
  active: boolean;
  badge?: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-3 rounded-2xl px-3 py-2.5 text-body font-medium hover:bg-accent-soft hover:text-accent ${active ? "text-accent" : "text-text-muted"}`}
    >
      <span className="relative">
        <NavTile icon={icon} color={color} />
        {badge ? <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-panel bg-red-500" aria-label="Unread messages" /> : null}
      </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}
