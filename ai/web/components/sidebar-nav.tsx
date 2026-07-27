"use client";

import Link from "next/link";
import AvatarStatus from "@/components/avatar-status";
import AgentAvatar from "@/components/agent-avatar";
import { useAgentPresenceMap } from "@/components/agent-presence-provider";
import { agentStatusRank } from "@/lib/agents/presence";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type SidebarAgent = {
  slug: string;
  name: string;
  role: string;
  avatarSrc: string | null;
  // Server-render presence status; the live presence store takes over on the
  // client (AgentAvatar handles the visual treatment per status).
  status: string;
  // Whether this agent has unread direct-chat messages for the viewer.
  unread: boolean;
};

export type SidebarProject = {
  slug: string;
  name: string;
  /** Project background colour from settings; drives the row's left rail. */
  color?: string | null;
  /** Percent of this project's tasks that are Done; null when it has none. */
  completion?: number | null;
};

export type SidebarWorkspace = {
  slug: string;
  name: string;
  /** Workspace border colour — the same hue the board cards use. */
  color?: string | null;
  /** Percent Done across every project in this workspace; null when empty. */
  completion?: number | null;
  logoSrc: string | null;
  projects: SidebarProject[];
  agentSlugs: string[];
};

type SidebarNavProps = {
  isOwner: boolean;
  canViewAgents: boolean;
  agents: SidebarAgent[];
  projects: SidebarProject[];
  workspaces: SidebarWorkspace[];
  meName: string;
  meKind: string | null;
  userId: string | null;
  userAvatarVersion: number | null;
  signOutAction: () => Promise<void>;
};

const STORAGE_KEY = "pm:sidebar:collapsed";
const WORKSPACE_EXPANDED_STORAGE_KEY = "pm:sidebar:expanded-workspaces";
const SELECTED_WORKSPACE_STORAGE_KEY = "pm:sidebar:selected-workspace";

/** Per-option tile colors (soft background + saturated glyph). Inline styles
 *  mirror the agent status-dot pattern so they render regardless of scanning. */
type TileColor = { bg: string; fg: string };
const NAV_COLORS: Record<string, TileColor> = {
  projects: { bg: "rgba(108,92,231,0.14)", fg: "#6c5ce7" }, // indigo / accent
  workspaces: { bg: "rgba(168,85,247,0.14)", fg: "#9333ea" }, // purple
  agents: { bg: "rgba(14,165,233,0.14)", fg: "#0ea5e9" }, // sky
  settings: { bg: "rgba(100,116,139,0.16)", fg: "#475569" }, // slate
  activity: { bg: "rgba(245,158,11,0.16)", fg: "#d97706" }, // amber
  users: { bg: "rgba(16,185,129,0.14)", fg: "#059669" }, // emerald
  signOut: { bg: "rgba(239,68,68,0.14)", fg: "#dc2626" }, // rose
};

const PROJECT_LABEL_COLORS: TileColor[] = [
  { bg: "rgba(45,108,223,0.14)", fg: "#2d6cdf" },
  { bg: "rgba(5,150,105,0.14)", fg: "#059669" },
  { bg: "rgba(217,119,6,0.16)", fg: "#d97706" },
  { bg: "rgba(220,38,38,0.13)", fg: "#dc2626" },
  { bg: "rgba(124,58,237,0.14)", fg: "#7c3aed" },
  { bg: "rgba(8,145,178,0.14)", fg: "#0891b2" },
  { bg: "rgba(219,39,119,0.13)", fg: "#db2777" },
  { bg: "rgba(22,101,52,0.14)", fg: "#166534" },
];

