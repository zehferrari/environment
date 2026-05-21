import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export default async function Sidebar() {
  const session = await auth();
  const user = session?.user as { name?: string; kind?: string } | undefined;

  return (
    <aside className="flex min-h-screen w-64 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)]">
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

      <nav className="flex-1 space-y-1 px-3 py-4 text-sm">
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
