import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export default async function Sidebar() {
  const session = await auth();
  const user = session?.user as { name?: string; kind?: string } | undefined;

  return (
    <aside className="w-56 shrink-0 border-r border-[var(--color-line)] bg-[var(--color-panel)] min-h-screen flex flex-col">
      <div className="px-4 py-4 border-b border-[var(--color-line)]">
        <div className="text-sm font-semibold">PM — Agents</div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {user?.name} {user?.kind ? `· ${user.kind}` : ""}
        </div>
      </div>

      <nav className="flex-1 px-2 py-3 space-y-1 text-sm">
        <Link
          href="/projects"
          className="block px-3 py-1.5 rounded hover:bg-[var(--color-bg-elev)]"
        >
          Projects
        </Link>
        <Link
          href="/agents"
          className="block px-3 py-1.5 rounded hover:bg-[var(--color-bg-elev)]"
        >
          Agents
        </Link>
      </nav>

      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
        className="border-t border-[var(--color-line)] px-3 py-3"
      >
        <button
          type="submit"
          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          Sign out
        </button>
      </form>
    </aside>
  );
}
