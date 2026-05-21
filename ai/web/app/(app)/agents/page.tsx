import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents = await db.agent.findMany({
    orderBy: { slug: "asc" },
    include: { user: true },
  });

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-4">Agents</h1>
      {agents.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No agents have been synced yet. Trigger {`/api/debug/sync`} or wait for the next cycle.
        </p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <th className="px-2 py-1">Slug</th>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Role</th>
              <th className="px-2 py-1">Gateway port</th>
              <th className="px-2 py-1">User row</th>
              <th className="px-2 py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-t border-[var(--color-line)]">
                <td className="px-2 py-2 font-mono">{a.slug}</td>
                <td className="px-2 py-2">{a.name}</td>
                <td className="px-2 py-2">{a.role}</td>
                <td className="px-2 py-2 font-mono">{a.gatewayPort ?? "—"}</td>
                <td className="px-2 py-2">
                  {a.user ? a.user.username : <span className="text-[var(--color-warn)]">not seeded</span>}
                </td>
                <td className="px-2 py-2">
                  {a.deactivatedAt ? (
                    <span className="text-[var(--color-crit)]">deactivated</span>
                  ) : (
                    <span className="text-[var(--color-ok)]">active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
