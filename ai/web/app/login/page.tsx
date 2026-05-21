import { signIn } from "@/lib/auth";
import { redirect } from "next/navigation";

async function loginAction(formData: FormData) {
  "use server";
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/projects");

  try {
    await signIn("credentials", {
      username,
      password,
      redirectTo: next || "/projects",
    });
  } catch (err) {
    // next-auth throws a redirect "error" on success — let it bubble up.
    if ((err as Error).message?.includes("NEXT_REDIRECT")) throw err;
    redirect(`/login?error=invalid&next=${encodeURIComponent(next)}`);
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <form
        action={loginAction}
        className="w-full max-w-sm rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-lg"
      >
        <h1 className="text-lg font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-[var(--color-text-muted)] mb-4">
          PM workspace for zehferrari/environment
        </p>

        {error === "invalid" && (
          <p className="text-sm text-[var(--color-crit)] mb-3">
            Invalid username or password.
          </p>
        )}

        <input type="hidden" name="next" value={next ?? "/projects"} />

        <label className="block text-sm mb-1">Username or email</label>
        <input
          name="username"
          required
          autoComplete="username"
          className="w-full rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 mb-3 outline-none focus:border-[var(--color-accent)]"
        />

        <label className="block text-sm mb-1">Password</label>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 mb-4 outline-none focus:border-[var(--color-accent)]"
        />

        <button
          type="submit"
          className="w-full rounded bg-[var(--color-accent)] text-[var(--color-bg)] font-medium py-2 hover:opacity-90"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