// Completion meter: an empty grey track at 0/none, then a red → orange →
// green gradient, with the percentage read out at the end. The gradient always
// spans the *track*, not the fill, so a 20%-done bar reads red and only a
// finished one reaches green — the fill's background is scaled back up to
// full-track width to achieve that.
function ProgressMeter({
  value,
  label,
}: {
  value: number | null | undefined;
  label: string;
}) {
  const percent = value == null ? null : Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span
      className="flex items-center gap-1.5"
      role="img"
      aria-label={percent == null ? `${label}: no tasks yet` : `${label}: ${percent}% done`}
      title={percent == null ? "No tasks yet" : `${percent}% done`}
    >
      <span className="block h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        {percent && percent > 0 ? (
          <span
            className="block h-full rounded-full"
            style={{
              width: `${percent}%`,
              backgroundImage: "linear-gradient(90deg,#ef4444 0%,#f97316 35%,#f59e0b 55%,#22c55e 100%)",
              backgroundSize: `${(100 / percent) * 100}% 100%`,
            }}
          />
        ) : null}
      </span>
      <span className="shrink-0 text-nano font-semibold tabular-nums text-text-muted">
        {percent == null ? "—" : `${percent}%`}
      </span>
    </span>
  );
}

/** Left rail colour for a sidebar row; falls back to the derived project hue. */
function railStyle(color: string | null | undefined, fallback?: string) {
  return { borderLeftColor: color ?? fallback ?? "var(--color-line-strong)" };
}

/** Selected-row wash. Keeps the established accent treatment when the entity
 *  has no colour of its own, so an uncoloured workspace/project still reads as
 *  selected. */
function selectedTint(color: string | null | undefined) {
  const hex = /^#[0-9a-f]{6}$/i.test(color ?? "") ? color : null;
  return { backgroundColor: hex ? `${hex}26` : "var(--color-accent-soft)" };
}

