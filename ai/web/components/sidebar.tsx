import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function Sidebar() {
  const [session, agents] = await Promise.all([
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
        user: { select: { username: true } },
      },
    }),
  ]);
  const user = session?.user as { name?: string; kind?: string } | undefined;

  return (
    <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)]">
      <div className="border-b border-[var(--color-line)] px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-accent)] text-sm font-bold text-white shadow-sm">P</div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Project Manager</div>
            <div className="text-xs text-[var(--color-text-muted)]">Agent workspace</div>
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {user?.name} {user?.kind ? `· ${user.kind}` : ""}
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
          <Link
            href="/system/activity"
            className="block rounded-lg px-3 py-2 font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
          >
            System activity
          </Link>
        </div>

        <div className="my-4 border-t border-[var(--color-line)]" />
        <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Chat
        </div>
        <div className="mt-2 space-y-1">
          {agents.map((agent) => (
            <Link
              key={agent.slug}
              href={`/agents/${agent.slug}/chat`}
              className="block rounded-lg px-3 py-2 text-[var(--color-text-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
            >
              <span className="block truncate text-sm font-medium text-[var(--color-text)]">
                {agent.user?.username ?? agent.slug}
              </span>
              <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                {agent.role} · {agent.name}
              </span>
            </Link>
          ))}
        </div>
      </nav>

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
