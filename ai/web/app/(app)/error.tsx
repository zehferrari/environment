"use client";

// Recover known stale assets once; surface real failures without blindly
// reloading the page and hiding their cause.

import { useEffect, useState } from "react";
import { isLikelyStaleBuildError, requestStaleBuildReload } from "@/lib/client/stale-build";

export default function AppRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [surfaced, setSurfaced] = useState(false);

  useEffect(() => {
    // Always log so a real (non-stale) bug can be identified next time.
    console.error("[pm] route error", { message: error?.message, digest: error?.digest }, error);

    // Known stale-asset errors reload immediately (existing 60s-guarded path).
    if (isLikelyStaleBuildError(error) && requestStaleBuildReload(error)) return;

    setSurfaced(true);
  }, [error]);

  if (!surfaced) {
    // A reload is in flight (or about to fire) — keep it quiet, no scary text.
    return (
      <div className="grid min-h-[40vh] place-items-center px-6">
        <p className="text-body text-text-muted">Recovering…</p>
      </div>
    );
  }

  return (
    <div className="grid min-h-[50vh] place-items-center px-6">
      <div className="w-full max-w-md rounded-panel border border-line bg-panel p-card-lg text-center shadow-[var(--shadow-sm)]">
        <p className="text-micro font-semibold uppercase tracking-wider text-text-muted">Mission Control</p>
        <h1 className="mt-1 text-heading font-semibold text-text">Something went wrong</h1>
        <p className="mt-2 text-body text-text-muted">
          This page hit an error. Try again, or reload — if it keeps happening, the console has the details.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-line bg-panel px-control-x py-control-y text-body font-semibold text-text transition hover:border-accent hover:text-accent"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-bg transition hover:bg-accent-strong"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
