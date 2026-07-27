"use client";

// Route-level error boundary for every /(app) page (boards, tasks, epics, …).
// Two jobs:
//  1. Recover from stale-build render errors. StaleBuildRecovery + global-error
//     already reload on chunk 404s / matched dynamic-import failures, but a
//     render error caused by a stale/removed module often surfaces with generic
//     text that slips past the detector. Right after a deploy that is almost
//     always the cause, so we reload ONCE per URL per tab session. A genuine bug
//     survives that reload (the marker is set) and is shown instead of looping.
//  2. Make genuine errors diagnosable — log message + digest to the console so a
//     recurring real bug can be identified from a screenshot of the console.

import { useEffect, useState } from "react";
import { isLikelyStaleBuildError, requestStaleBuildReload } from "@/lib/client/stale-build";

const ONESHOT_PREFIX = "pm:route-error-recover:v1:";

function alreadyRecovered(pathname: string): boolean {
  try {
    const key = ONESHOT_PREFIX + pathname;
    if (window.sessionStorage.getItem(key) === "1") return true;
    window.sessionStorage.setItem(key, "1");
    return false;
  } catch {
    // No sessionStorage (private mode / blocked) — don't auto-reload, just show.
    return true;
  }
}

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

    // Otherwise treat the first error on this URL as a probable stale module and
    // reload once; a second occurrence is a real error, so show it.
    if (!alreadyRecovered(window.location.pathname)) {
      window.location.reload();
      return;
    }
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
