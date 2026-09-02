"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runSelectedBillingReports } from "@/lib/billing/actions";
import { OPEN_BILLING_CREATE_DIALOG_EVENT } from "@/lib/billing/ui-events";
import { useRouteContext } from "@/components/use-route-context";

type ProjectOption = { id: string; slug: string; name: string; workspaceSlugs: string[] };
type AgentOption = { slug: string; name: string; role: string };
type PeriodKind = "first" | "second" | "custom";
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function brisbaneToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function halfMonth(yearInput: string, monthInput: string, kind: Exclude<PeriodKind, "custom">) {
  if (!/^\d{4}$/.test(yearInput) || !/^\d{2}$/.test(monthInput)) return { from: "", to: "" };
  const year = Number(yearInput);
  const monthNumber = Number(monthInput);
  if (monthNumber < 1 || monthNumber > 12) return { from: "", to: "" };
  const month = `${yearInput}-${monthInput}`;
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return kind === "first"
    ? { from: `${month}-01`, to: `${month}-15` }
    : { from: `${month}-16`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export default function BillingCreateDialog({
  projects,
  agents,
  defaultAgent,
}: {
  projects: ProjectOption[];
  agents: AgentOption[];
  defaultAgent: string;
}) {
  const router = useRouter();
  const route = useRouteContext();
  const today = useMemo(brisbaneToday, []);
  const [open, setOpen] = useState(false);
  const [periodKind, setPeriodKind] = useState<PeriodKind>(today.slice(8, 10) <= "15" ? "first" : "second");
  const [year, setYear] = useState(today.slice(0, 4));
  const [month, setMonth] = useState(today.slice(5, 7));
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [agentSlug, setAgentSlug] = useState(defaultAgent);
  const [selectedProjects, setSelectedProjects] = useState(() => new Set(projects.map((project) => project.id)));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const period = periodKind === "custom" ? { from: customFrom, to: customTo } : halfMonth(year, month, periodKind);

  const openDialog = useCallback(() => {
    const current = brisbaneToday();
    setPeriodKind(current.slice(8, 10) <= "15" ? "first" : "second");
    setYear(current.slice(0, 4));
    setMonth(current.slice(5, 7));
    setCustomFrom(current);
    setCustomTo(current);
    setSelectedProjects(new Set(
      route.projectSlug
        ? projects.filter((project) => project.slug === route.projectSlug).map((project) => project.id)
        : route.workspaceSlug
          ? projects.filter((project) => project.workspaceSlugs.includes(route.workspaceSlug!)).map((project) => project.id)
          : [],
    ));
    setError(null);
    setOpen(true);
  }, [projects, route.projectSlug, route.workspaceSlug]);

  useEffect(() => {
    window.addEventListener(OPEN_BILLING_CREATE_DIALOG_EVENT, openDialog);
    return () => window.removeEventListener(OPEN_BILLING_CREATE_DIALOG_EVENT, openDialog);
  }, [openDialog]);

  function toggleProject(id: string) {
    setSelectedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function submit() {
    setError(null);
    if (!period.from || !period.to || period.from > period.to) {
      setError("Choose a valid billing period.");
      return;
    }
    if (selectedProjects.size === 0) {
      setError("Select at least one project.");
      return;
    }
    startTransition(async () => {
      try {
        const form = new FormData();
        form.set("from", period.from);
        form.set("to", period.to);
        form.set("agentSlug", agentSlug);
        for (const id of selectedProjects) form.append("projectId", id);
        await runSelectedBillingReports(form);
        const selected = projects.filter((project) => selectedProjects.has(project.id));
        const sharedWorkspace = selected[0]?.workspaceSlugs.find((slug) =>
          selected.every((project) => project.workspaceSlugs.includes(slug)),
        ) ?? null;
        const workspaceTarget = route.workspaceSlug && selected.every((project) => project.workspaceSlugs.includes(route.workspaceSlug!))
          ? route.workspaceSlug
          : selected.length > 1 ? sharedWorkspace : null;
        const target = workspaceTarget
          ? `/workspaces/${workspaceTarget}/billing`
          : `/projects/${selected[0].slug}/billing`;
        router.push(`${target}?from=${period.from}&to=${period.to}&agent=${encodeURIComponent(agentSlug)}`);
        setOpen(false);
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to start the summary.");
      }
    });
  }

  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="new-billing-title">
          <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-panel border border-line bg-panel p-5 shadow-2xl sm:rounded-panel">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="new-billing-title" className="text-heading font-semibold text-text">New billing summary</h2>
                <p className="mt-1 text-caption text-text-muted">Choose the period, projects, and agent. Commit authors and branches are included automatically.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-2xl leading-none text-text-muted hover:text-text" aria-label="Close">×</button>
            </div>

            <div className="mt-5 space-y-5">
              <fieldset className="space-y-2">
                <legend className="text-caption font-semibold text-text">Period</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {([
                    ["first", "1–15"],
                    ["second", "16–month end"],
                    ["custom", "Custom Date"],
                  ] as const).map(([value, label]) => (
                    <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-body ${periodKind === value ? "border-accent bg-accent/[0.06]" : "border-line bg-bg"}`}>
                      <input type="radio" name="billingPeriodKind" value={value} checked={periodKind === value} onChange={() => setPeriodKind(value)} className="accent-accent" />
                      {label}
                    </label>
                  ))}
                </div>
                {periodKind === "custom" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-caption text-text-muted">From<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-line bg-bg px-3 text-body text-text outline-none focus:border-accent" /></label>
                    <label className="text-caption text-text-muted">To<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-line bg-bg px-3 text-body text-text outline-none focus:border-accent" /></label>
                  </div>
                ) : (
                  <div className="grid max-w-lg gap-3 sm:grid-cols-2">
                    <label className="block text-caption text-text-muted">Year
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={4}
                        value={year}
                        onChange={(event) => setYear(event.target.value.replace(/\D/g, "").slice(0, 4))}
                        className="mt-1 block h-10 w-full rounded-lg border border-line bg-bg px-3 text-body text-text outline-none focus:border-accent"
                      />
                    </label>
                    <label className="block text-caption text-text-muted">Month
                      <select value={month} onChange={(event) => setMonth(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-line bg-bg px-3 text-body text-text outline-none focus:border-accent">
                        {MONTHS.map((label, index) => {
                          const value = String(index + 1).padStart(2, "0");
                          return <option key={value} value={value}>{label}</option>;
                        })}
                      </select>
                    </label>
                  </div>
                )}
                <p className="text-caption font-medium text-accent">{period.from} → {period.to}</p>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-caption font-semibold text-text">Projects</legend>
                <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-line bg-bg p-2">
                  {projects.length > 0 ? projects.map((project) => (
                    <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-body hover:bg-panel-soft">
                      <input type="checkbox" checked={selectedProjects.has(project.id)} onChange={() => toggleProject(project.id)} className="h-4 w-4 accent-accent" />
                      <span>{project.name}</span>
                      {project.workspaceSlugs[0] ? <span className="ml-auto text-caption text-text-muted">{project.workspaceSlugs.join(", ")}</span> : null}
                    </label>
                  )) : <p className="px-2 py-3 text-caption text-text-muted">No project has a repository configured.</p>}
                </div>
              </fieldset>

              <label className="block text-caption font-semibold text-text">Agent
                <select value={agentSlug} onChange={(event) => setAgentSlug(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-line bg-bg px-3 text-body text-text outline-none focus:border-accent">
                  {agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.name} · {agent.role}</option>)}
                </select>
              </label>
              {error ? <p className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-caption text-warn">{error}</p> : null}
            </div>
            <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
              <button type="button" onClick={() => setOpen(false)} disabled={pending} className="h-10 rounded-lg border border-line px-4 text-body font-semibold text-text hover:border-accent disabled:opacity-50">Cancel</button>
              <button type="button" onClick={submit} disabled={pending} className="h-10 rounded-lg bg-accent px-5 text-body font-semibold text-bg hover:opacity-90 disabled:opacity-50">{pending ? "Starting…" : "Create summary"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
