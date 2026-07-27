import Link from "next/link";
import NotFoundRecovery from "@/components/not-found-recovery";

// Client soft-navigation 404s inside the app (a stale build or an
// interception/parallel-slot miss) resolve on a full load, so NotFoundRecovery
// reloads once; only a genuine 404 reaches the card below.
export default function AppNotFound() {
  return (
    <NotFoundRecovery>
      <div className="grid min-h-[50vh] place-items-center px-6">
        <div className="w-full max-w-md rounded-panel border border-line bg-panel p-card-lg text-center shadow-[var(--shadow-sm)]">
          <p className="text-micro font-semibold uppercase tracking-wider text-text-muted">Mission Control</p>
          <h1 className="mt-1 text-heading font-semibold text-text">Not found</h1>
          <p className="mt-2 text-body text-text-muted">
            This page doesn’t exist, or the item was moved or removed.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Link
              href="/workspaces"
              className="rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-bg transition hover:bg-accent-strong"
            >
              Go to boards
            </Link>
          </div>
        </div>
      </div>
    </NotFoundRecovery>
  );
}
