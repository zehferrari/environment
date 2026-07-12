import { createHash } from "crypto";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { setPasswordFromToken } from "@/lib/users/actions";

export const dynamic = "force-dynamic";

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;
  if (!token) redirect("/login");
  const passwordToken = await db.passwordResetToken.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: {
      expiresAt: true,
      usedAt: true,
      user: { select: { username: true, email: true, name: true, kind: true, status: true } },
    },
  });
  const valid = Boolean(
    passwordToken &&
    !passwordToken.usedAt &&
    passwordToken.expiresAt > new Date() &&
    passwordToken.user.kind === "human" &&
    ["active", "invited"].includes(passwordToken.user.status),
  );
  const isInvitation = passwordToken?.user.status === "invited";

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section className="w-full max-w-md rounded-panel border border-line bg-panel p-6 shadow-sm">
        <p className="text-caption font-semibold uppercase tracking-wider text-accent">Mission Control</p>
        <h1 className="mt-1 text-heading font-semibold">
          {isInvitation ? "Accept invitation" : "Reset password"}
        </h1>
        {!valid ? (
          <div className="mt-4 space-y-3">
            <p className="text-body text-crit">This password link is invalid, expired, or has already been used.</p>
            <a href="/login" className="inline-flex rounded-lg border border-line px-control-x py-control-y text-body font-medium hover:border-accent hover:text-accent">Return to sign in</a>
          </div>
        ) : (
          <form action={setPasswordFromToken} className="mt-4 space-y-4">
            <input type="hidden" name="token" value={token} />
            <div className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-body">
              <div className="font-medium">{passwordToken!.user.name ?? passwordToken!.user.username}</div>
              <div className="text-caption text-text-muted">@{passwordToken!.user.username} · {passwordToken!.user.email}</div>
            </div>
            <label className="block text-body">
              <span className="mb-1 block text-text-muted">New password</span>
              <input name="password" type="password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} required autoComplete="new-password" className="w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
              <span className="mt-1 block text-caption text-text-muted">At least {MIN_PASSWORD_LENGTH} characters.</span>
            </label>
            <label className="block text-body">
              <span className="mb-1 block text-text-muted">Confirm password</span>
              <input name="passwordConfirmation" type="password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} required autoComplete="new-password" className="w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
            </label>
            <button type="submit" className="w-full rounded-lg bg-accent py-2 font-medium text-white shadow-sm hover:opacity-95">
              {isInvitation ? "Activate account" : "Set new password"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
