import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/permissions";
import {
  inviteHumanUser,
  resetHumanPassword,
  updateHumanProfile,
  updateHumanProjectAccess,
} from "@/lib/users/actions";
import {
  absolutePublicUrl,
  publicOriginFromHeaders,
} from "@/lib/http/public-origin";

export const dynamic = "force-dynamic";

export default async function SystemUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; reset?: string; resetUser?: string }>;
}) {
  const [viewer, { invite = "", reset = "", resetUser = "" }] = await Promise.all([getViewer(), searchParams]);
  if (!viewer?.isOwner) notFound();

  const [users, projects] = await Promise.all([
    db.user.findMany({
      where: { kind: "human" },
      orderBy: [{ isOwner: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        status: true,
        isOwner: true,
        avatarUpdatedAt: true,
        projectMembers: { select: { projectId: true } },
      },
    }),
    db.project.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true, archivedAt: true },
    }),
  ]);

  const invitePath = invite
    ? `/set-password?token=${encodeURIComponent(invite)}`
    : null;
  const inviteUrl = invitePath
    ? absolutePublicUrl(invitePath, publicOriginFromHeaders(await headers()))
    : null;
  const resetPath = reset
    ? `/set-password?token=${encodeURIComponent(reset)}`
    : null;
  const resetUrl = resetPath
    ? absolutePublicUrl(resetPath, publicOriginFromHeaders(await headers()))
    : null;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <p className="text-caption font-semibold uppercase tracking-wider text-accent">System</p>
          <h1 className="mt-1 text-display font-semibold tracking-tight">Users</h1>
          <p className="mt-1 max-w-2xl text-body text-text-muted">
            Invite people and control which projects appear in their Mission Control workspace.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-caption text-text-muted">
          {users.length} human account{users.length === 1 ? "" : "s"}
        </div>
      </header>

      {inviteUrl ? (
        <section className="border-l-4 border-ok bg-ok/10 px-4 py-3" aria-live="polite">
          <h2 className="text-body font-semibold text-ok">Invitation created</h2>
          <p className="mt-1 text-caption text-text-muted">Share this one-time link. It expires in 7 days.</p>
          <input
            readOnly
            value={inviteUrl}
            aria-label="Invitation link"
            className="mt-2 w-full rounded-lg border border-ok/40 bg-bg px-3 py-2 font-mono text-caption text-text"
          />
        </section>
      ) : null}

      {resetUrl ? (
        <section className="border-l-4 border-ok bg-ok/10 px-4 py-3" aria-live="polite">
          <h2 className="text-body font-semibold text-ok">Password reset link created</h2>
          <p className="mt-1 text-caption text-text-muted">
            Share this one-time link{resetUser ? ` with @${resetUser}` : ""}. It expires in 24 hours.
          </p>
          <input
            readOnly
            value={resetUrl}
            aria-label="Password reset link"
            className="mt-2 w-full rounded-lg border border-ok/40 bg-bg px-3 py-2 font-mono text-caption text-text"
          />
        </section>
      ) : null}

      <section aria-labelledby="invite-user-heading" className="rounded-panel border border-line bg-panel p-card-lg shadow-sm">
        <div className="mb-5">
          <h2 id="invite-user-heading" className="text-heading font-semibold tracking-tight">Invite user</h2>
          <p className="mt-1 text-caption text-text-muted">
            The account stays inactive until the person opens the invitation and sets a password.
          </p>
        </div>
        <form action={inviteHumanUser} className="space-y-5">
          <div className="grid gap-card md:grid-cols-3">
            <Field label="Display name">
              <input name="name" maxLength={120} placeholder="Rachael Smith" className={inputClass} />
            </Field>
            <Field label="Username">
              <input name="username" minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]" required placeholder="rachael" autoComplete="off" className={inputClass} />
            </Field>
            <Field label="Email">
              <input name="email" type="email" maxLength={254} required placeholder="rachael@example.com" autoComplete="off" className={inputClass} />
            </Field>
          </div>
          <ProjectGrantGrid projects={projects} />
          <div className="flex justify-end">
            <button type="submit" className="rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-white shadow-sm hover:opacity-90">
              Create invitation
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="accounts-heading" className="space-y-4">
        <div>
          <h2 id="accounts-heading" className="text-heading font-semibold tracking-tight">Accounts</h2>
          <p className="mt-1 text-caption text-text-muted">
            Workspace access is automatic when at least one granted project belongs to that workspace.
          </p>
        </div>
        {users.map((user) => {
          const grantedIds = new Set(user.projectMembers.map((membership) => membership.projectId));
          return (
            <article key={user.id} className="rounded-panel border border-line bg-panel p-card-lg shadow-sm">
              <div className="flex flex-wrap items-start gap-card">
                <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-panel-soft text-heading font-semibold text-text">
                  {user.avatarUpdatedAt ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/users/${user.id}/avatar?v=${user.avatarUpdatedAt.getTime()}`} alt={`${user.name ?? user.username} avatar`} className="h-full w-full object-cover" />
                  ) : (
                    (user.name ?? user.username).slice(0, 1).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold tracking-tight">{user.name ?? user.username}</h3>
                    {user.isOwner ? <Badge tone="owner">Owner</Badge> : null}
                    <Badge tone={user.status === "active" ? "active" : "pending"}>{user.status}</Badge>
                  </div>
                  <p className="mt-1 truncate text-caption text-text-muted">@{user.username} · {user.email}</p>
                </div>
                {user.status === "active" ? (
                  <form action={resetHumanPassword}>
                    <input type="hidden" name="userId" value={user.id} />
                    <button type="submit" className="rounded-lg border border-line bg-bg px-control-x py-control-y text-body font-medium hover:border-accent hover:text-accent">
                      Create password reset link
                    </button>
                  </form>
                ) : null}
              </div>

              <div className="my-5 border-t border-line" />

              <div className="grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                <form action={updateHumanProfile} encType="multipart/form-data" className="space-y-3">
                  <input type="hidden" name="userId" value={user.id} />
                  <Field label="Display name">
                    <input name="name" defaultValue={user.name ?? ""} maxLength={120} className={inputClass} />
                  </Field>
                  <Field label="Avatar image">
                    <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp,image/gif" className="block w-full text-caption file:mr-2 file:rounded file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-caption file:font-medium file:text-white hover:file:opacity-90" />
                  </Field>
                  {user.avatarUpdatedAt ? (
                    <label className="flex items-center gap-2 text-caption text-text-muted">
                      <input type="checkbox" name="removeAvatar" />
                      Remove current avatar
                    </label>
                  ) : null}
                  <button type="submit" className="rounded-lg border border-line bg-bg px-control-x py-control-y text-body font-medium hover:border-accent hover:text-accent">Save profile</button>
                </form>

                {user.isOwner ? (
                  <div className="rounded-lg border border-dashed border-line px-4 py-3 text-body text-text-muted">
                    The Mission Control owner automatically has access to every project and workspace.
                  </div>
                ) : (
                  <form action={updateHumanProjectAccess} className="space-y-3">
                    <input type="hidden" name="userId" value={user.id} />
                    <ProjectGrantGrid projects={projects} grantedIds={grantedIds} />
                    <button type="submit" className="rounded-lg border border-line bg-bg px-control-x py-control-y text-body font-medium hover:border-accent hover:text-accent">Save project access</button>
                  </form>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}

const inputClass = "w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function ProjectGrantGrid({
  projects,
  grantedIds = new Set<string>(),
}: {
  projects: Array<{ id: string; name: string; slug: string; archivedAt: Date | null }>;
  grantedIds?: Set<string>;
}) {
  return (
    <fieldset>
      <legend className="text-nano font-semibold uppercase tracking-wider text-text-muted">Visible projects</legend>
      {projects.length === 0 ? (
        <p className="mt-2 text-caption text-text-muted">No projects are available.</p>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <label key={project.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-body hover:border-accent">
              <input type="checkbox" name="projectId" value={project.id} defaultChecked={grantedIds.has(project.id)} className="h-4 w-4 shrink-0 accent-accent" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block truncate text-caption text-text-muted">/{project.slug}{project.archivedAt ? " · archived" : ""}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "owner" | "active" | "pending" }) {
  const className = tone === "owner"
    ? "border-accent/40 bg-accent-soft text-accent"
    : tone === "active"
      ? "border-ok/40 bg-ok/10 text-ok"
      : "border-amber-500/40 bg-amber-500/10 text-amber-700";
  return <span className={`rounded-full border px-2 py-0.5 text-nano font-semibold uppercase tracking-wider ${className}`}>{children}</span>;
}
