import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  MAX_PASSWORD_LENGTH,
  hashPassword,
  passwordLengthError,
  verifyPassword,
} from "@/lib/auth/password";
import { redirect } from "next/navigation";

async function rotateAction(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user) redirect("/login");

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (current.length > MAX_PASSWORD_LENGTH || passwordLengthError(next) === "long" || confirm.length > MAX_PASSWORD_LENGTH) {
    redirect("/rotate-password?error=long");
  }
  if (passwordLengthError(next) === "short") {
    redirect("/rotate-password?error=short");
  }
  if (next !== confirm) {
    redirect("/rotate-password?error=mismatch");
  }

  const userId = (session.user as { id?: string }).id;
  if (!userId) redirect("/login");

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) redirect("/login");

  const ok = await verifyPassword(current, user.passwordHash);
  if (!ok) redirect("/rotate-password?error=wrongcurrent");

  await db.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(next),
      passwordSetAt: new Date(),
      mustRotatePassword: false,
    },
  });

  // Force re-auth so JWT picks up new mustRotatePassword=false.
  await signOut({ redirectTo: "/login?rotated=1" });
}

export default async function RotatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const { error } = await searchParams;

  const errors: Record<string, string> = {
    short: "Password must be at least 12 characters.",
    long: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`,
    mismatch: "New password and confirmation do not match.",
    wrongcurrent: "Current password is incorrect.",
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <form
        action={rotateAction}
        className="w-full max-w-sm rounded-panel border border-line bg-panel p-6 shadow-sm"
      >
        <h1 className="text-heading font-semibold mb-1">Set a new password</h1>
        <p className="text-body text-text-muted mb-4">
          Your seeded password must be rotated before you can use PM.
        </p>

        {error && errors[error] && (
          <p className="text-body text-crit mb-3">{errors[error]}</p>
        )}

        <label className="block text-body mb-1">Current password</label>
        <input
          name="current"
          type="password"
          required
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete="current-password"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 mb-3 outline-none focus:border-accent"
        />

        <label className="block text-body mb-1">New password (min 12 chars)</label>
        <input
          name="next"
          type="password"
          required
          minLength={12}
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete="new-password"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 mb-3 outline-none focus:border-accent"
        />

        <label className="block text-body mb-1">Confirm new password</label>
        <input
          name="confirm"
          type="password"
          required
          minLength={12}
          maxLength={MAX_PASSWORD_LENGTH}
          autoComplete="new-password"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 mb-4 outline-none focus:border-accent"
        />

        <button
          type="submit"
          className="w-full rounded-lg bg-accent text-white font-medium py-2 shadow-sm hover:opacity-95"
        >
          Rotate password
        </button>
      </form>
    </main>
  );
}
