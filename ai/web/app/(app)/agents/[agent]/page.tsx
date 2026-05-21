import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEditProfile, readAgentProfile } from "@/lib/agents/profile";
import ProfileEditor from "./profile-editor";

export const dynamic = "force-dynamic";

export default async function AgentProfilePage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent: slug } = await params;
  const session = await auth();
  const agent = await db.agent.findUnique({ where: { slug }, include: { user: true } });
  if (!agent) notFound();

  const profile = await readAgentProfile(slug);
  const canEdit = await canEditProfile({ name: session?.user?.name, kind: session?.user?.kind }, slug);
  const audit = await db.activityLog.findMany({
    where: { kind: "agent.profile.update", targetAgent: slug },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { user: { select: { username: true } } },
  });

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/agents" className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline">← Agents</Link>
      </nav>

      <header className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-[var(--color-text-muted)]">@{agent.slug}</p>
            <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">{agent.role}</span>
              <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">gateway {agent.gatewayPort ?? "—"}</span>
              <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">{agent.user ? `PM user: ${agent.user.username}` : "No PM user"}</span>
            </div>
          </div>
          <div className={`rounded-full px-3 py-1 text-xs ${canEdit ? "bg-[var(--color-ok)]/10 text-[var(--color-ok)]" : "bg-[var(--color-warn)]/10 text-[var(--color-warn)]"}`}>
            {canEdit ? "Editable by you" : "Read-only for you"}
          </div>
        </div>
      </header>

      <ProfileEditor agent={slug} files={profile.files} canEdit={canEdit} />

      <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Profile audit history</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No profile edits recorded yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] text-sm">
            {audit.map((row) => {
              const payload = row.payload ? JSON.parse(row.payload) as { file?: string; shaBefore?: string; shaAfter?: string; byteDelta?: number; diff?: string } : {};
              return (
                <li key={row.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><strong>{row.user?.username ?? "Someone"}</strong> edited <span className="font-mono">{payload.file ?? row.targetFile}</span></span>
                    <time className="text-xs text-[var(--color-text-muted)]" dateTime={row.createdAt.toISOString()}>{row.createdAt.toISOString().slice(0, 19).replace("T", " ")}</time>
                  </div>
                  <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">{payload.shaBefore?.slice(0, 8)} → {payload.shaAfter?.slice(0, 8)} · Δ {payload.byteDelta ?? 0} bytes</div>
                  {payload.diff ? <details className="mt-2"><summary className="cursor-pointer text-xs text-[var(--color-accent)]">View diff</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--color-bg)] p-3 text-xs">{payload.diff}</pre></details> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
