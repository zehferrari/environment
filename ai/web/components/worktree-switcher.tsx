"use client";

import { useEffect, useState, useTransition } from "react";
import { requestLocalWorktreeRemoval, requestWorktreeSwitch, setSiteActive } from "@/lib/deploy/actions";
import type { SwitchState, SwitchWorktree } from "@/lib/deploy/worktrees";
import type { SwitchDriver } from "@/lib/deploy/switch-registry";
import { displayWorktreesForRepo } from "@/lib/deploy/repo-key";
import ConfirmPopup from "@/components/confirm-popup";

const POLL_BUSY_MS = 2000;
const POLL_IDLE_MS = 5000;

export default function WorktreeSwitcher({
  initial,
  projectSlug,
  canRemove,
  protectedBranches,
  repoKey,
  driver,
  offFreesResources,
  branchDatabases,
  lifecycleControl,
}: {
  initial: SwitchState;
  projectSlug: string;
  canRemove: boolean;
  protectedBranches: string[];
  // Only worktrees belonging to this project's repo are shown.
  repoKey: string;
  driver: SwitchDriver;
  // Whether "off" actually frees resources (node-service) or only gates access
  // (nginx-docroot). Drives the honest copy on the on/off control.
  offFreesResources: boolean;
  // Whether each branch deployment serves its own forked database (environment,
  // wdt) or all worktrees share one database (patricia). Drives the DB copy.
  branchDatabases: boolean;
  // Whether this project's runner understands the on/off lifecycle. When false
  // (environment on the legacy pm-switch-runner), the on/off control is hidden
  // so we don't expose a production switch the runner would misread as a
  // branch switch. Serving a worktree still works.
  lifecycleControl: boolean;
}) {
  const [state, setState] = useState<SwitchState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SwitchWorktree | null>(null);
  const [pending, startTransition] = useTransition();

  const job = state.job;
  const inProgress = job.state === "queued" || job.state === "building" || job.state === "working";
  const worktrees = displayWorktreesForRepo(state.worktrees, repoKey);
  const protectedBranchNames = new Set(protectedBranches.map((branch) => branch.toLowerCase()));
  const busy = inProgress || pending;

  // Poll the runner-maintained state for THIS project. Tolerant of network
  // errors — the service restart at the end of a switch will drop a few polls,
  // then the (possibly newly-served) server answers again from the state file.
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const res = await fetch(
          `/api/system/worktree-switch/status?repoKey=${encodeURIComponent(repoKey)}`,
          { cache: "no-store" },
        );
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
  }, [inProgress, repoKey]);

  function optimisticJob(target: string | null, message: string) {
    setState((s) => ({
      ...s,
      job: {
        id: "pending",
        state: "queued",
        target,
        message,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        log: "",
      },
    }));
  }

  function serve(target: string, rebuild = false) {
    setError(null);
    startTransition(async () => {
      try {
        await requestWorktreeSwitch(repoKey, target, { rebuild });
        optimisticJob(target, rebuild ? `Queued rebuild of ${target}…` : `Queued switch to ${target}…`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to request switch");
      }
    });
  }

  function toggleSite(active: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        await setSiteActive(repoKey, active);
        optimisticJob(state.served, active ? "Bringing the site online…" : "Taking the site offline…");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to change site state");
      }
    });
  }

  function removeLocalWorktree() {
    if (!removeTarget) return;
    const target = removeTarget;
    setError(null);
    startTransition(async () => {
      try {
        await requestLocalWorktreeRemoval(projectSlug, target.name);
        optimisticJob(target.name, `Queued removal of local worktree ${target.name}…`);
        setRemoveTarget(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to request local worktree removal");
      }
    });
  }

  if (!state.available) {
    return (
      <p className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-body text-text-muted">
        The live-preview switcher isn&apos;t installed for this project on this host.
      </p>
    );
  }

  const offHint = offFreesResources
    ? "Off stops the service and frees its port/resources; bring it back online on the last-served worktree."
    : "Off engages the maintenance gate so the site is unreachable (a shared pool means it can't free resources); on lifts the gate.";

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-body text-crit">
          {error}
        </div>
      ) : null}

      {/* On/off lifecycle control — only for projects whose runner supports it. */}
      {lifecycleControl ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel-soft px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-body font-medium text-text">
              <span
                className={`h-2 w-2 rounded-full ${state.siteActive ? "bg-ok" : "bg-text-muted"}`}
              />
              {state.siteActive ? "Site is online" : "Site is off"}
            </div>
            <p className="mt-0.5 text-caption text-text-muted">{offHint}</p>
          </div>
          <button
            type="button"
            onClick={() => toggleSite(!state.siteActive)}
            disabled={busy}
            className="shrink-0 rounded-lg border border-line px-control-x py-control-y text-body font-medium text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {state.siteActive ? "Take offline" : "Bring online"}
          </button>
        </div>
      ) : null}

      {inProgress ? (
        <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-body text-accent">
          <Spinner />
          <span>{job.message || "Switching…"}</span>
        </div>
      ) : job.state === "error" ? (
        <details className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-body text-crit">
          <summary className="cursor-pointer">{job.message || "Switch failed."}</summary>
          {job.log ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-micro leading-5 text-text">
              {job.log}
            </pre>
          ) : null}
        </details>
      ) : job.state === "done" ? (
        <div className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-body text-ok">
          {job.message || "Switch complete."}
          {job.message.startsWith("Removed local worktree") ? null : " Hard-refresh to load the new build."}
        </div>
      ) : null}

      <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
        {worktrees.map((w) => {
          const live = w.served && state.siteActive;
          return (
            <li key={w.path} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-body font-medium text-text">{w.name}</span>
                  {live ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-ok">
                      <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Live
                    </span>
                  ) : w.served ? (
                    <span className="rounded-full bg-text-muted/15 px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-text-muted">
                      selected · off
                    </span>
                  ) : null}
                  {!w.ready ? (
                    <span className="rounded-full bg-warn/15 px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-warn">
                      needs install
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-caption text-text-muted">
                  {w.branch} · {w.head}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => serve(w.name, live)}
                  disabled={busy || !w.ready}
                  className="rounded-lg border border-line px-control-x py-control-y text-body font-medium text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-text"
                >
                  {live ? "Rebuild live" : "Serve live"}
                </button>
                {canRemove && !w.served && !protectedBranchNames.has(w.branch.toLowerCase()) ? (
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(w)}
                    disabled={busy}
                    title="Remove this local worktree and branch"
                    className="rounded-lg border border-crit/40 px-control-x py-control-y text-body font-medium text-crit hover:bg-crit/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Remove local
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-caption text-text-muted">
        Builds the chosen worktree and points the live site at it, or rebuilds
        the current live worktree (≈1–2 min; the site restarts, so it briefly
        blips).{" "}
        {branchDatabases
          ? "Each branch serves its own database, forked once from the canonical seed — schema and data can differ between branches. Secrets are shared."
          : "All worktrees share the same database and secrets — only the served code changes."}
      </p>
      <ConfirmPopup
        open={Boolean(removeTarget)}
        title="Remove local worktree?"
        description={removeTarget ? (
          <>
            This removes the local worktree <span className="font-mono text-text">{removeTarget.name}</span>
            {removeTarget.branch === "(detached)" ? ". It has no attached local branch." : (
              <> and local branch <span className="font-mono text-text">{removeTarget.branch}</span>.</>
            )} It never deletes the remote branch. Removal is refused when the worktree has local changes
            or the target is protected or live; an unmerged local branch is discarded explicitly.
          </>
        ) : undefined}
        confirmLabel="Remove local"
        danger
        busy={pending}
        onConfirm={removeLocalWorktree}
        onCancel={() => setRemoveTarget(null)}
      />
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
