import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";

type SnapshotAgent = {
  session_idle_s?: number | null;
  busy_state?: { is_busy?: boolean; signals?: string[] } | null;
};

type Snapshot = {
  agents?: Record<string, SnapshotAgent>;
};

async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Snapshot;
  } catch {
    return null;
  }
}

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}`;
}

function statusFor(
  agent: { deactivatedAt: Date | null; user: { status: string } | null },
  live?: SnapshotAgent | null
) {
  if (agent.deactivatedAt || agent.user?.status === "deactivated") return "offline";
  if (live?.busy_state?.is_busy) return "busy";
  if (live) {
    const idle = live.session_idle_s ?? 999999;
    if (idle < 90) return "live";
    if (idle < 900) return "idle";
    return "stale";
  }
  return agent.user ? "live" : "registered";
}

function ringFor(status: string) {
  if (status === "busy") return "#22c55e"; // Green
  if (status === "live") return "#2dd4bf"; // Teal
  if (status === "idle") return "#f59e0b"; // Orange
  if (status === "stale") return "#64748b"; // Slate
  if (status === "offline") return "#ef4444"; // Red
  return "#94a3b8"; // Gray
}

export default async function Sidebar() {
  const [session, agents, snapshot] = await Promise.all([
    auth(),
    db.agent.findMany({
      where: {
        deactivatedAt: null,
        user: { is: { status: "active" } },
      },
      orderBy: { slug: "asc" },
      select: {
        slug: true,
        name: true,
        role: true,
        avatar: true,
        deactivatedAt: true,
        user: { select: { username: true, status: true } },
      },
    }),
    readSnapshot(),
  ]);
  const user = session?.user as
    | { id?: string; name?: string; kind?: string }
    | undefined;
  // Human display name + avatar for the chip below (session.user.name is the
  // username; the editable display name lives on the User row).
  const me = user?.id
    ? await db.user.findUnique({
        where: { id: user.id },
        select: { name: true, username: true, avatarUpdatedAt: true },
      })
    : null;
  const isAdmin = user?.name === "zeh";
  const liveAgents = snapshot?.agents ?? {};

  return (
    <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)]">
      <div className="border-b border-[var(--color-line)] px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-accent)] text-sm font-bold text-white shadow-sm">Z</div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Zero Latency</div>
            <div className="text-xs text-[var(--color-text-muted)]">Mission Control</div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] text-[11px] font-semibold text-[var(--color-text)]">
            {me?.avatarUpdatedAt && user?.id ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/users/${user.id}/avatar?v=${me.avatarUpdatedAt.getTime()}`}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              (me?.name ?? me?.username ?? user?.name ?? "?")
                .slice(0, 1)
                .toUpperCase()
            )}
          </div>
          <div className="min-w-0 text-xs text-[var(--color-text-muted)]">
            <div className="truncate text-[var(--color-text)]">
              {me?.name ?? me?.username ?? user?.name}
            </div>
            {user?.kind ? <div className="truncate">{user.kind}</div> : null}
          </div>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4 text-sm">
        <div className="space-y-1">
          <Link
            href="/projects"
            className="block rounded-lg px-3 py-2 font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
          >
            Projects
          </Link>
          <Link
            href="/agents"
            className="block rounded-lg px-3 py-2 font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
          >
            Agents
          </Link>
        </div>

        <div className="my-4 border-t border-[var(--color-line)]" />
        <div className="space-y-1">
          {agents.map((agent) => {
            const live = liveAgents[agent.slug];
            const status = statusFor(agent, live);
            const statusColor = ringFor(status);
            const avatarSrc = agent.avatar ? avatarUrl(agent.name) : null;

            return (
              <Link
                key={agent.slug}
                href={`/agents/${agent.slug}/chat`}
                className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
              >
                {/* Avatar with Status Dot */}
                <div className="relative h-8 w-8 shrink-0">
                  <div className="grid h-8 w-8 place-items-center overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-xs font-semibold text-[var(--color-text)]">
                    {avatarSrc ? (
                      <img src={avatarSrc} alt={`${agent.name} avatar`} decoding="async" className="h-full w-full object-cover" />
                    ) : (
                      agent.name.slice(0, 1)
                    )}
                  </div>
                  {/* Status Dot */}
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-[var(--color-panel)]"
                    style={{ backgroundColor: statusColor }}
                    title={status}
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-[var(--color-text)]">
                    {agent.name}
                  </span>
                  <span className="block truncate text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                    {agent.role} · {status}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-[var(--color-line)] px-3 py-3 space-y-1">
        <Link
          href="/system/settings"
          className="block rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
        >
          Settings
        </Link>
        <Link
          href="/system/activity"
          className="block rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
        >
          Logs &amp; Activity
        </Link>
        {isAdmin ? (
          <Link
            href="/system/users"
            className="block rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
          >
            Users
          </Link>
        ) : null}
      </div>

      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
        className="border-t border-[var(--color-line)] px-4 py-4"
      >
        <button
          type="submit"
          className="text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Sign out
        </button>
      </form>
    </aside>
  );
}
