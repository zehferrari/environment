"use client";

import { useEffect, useState, useTransition } from "react";
import { requestWorktreeSwitch } from "@/lib/deploy/actions";
import type { SwitchState } from "@/lib/deploy/worktrees";
import { displayWorktreesForRepo } from "@/lib/deploy/repo-key";

const POLL_BUSY_MS = 2000;
const POLL_IDLE_MS = 5000;

export default function WorktreeSwitcher({
  initial,
  repoKey,
}: {
  initial: SwitchState;
  // Only worktrees belonging to this project's repo are shown.
  repoKey: string;
}) {
  const [state, setState] = useState<SwitchState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const job = state.job;
  const inProgress = job.state === "queued" || job.state === "building";
  const worktrees = displayWorktreesForRepo(state.worktrees, repoKey);

  // Poll the runner-maintained state. Tolerant of network errors — the
  // pm.service restart at the end of a switch will drop a few polls, then the
  // (possibly newly-served) server answers again from the same state file.
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const res = await fetch("/api/system/worktree-switch/status", { cache: "no-store" });
        if (res.ok && !stop) setState((await res.json()) as SwitchState);
      } catch {
        /* server bouncing mid-switch — keep last state, retry next tick */
      }
    }
    const iv = setInterval(tick, inProgress ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [inProgress]);

  function serve(target: string, rebuild = false) {
    setError(null);
    startTransition(async () => {
      try {
        await requestWorktreeSwitch(target, { rebuild });
        // Optimistic: show "queued" until the next poll picks up the runner's state.
        setState((s) => ({
          ...s,
          job: {
            id: "pending",
            state: "queued",
            target,
            message: rebuild ? `Queued rebuild of ${target}…` : `Queued switch to ${target}…`,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            log: "",
          },
        }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to request switch");
      }
    });
  }

  if (!state.available) {
    return (
      <p className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm text-[var(--color-text-muted)]">
        The live-preview switcher isn&apos;t installed on this host. Run{" "}
        <code className="rounded bg-[var(--color-bg-elev)] px-1.5 py-0.5 text-xs">
          ai/web/deploy/install-pm-switch-runner.sh
        </code>{" "}
        to enable it.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-lg border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-3 py-2 text-sm text-[var(--color-crit)]">
          {error}
        </div>
      ) : null}

      {inProgress ? (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-2 text-sm text-[var(--color-accent)]">
          <Spinner />
          <span>{job.message || "Switching…"}</span>
        </div>
      ) : job.state === "error" ? (
        <details className="rounded-lg border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-3 py-2 text-sm text-[var(--color-crit)]">
          <summary className="cursor-pointer">{job.message || "Switch failed."}</summary>
          {job.log ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-[var(--color-text)]">
              {job.log}
            </pre>
          ) : null}
        </details>
      ) : job.state === "done" ? (
        <div className="rounded-lg border border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 px-3 py-2 text-sm text-[var(--color-ok)]">
          {job.message || "Switch complete."} Hard-refresh to load the new build.
        </div>
      ) : null}

      <ul className="divide-y divide-[var(--color-line)] overflow-hidden rounded-xl border border-[var(--color-line)]">
        {worktrees.map((w) => (
          <li key={w.path} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-[var(--color-text)]">{w.name}</span>
                {w.served ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-ok)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ok)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ok)]" /> Live
                  </span>
                ) : null}
                {!w.ready ? (
                  <span className="rounded-full bg-[var(--color-warn)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-warn)]">
                    needs install
                  </span>
                ) : null}
              </div>
              <div className="truncate text-xs text-[var(--color-text-muted)]">
                {w.branch} · {w.head}
              </div>
            </div>
            <button
              type="button"
              onClick={() => serve(w.name, w.served)}
              disabled={inProgress || pending || !w.ready}
              className="shrink-0 rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--color-line)] disabled:hover:text-[var(--color-text)]"
            >
              {w.served ? "Rebuild live" : "Serve live"}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-[var(--color-text-muted)]">
        Builds the chosen worktree and points the live site at it, or rebuilds
        the current live worktree (≈1–2 min; the site restarts, so it briefly
        blips). All worktrees share the same database and secrets — only the
        served code changes.
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}
