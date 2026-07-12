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
  searchParams: Promise<{ error?: string; next?: string; invited?: string; reset?: string }>;
}) {
  const { error, next, invited, reset } = await searchParams;

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <form
        action={loginAction}
        className="w-full max-w-sm rounded-panel border border-line bg-panel p-6 shadow-sm"
      >
        <h1 className="text-heading font-semibold mb-1">Sign in</h1>
        <p className="text-body text-text-muted mb-4">
          Zero Latency workspace for zehferrari/environment
        </p>

        {error === "invalid" && (
          <p className="text-body text-crit mb-3">
            Invalid username or password.
          </p>
        )}
        {invited === "1" ? (
          <p className="mb-3 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-body text-ok">
            Account activated. Sign in with your new password.
          </p>
        ) : null}
        {reset === "1" ? (
          <p className="mb-3 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-body text-ok">
            Password updated. Sign in with your new password.
          </p>
        ) : null}

        <input type="hidden" name="next" value={next ?? "/projects"} />

        <label className="block text-body mb-1">Username or email</label>
        <input
          name="username"
          required
          autoComplete="username"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 mb-3 outline-none focus:border-accent"
        />

        <label className="block text-body mb-1">Password</label>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 mb-4 outline-none focus:border-accent"
        />

        <button
          type="submit"
          className="w-full rounded-lg bg-accent text-white font-medium py-2 shadow-sm hover:opacity-95"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