function colorForProject(project: SidebarProject): TileColor {
  const source = project.slug || project.name;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return PROJECT_LABEL_COLORS[hash % PROJECT_LABEL_COLORS.length]!;
}

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
  workspaces: (
    <>
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <rect width="8" height="8" x="13" y="3" rx="2" />
      <rect width="8" height="8" x="3" y="13" rx="2" />
      <path d="M13 17h8" />
      <path d="M17 13v8" />
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
  badge = false,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  color: TileColor;
  collapsed: boolean;
  active?: boolean;
  badge?: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-3 rounded-lg py-1.5 font-medium transition-[background-color,color,box-shadow] hover:bg-accent-soft hover:text-accent ${
        active ? "bg-accent-soft text-accent shadow-[inset_3px_0_0_var(--color-accent)]" : "text-text-muted"
      } ${collapsed ? "justify-center px-0" : "px-3"}`}
    >
      <span className="relative shrink-0">
        <NavTile icon={icon} color={color} />
        {badge ? (
          <span
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-panel bg-red-500"
            aria-label="Unread messages"
          />
        ) : null}
      </span>
      {!collapsed ? <span className="truncate">{label}</span> : null}
    </Link>
  );
}

export default function SidebarNav({
  isOwner,
  canViewAgents,
  agents,
  projects,
  workspaces,
  meName,
  meKind,
  userId,
  userAvatarVersion,
  signOutAction,
}: SidebarNavProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedWorkspaceSlugs, setExpandedWorkspaceSlugs] = useState<string[]>([]);
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = useState<string>("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileSheetRef = useRef<HTMLDivElement | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const pathname = usePathname();
  // Live presence: overrides each agent's SSR status once the stream reports,
  // so busy-first ordering and busy-row visibility react without a refresh.
  const liveStatuses = useAgentPresenceMap();
  const statusOf = (agent: SidebarAgent) => liveStatuses[agent.slug] ?? agent.status;

  // Read persisted state after mount to avoid an SSR/hydration mismatch.
  useEffect(() => {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    const stored = window.localStorage.getItem(WORKSPACE_EXPANDED_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setExpandedWorkspaceSlugs(parsed.filter((slug): slug is string => typeof slug === "string"));
        }
      } catch {
        // Ignore malformed local state; the sidebar remains usable with defaults.
      }
    }
    setSelectedWorkspaceSlug(window.localStorage.getItem(SELECTED_WORKSPACE_STORAGE_KEY) ?? "");
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
  const isWorkspacesActive = pathname === "/" || pathname === "/workspaces" || pathname?.startsWith("/workspaces/");
  // The aggregate landing board: no single workspace is selected there, so
  // the sidebar opens all of them.
  const onLanding = pathname === "/" || pathname === "/workspaces";
  // Every board route (landing, a workspace board, a project board) shows the
  // full expanded workspace/project tree — the homepage menu, replicated. Only
  // the selected workspace or project carries a highlight; everything else is a
  // plain white/transparent row inside its coloured-rail container.
  const onBoardPage =
    onLanding ||
    pathname === "/projects" ||
    pathname?.startsWith("/projects/") ||
    pathname?.startsWith("/workspaces/");
  const isAgentsActive = pathname === "/agents" || pathname?.startsWith("/agents/");
  const isActivityActive = pathname === "/system/activity";
  const isSettingsActive = pathname === "/system/settings";
  const activeProjectSlug = pathname?.startsWith("/projects/") ? pathname.split("/")[2] : null;
  const activeWorkspaceSlugFromPath = pathname?.startsWith("/workspaces/") ? pathname.split("/")[2] : null;
  const activeWorkspaceSlug =
    activeWorkspaceSlugFromPath ??
    workspaces.find((workspace) =>
      workspace.projects.some((project) => project.slug === activeProjectSlug),
    )?.slug ??
    null;
  // A workspace expands to reveal its projects whenever the route lives under
  // it, but it is only *highlighted* when its own hub page is open — a selected
  // project is the single active row, its parent workspace is not.
  const highlightedWorkspaceSlug = activeProjectSlug ? null : activeWorkspaceSlug;
  const selectedWorkspace = workspaces.find((workspace) => workspace.slug === selectedWorkspaceSlug) ?? null;
  const activeWorkspace = workspaces.find((workspace) => workspace.slug === activeWorkspaceSlug) ?? null;
  const soleWorkspace = workspaces.length === 1 ? workspaces[0] : null;
  // The current route wins; the persisted selection is only a fallback for
  // pages that don't imply a workspace (e.g. /agents). Otherwise a stale pin
  // shadows the workspace/project you just navigated into.
  const workspaceFilter = activeWorkspace ?? selectedWorkspace ?? soleWorkspace;
  const activeWorkspaceAgentSlugs = workspaceFilter?.agentSlugs ?? [];
  // The landing shows the whole fleet; elsewhere the list narrows to the
  // workspace in context.
  const visibleAgents = !onLanding && workspaceFilter && activeWorkspaceAgentSlugs.length > 0
    ? agents.filter((agent) => activeWorkspaceAgentSlugs.includes(agent.slug))
    : agents;
  // Busy-first ordering tracks the live statuses; stable sort keeps the
  // server's alphabetical order within each status band.
  const orderedAgents = [...visibleAgents].sort(
    (a, b) => agentStatusRank(statusOf(a)) - agentStatusRank(statusOf(b)),
  );
  const busyAgents = orderedAgents.filter((agent) => statusOf(agent) === "busy");
  const hasUnreadAgents = visibleAgents.some((agent) => agent.unread);
  const assignedProjectSlugs = new Set(workspaces.flatMap((workspace) => workspace.projects.map((project) => project.slug)));
  const unassignedProjects = projects.filter((project) => !assignedProjectSlugs.has(project.slug));
  const expandedWorkspaceSet = new Set(expandedWorkspaceSlugs);
  const mobilePrimaryItems = [
    { href: soleWorkspace ? `/workspaces/${soleWorkspace.slug}` : "/workspaces", icon: icons.workspaces, label: "Workspaces", active: isWorkspacesActive || isProjectsActive },
    ...(isOwner ? [
      { href: "/agents", icon: icons.agents, label: "Agents", active: isAgentsActive, badge: hasUnreadAgents },
      { href: "/system/activity", icon: icons.activity, label: "Activity", active: isActivityActive },
      { href: "/system/settings", icon: icons.settings, label: "Settings", active: isSettingsActive },
    ] : []),
  ];

  function toggleWorkspace(slug: string) {
    setExpandedWorkspaceSlugs((prev) => {
      const next = prev.includes(slug) ? prev.filter((item) => item !== slug) : [...prev, slug];
      window.localStorage.setItem(WORKSPACE_EXPANDED_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function pinWorkspace(slug: string) {
    setSelectedWorkspaceSlug(slug);
    window.localStorage.setItem(SELECTED_WORKSPACE_STORAGE_KEY, slug);
  }

  // Landing-only "hover a nav row → only its cards stay lit" affordance. Rather
  // than parameterise CSS by slug, mark the matching cards with a class and let
  // one static rule dim the rest. Cheap DOM work on mouseenter/leave; the board
  // and sidebar are separate server trees, so we reach across via a data hook.
  function focusBoardScope(kind: "ws" | "proj", slug: string) {
    const root = document.querySelector("[data-board-focus-root]");
    if (!root) return;
    const attr = kind === "ws" ? "data-scope-ws" : "data-scope-proj";
    root.querySelectorAll<HTMLElement>("[data-board-card]").forEach((card) => {
      card.classList.toggle("board-card--dim", card.getAttribute(attr) !== slug);
    });
    root.setAttribute("data-board-focus", "");
  }

  function clearBoardScope() {
    const root = document.querySelector("[data-board-focus-root]");
    if (!root) return;
    root.removeAttribute("data-board-focus");
    root.querySelectorAll(".board-card--dim").forEach((card) => card.classList.remove("board-card--dim"));
  }

  // Keep the persisted "pin" in sync with the workspace implied by the current
  // route, so navigating into a workspace/project (not just via the switcher)
  // updates the filter and carries over to non-workspace pages like /agents.
  useEffect(() => {
    if (activeWorkspaceSlug && activeWorkspaceSlug !== selectedWorkspaceSlug) {
      setSelectedWorkspaceSlug(activeWorkspaceSlug);
      window.localStorage.setItem(SELECTED_WORKSPACE_STORAGE_KEY, activeWorkspaceSlug);
    }
  }, [activeWorkspaceSlug, selectedWorkspaceSlug]);

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
      className={`sticky top-0 z-30 hidden h-screen shrink-0 flex-col border-r border-line bg-panel/90 shadow-[8px_0_30px_rgba(20,31,55,0.035)] backdrop-blur-xl transition-[width] duration-200 md:flex ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      <div className="border-b border-line bg-gradient-to-br from-accent-soft/55 to-transparent px-3 py-4">
        <div
          className={
            collapsed
              ? "flex flex-col items-center gap-3"
              : "flex items-center justify-between gap-2"
          }
        >
          <Link href="/" title={collapsed ? `${meName} / Mission Control` : undefined} className="flex min-w-0 items-center gap-2 rounded-lg hover:text-accent">
            <AvatarStatus sizeClass="h-8 w-8" roundedClass="rounded-lg" className="bg-accent text-body font-bold text-bg shadow-sm">
              {userAvatarVersion != null && userId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/users/${userId}/avatar?v=${userAvatarVersion}`} alt="" className="h-full w-full object-cover" />
              ) : (
                meInitial
              )}
            </AvatarStatus>
            {!collapsed ? (
              <div className="min-w-0">
                <div className="truncate text-body font-semibold tracking-tight">
                  {meName}
                </div>
                <div className="truncate text-caption text-text-muted">
                  Mission Control
                </div>
              </div>
            ) : null}
          </Link>
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

      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 text-body">
        {/* Every workspace is a first-class menu row. On any board page the
            whole tree opens, each workspace bracketed by its own coloured rail;
            off the boards only the workspace the current route belongs to
            (falling back to the pinned one) expands, so the tree stays one
            level deep there. Only the selected workspace/project is highlighted;
            all other rows are plain white/transparent. */}
        <div className={onBoardPage ? "space-y-2" : "space-y-1"}>
          {workspaces.map((workspace) => (
            <WorkspaceNavGroup
              key={workspace.slug}
              workspace={workspace}
              collapsed={collapsed}
              expanded={onBoardPage || workspaceFilter?.slug === workspace.slug}
              active={highlightedWorkspaceSlug === workspace.slug}
              landing={onBoardPage}
              pathname={pathname}
              onToggle={() => pinWorkspace(workspace.slug)}
              onFocusScope={onLanding ? focusBoardScope : undefined}
              onClearScope={onLanding ? clearBoardScope : undefined}
            />
          ))}
          {unassignedProjects.length > 0 ? (
            <WorkspaceNavGroup
              workspace={{ slug: "__unassigned", name: "Other projects", color: null, completion: null, logoSrc: null, projects: unassignedProjects, agentSlugs: [] }}
              collapsed={collapsed}
              expanded={onBoardPage || expandedWorkspaceSet.has("__unassigned") || !workspaceFilter}
              active={false}
              landing={onBoardPage}
              pathname={pathname}
              onToggle={() => toggleWorkspace("__unassigned")}
              onFocusScope={onLanding ? focusBoardScope : undefined}
              onClearScope={onLanding ? clearBoardScope : undefined}
            />
          ) : null}
          {workspaces.length === 0 && unassignedProjects.length === 0 && !collapsed ? (
            <div className="rounded-lg px-3 py-2 text-caption text-text-muted">No workspaces yet.</div>
          ) : null}
        </div>

        {canViewAgents ? <>
        <div className="my-4 border-t border-line" />
        <div className="group/agents space-y-1">
          <NavItem
            href="/agents"
            icon={icons.agents}
            label="Agents"
            color={NAV_COLORS.agents}
            collapsed={collapsed}
            active={isAgentsActive}
            badge={hasUnreadAgents}
          />
          {orderedAgents.map((agent) => {
            const href = `/agents/${agent.slug}/chat`;
            const active = pathname?.startsWith(`/agents/${agent.slug}`);
            const status = statusOf(agent);
            const busy = status === "busy";
            return (
              <Link
                key={agent.slug}
                href={href}
                title={collapsed ? `${agent.name} · ${status}` : undefined}
                className={`items-center gap-3 rounded-lg py-1.5 transition-[background-color,color,box-shadow] hover:bg-accent-soft hover:text-accent ${
                  active ? "bg-accent-soft text-accent shadow-[inset_3px_0_0_var(--color-accent)]" : "text-text-muted"
                } ${collapsed ? "justify-center px-0" : "px-3"} ${
                  busy || onLanding ? "flex" : "hidden group-hover/agents:flex group-focus-within/agents:flex"
                }`}
              >
                {/* Avatar: busy → discreet pulsing ring; stale/offline →
                    grayscale; unread → red dot. All owned by AgentAvatar,
                    driven by the live presence store. */}
                <AgentAvatar
                  slug={agent.slug}
                  name={agent.name}
                  src={agent.avatarSrc}
                  sizeClass="h-8 w-8"
                  roundedClass="rounded-lg"
                  initialStatus={agent.status}
                  unread={agent.unread}
                />

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
          {busyAgents.length === 0 && !onLanding && !collapsed ? (
            <p className="rounded-lg px-3 py-2 text-caption text-text-muted group-hover/agents:hidden group-focus-within/agents:hidden">
              {visibleAgents.length === 0 ? "No agents available." : "No agents are busy."}
            </p>
          ) : null}
          {onLanding && visibleAgents.length === 0 && !collapsed ? (
            <p className="rounded-lg px-3 py-2 text-caption text-text-muted">No agents available.</p>
          ) : null}
        </div>
        </> : null}
      </nav>

      {isOwner ? <div className="space-y-1 border-t border-line px-3 py-3 text-body">
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
        <NavItem
          href="/system/users"
          icon={icons.users}
          label="Users"
          color={NAV_COLORS.users}
          collapsed={collapsed}
        />
      </div> : null}

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
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] left-4 z-40 grid h-12 w-12 place-items-center rounded-2xl bg-accent text-body font-bold text-bg shadow-[var(--shadow-float)] transition hover:bg-accent-strong md:hidden"
    >
      {meInitial}
      {hasUnreadAgents ? (
        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-panel bg-red-500" aria-hidden="true" />
      ) : null}
    </button>

    <nav
      aria-label="Mobile primary navigation"
      className="fixed inset-x-3 bottom-3 z-40 rounded-3xl border border-line bg-panel/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[var(--shadow-float)] backdrop-blur md:hidden"
    >
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${mobilePrimaryItems.length}, minmax(0, 1fr))` }}>
        {mobilePrimaryItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            aria-current={item.active ? "page" : undefined}
            className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-nano font-semibold transition-colors hover:bg-accent-soft hover:text-accent ${
              item.active ? "bg-accent-soft text-accent" : "text-text-muted"
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
              <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-2xl bg-accent text-body font-bold text-bg shadow-sm">{userAvatarVersion != null && userId ? <img src={`/api/users/${userId}/avatar?v=${userAvatarVersion}`} alt="" className="h-full w-full object-cover" /> : meInitial}</div>
              <div className="min-w-0">
                <h2 id="mobile-nav-title" className="truncate text-body font-semibold tracking-tight">{meName}</h2>
                <p className="truncate text-caption text-text-muted">Mission Control</p>
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

            <section aria-labelledby="mobile-workspaces-heading" className="space-y-1">
              <h3 id="mobile-workspaces-heading" className="px-2 text-nano font-semibold uppercase tracking-wider text-text-muted">Workspaces</h3>
              {workspaces.length > 1 ? (
                <NavSheetLink href="/workspaces" icon={icons.workspaces} label="All workspaces" color={NAV_COLORS.workspaces} active={isWorkspacesActive} onNavigate={closeMobileMenu} />
              ) : null}
              {workspaces.length === 0 ? (
                <div className="rounded-2xl px-3 py-2.5 text-caption text-text-muted">No active workspaces yet.</div>
              ) : (
                workspaces.map((workspace) => (
                  <WorkspaceNavGroup
                    key={workspace.slug}
                    workspace={workspace}
                    collapsed={false}
                    expanded={expandedWorkspaceSet.has(workspace.slug) || activeWorkspaceSlug === workspace.slug}
                    active={highlightedWorkspaceSlug === workspace.slug}
                    pathname={pathname}
                    onToggle={() => toggleWorkspace(workspace.slug)}
                    onNavigate={closeMobileMenu}
                    mobile
                  />
                ))
              )}
              {unassignedProjects.length > 0 ? (
                <WorkspaceNavGroup
                  workspace={{ slug: "__unassigned", name: "Other projects", color: null, completion: null, logoSrc: null, projects: unassignedProjects, agentSlugs: [] }}
                  collapsed={false}
                  expanded={expandedWorkspaceSet.has("__unassigned") || unassignedProjects.some((project) => project.slug === activeProjectSlug)}
                  active={false}
                  pathname={pathname}
                  onToggle={() => toggleWorkspace("__unassigned")}
                  onNavigate={closeMobileMenu}
                  mobile
                />
              ) : null}
            </section>

            <div className="my-4 border-t border-line" />

            {canViewAgents ? <section aria-labelledby="mobile-agents-heading" className="space-y-1">
              <h3 id="mobile-agents-heading" className="px-2 text-nano font-semibold uppercase tracking-wider text-text-muted">Agents</h3>
              <NavSheetLink href="/agents" icon={icons.agents} label="All agents" color={NAV_COLORS.agents} active={isAgentsActive} badge={hasUnreadAgents} onNavigate={closeMobileMenu} />
              {orderedAgents.map((agent) => {
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
                    <AgentAvatar
                      slug={agent.slug}
                      name={agent.name}
                      src={agent.avatarSrc}
                      sizeClass="h-11 w-11"
                      roundedClass="rounded-xl"
                      initialStatus={agent.status}
                      unread={agent.unread}
                    />
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
            </section> : null}

            {isOwner ? (
              <>
                <div className="my-4 border-t border-line" />
                <section aria-label="System navigation" className="space-y-1">
                  <NavSheetLink href="/system/activity" icon={icons.activity} label="Logs & Activity" color={NAV_COLORS.activity} active={isActivityActive} onNavigate={closeMobileMenu} />
                  <NavSheetLink href="/system/settings" icon={icons.settings} label="Settings" color={NAV_COLORS.settings} active={isSettingsActive} onNavigate={closeMobileMenu} />
                  <NavSheetLink href="/system/users" icon={icons.users} label="Users" color={NAV_COLORS.users} active={pathname === "/system/users"} onNavigate={closeMobileMenu} />
                </section>
              </>
            ) : null}

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

function WorkspaceNavGroup({
  workspace,
  collapsed,
  expanded,
  active,
  landing = false,
  pathname,
  onToggle,
  onNavigate,
  onFocusScope,
  onClearScope,
  mobile = false,
}: {
  workspace: SidebarWorkspace;
  collapsed: boolean;
  expanded: boolean;
  active: boolean;
  /** Landing view: every workspace is shown as a bordered container that
   *  wraps its own projects, so one coloured rail brackets the whole group. */
  landing?: boolean;
  pathname: string | null;
  onToggle: () => void;
  onNavigate?: () => void;
  /** Landing-only: hovering a row spotlights its cards on the board. */
  onFocusScope?: (kind: "ws" | "proj", slug: string) => void;
  onClearScope?: () => void;
  mobile?: boolean;
}) {
  const scopeHandlers = (kind: "ws" | "proj", slug: string) =>
    onFocusScope
      ? {
          onMouseEnter: () => onFocusScope(kind, slug),
          onMouseLeave: () => onClearScope?.(),
        }
      : undefined;
  // "Other projects" is a bucket, not a real workspace: it has no hub page, so
  // it stays a plain expand/collapse row.
  const isBucket = workspace.slug === "__unassigned";
  const tileClass = mobile
    ? "grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-panel-soft text-caption font-semibold uppercase text-text"
    : "grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-panel-soft text-micro font-semibold uppercase text-text";
  // The rail is 3px of border on every row so names stay aligned; only the
  // selected row (or, on the landing, the wrapping container) paints it.
  const railClass = landing ? "" : "border-l-[3px]";
  const rowClass = mobile
    ? `group/row flex min-h-11 w-full items-center gap-3 rounded-2xl ${railClass} px-3 py-2.5 text-left text-body hover:bg-accent-soft hover:text-accent`
    : `group/row flex w-full items-center gap-3 rounded-lg ${railClass} py-1.5 text-left hover:bg-accent-soft hover:text-accent ${collapsed ? "justify-center px-0" : "px-3"}`;
  const projectRowClass = mobile
    ? `group/row flex min-h-10 items-center gap-3 rounded-2xl ${railClass} px-3 py-2 text-caption hover:bg-accent-soft hover:text-accent`
    : collapsed
      ? "group/row flex justify-center rounded-lg py-1.5 hover:bg-accent-soft hover:text-accent"
      : `group/row ml-5 flex items-center gap-2 rounded-lg ${railClass} py-1.5 pl-3 pr-3 text-caption hover:bg-accent-soft hover:text-accent`;

  const badge = (
    <span className={tileClass} aria-hidden="true">
      {workspace.logoSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={workspace.logoSrc} alt="" className="h-full w-full object-cover" />
      ) : (
        workspace.name.slice(0, 1)
      )}
    </span>
  );

  const rowBody = !collapsed ? (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{workspace.name}</span>
        {isBucket ? (
          <span className="shrink-0 text-nano text-text-muted" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        ) : null}
      </span>
      {/* Kept in flow directly under the label (tight gap) but its height is
          always reserved — only opacity toggles — so the label + meter read as
          one vertically-centred pair and hovering never jitters the menu. */}
      {!isBucket ? (
        <span
          className={`-mt-1 block transition-opacity ${active ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"}`}
        >
          <ProgressMeter value={workspace.completion} label={workspace.name} />
        </span>
      ) : null}
    </span>
  ) : null;

  const workspaceRow = isBucket ? (
    <button
      type="button"
      title={collapsed ? workspace.name : undefined}
      aria-expanded={expanded}
      onClick={onToggle}
      className={`${rowClass} border-transparent text-text-muted`}
    >
      {badge}
      {rowBody}
    </button>
  ) : (
    <Link
      href={`/workspaces/${workspace.slug}`}
      title={collapsed ? workspace.name : `${workspace.name} hub`}
      aria-label={collapsed ? workspace.name : undefined}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        onToggle();
        onNavigate?.();
      }}
      {...scopeHandlers("ws", workspace.slug)}
      style={active ? { ...railStyle(workspace.color), ...selectedTint(workspace.color) } : undefined}
      className={`${rowClass} ${active ? "text-accent" : "border-transparent text-text-muted"}`}
    >
      {badge}
      {rowBody}
    </Link>
  );

  const projectList = expanded ? (
    workspace.projects.length > 0 ? (
      <div className="space-y-1">
        {workspace.projects.map((project) => {
          const href = `/projects/${project.slug}`;
          const projectActive = pathname === href || pathname?.startsWith(`${href}/`);
          const projectColor = colorForProject(project);
          // Only the selected project is highlighted; every other row stays
          // white/transparent. In a landing container the workspace owns the
          // rail, so the selected project shows just its colour wash; off the
          // boards the selected project also gets its own colour rail.
          const projectStyle = !projectActive
            ? undefined
            : collapsed || landing
              ? selectedTint(project.color)
              : { ...railStyle(project.color, projectColor.fg), ...selectedTint(project.color) };
          return (
            <Link
              key={project.slug}
              href={href}
              onClick={onNavigate}
              {...scopeHandlers("proj", project.slug)}
              title={collapsed ? project.name : undefined}
              aria-current={projectActive ? "page" : undefined}
              style={projectStyle}
              className={`${projectRowClass} ${projectActive ? "font-semibold text-accent" : `text-text-muted${landing ? "" : " border-transparent"}`}`}
            >
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[10px] font-semibold uppercase"
                style={{
                  backgroundColor: projectColor.bg,
                  borderColor: projectColor.fg,
                  color: projectColor.fg,
                }}
                aria-hidden="true"
              >
                {project.name.slice(0, 1)}
              </span>
              {!collapsed ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{project.name}</span>
                  {/* In flow under the label with height always reserved (opacity
                      toggles) — centred pair, no hover jitter. */}
                  <span
                    className={`-mt-1 block transition-opacity ${projectActive ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"}`}
                  >
                    <ProgressMeter value={project.completion} label={project.name} />
                  </span>
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    ) : (
      <div className={mobile ? "rounded-2xl px-3 py-2 text-caption text-text-muted" : "rounded-lg px-3 py-1.5 text-caption text-text-muted"}>
        No projects in this workspace yet.
      </div>
    )
  ) : null;

  if (landing && !isBucket && !collapsed) {
    return (
      <div
        className="space-y-1 rounded-lg border-l-[3px] bg-panel py-1 pr-1 shadow-[var(--shadow-xs)]"
        style={railStyle(workspace.color)}
      >
        {workspaceRow}
        {projectList}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {workspaceRow}
      {projectList}
    </div>
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
