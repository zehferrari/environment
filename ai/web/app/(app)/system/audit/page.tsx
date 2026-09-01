import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

// ENV-164 — Owner-only audit trail for scoped access management. Admin and
// Customer requests land on the same safe not-found treatment as every other
// owner-only page; no metadata is leaked.
export default async function SystemAccessAuditPage() {
  const viewer = await getViewer();
  if (!viewer?.canAccessOwnerFeatures) notFound();

  const [rows, projects] = await Promise.all([
    db.accessAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        actor: { select: { username: true, name: true } },
        affectedUser: { select: { username: true, name: true } },
      },
    }),
    db.project.findMany({ select: { id: true, name: true } }),
  ]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  function decodeIds(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
    } catch {
      return [];
    }
  }

  const displayName = (user: { username: string; name: string | null }) =>
    user.name ?? `@${user.username}`;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <p className="text-caption font-semibold uppercase tracking-wider text-accent">System</p>
          <h1 className="mt-1 text-display font-semibold tracking-tight">Access audit</h1>
          <p className="mt-1 max-w-2xl text-body text-text-muted">
            Every role and project-access change, newest first. Only the Mission Control owner can see this trail.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-caption text-text-muted">
          {rows.length} recent change{rows.length === 1 ? "" : "s"}
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="text-body text-text-muted">No access changes have been recorded yet.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const oldProjects = decodeIds(row.oldProjectIds).map((id) => projectNames.get(id) ?? id);
            const newProjects = decodeIds(row.newProjectIds).map((id) => projectNames.get(id) ?? id);
            const verb =
              row.action === "grant"
                ? "granted access to"
                : row.action === "revoke"
                  ? "revoked access from"
                  : row.action === "promote"
                    ? "promoted"
                    : "demoted";
            return (
              <li key={row.id} className="rounded-panel border border-line bg-panel px-4 py-3 shadow-sm">
                <p className="text-body">
                  <span className="font-semibold">{displayName(row.actor)}</span>{" "}
                  <span className="text-accent">{verb}</span>{" "}
                  <span className="font-semibold">{displayName(row.affectedUser)}</span>
                  {row.action === "promote" || row.action === "demote" ? (
                    <span className="text-text-muted"> ({row.oldRole ?? "—"} → {row.newRole ?? "—"})</span>
                  ) : null}
                </p>
                {oldProjects.length > 0 || newProjects.length > 0 ? (
                  <p className="mt-1 text-caption text-text-muted">
                    Projects: {oldProjects.length > 0 ? oldProjects.join(", ") : "none"} → {newProjects.length > 0 ? newProjects.join(", ") : "none"}
                  </p>
                ) : null}
                <p className="mt-1 text-caption text-text-muted">
                  {row.createdAt.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
