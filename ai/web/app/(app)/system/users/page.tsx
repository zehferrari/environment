import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { updateHumanProfile } from "@/lib/users/actions";

export const dynamic = "force-dynamic";

// Admin screen to edit human user profiles (display name + avatar). Gated
// to the code owner (zeh) — the de-facto admin until a real RBAC layer
// lands (RolePermission is still a stub).
export default async function SystemUsersPage() {
  const session = await auth();
  if (session?.user?.name !== "zeh") notFound();

  const users = await db.user.findMany({
    where: { kind: "human" },
    orderBy: { username: "asc" },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      avatarUpdatedAt: true,
    },
  });

  return (
    <div className="space-y-6">
      <header className="rounded-[28px] border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-text-muted)]">
          System
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Users.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
          Edit human user profiles — display name and avatar. Username and
          email are the login / @mention identity and stay fixed.
        </p>
      </header>

      <div className="space-y-4">
        {users.map((u) => (
          <form
            key={u.id}
            action={updateHumanProfile}
            encType="multipart/form-data"
            className="flex flex-wrap items-center gap-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm"
          >
            <input type="hidden" name="userId" value={u.id} />

            {/* Avatar preview */}
            <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-lg font-semibold text-[var(--color-text)]">
              {u.avatarUpdatedAt ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/users/${u.id}/avatar?v=${u.avatarUpdatedAt.getTime()}`}
                  alt={`${u.name ?? u.username} avatar`}
                  className="h-full w-full object-cover"
                />
              ) : (
                (u.name ?? u.username).slice(0, 1).toUpperCase()
              )}
            </div>

            <div className="min-w-[14rem] flex-1 space-y-3">
              <div className="text-xs text-[var(--color-text-muted)]">
                @{u.username} · {u.email}
              </div>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Display name
                </span>
                <input
                  type="text"
                  name="name"
                  defaultValue={u.name ?? ""}
                  maxLength={120}
                  placeholder="e.g. Zeh Ferrari"
                  className="w-full max-w-sm rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Avatar image
                </span>
                <input
                  type="file"
                  name="avatar"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="text-xs file:mr-2 file:rounded file:border-0 file:bg-[var(--color-accent)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--color-bg)] hover:file:opacity-90"
                />
                <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                  PNG/JPG/WebP, resized to a square. Max 8 MiB.
                </span>
              </label>
              {u.avatarUpdatedAt ? (
                <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <input type="checkbox" name="removeAvatar" />
                  Remove current avatar
                </label>
              ) : null}
            </div>

            <button
              type="submit"
              className="self-end rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              Save
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
