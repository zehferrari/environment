import { renderFullMarkdown } from "@/lib/markdown";
import { reviewBillingRun } from "@/lib/billing/actions";
import BillingRunRefresh from "@/components/billing-run-refresh";

type RunEvent = { seq: number; kind: string; payload: string };
type RunDay = { day: string; summary: string; estimatedMinutes: number };

function payload(raw: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function append(current: string, event: Record<string, unknown>) {
  if (event.replace && typeof event.text === "string") return event.text;
  if (typeof event.delta === "string") return current + event.delta;
  if (typeof event.text === "string") return current + event.text;
  return current;
}

function visibleRunOutput(events: RunEvent[], savedResponse: string | null) {
  let reasoning = "";
  let response = "";
  const progress: string[] = [];
  for (const event of events) {
    const data = payload(event.payload);
    if (event.kind === "reasoning") reasoning = append(reasoning, data);
    if (event.kind === "partial" || event.kind === "final") response = append(response, data);
    if (event.kind === "status") {
      const status = typeof data.statusKind === "string" ? data.statusKind : typeof data.runStatus === "string" ? data.runStatus : null;
      if (status && progress.at(-1) !== status) progress.push(status);
    }
    if (event.kind === "tool") {
      const tool = typeof data.toolName === "string" ? data.toolName : "tool";
      const status = typeof data.toolStatus === "string" ? data.toolStatus : "used";
      const line = `${tool} · ${status}`;
      if (progress.at(-1) !== line) progress.push(line);
    }
  }
  return { reasoning: reasoning.trim(), response: (savedResponse || response).trim(), progress };
}

export default function BillingRunPanel({
  run,
}: {
  run: {
    id: string;
    generation: number;
    status: string;
    response: string | null;
    error: string | null;
    createdAt: Date;
    events: RunEvent[];
    days: RunDay[];
  };
}) {
  const active = run.status === "queued" || run.status === "running";
  const candidate = run.status === "ready";
  const output = visibleRunOutput(run.events, run.response);
  return (
    <section className={`space-y-3 rounded-card border p-4 ${candidate ? "border-accent/50 bg-accent/[0.04]" : "border-line bg-panel"}`}>
      <BillingRunRefresh active={active} />
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-semibold text-text">
          {candidate ? "New candidate" : run.status === "accepted" ? "Accepted summary" : `Generation ${run.generation}`}
        </h3>
        <span className="rounded-full border border-line px-2 py-0.5 text-nano uppercase tracking-wider text-text-muted">{run.status}</span>
        <span className="text-caption text-text-muted">{run.createdAt.toLocaleString("en-AU")}</span>
      </div>

      {output.progress.length > 0 ? (
        <p className="text-caption text-text-muted">{output.progress.join(" → ")}</p>
      ) : active ? (
        <p className="text-caption text-text-muted">Queued for the agent… this panel refreshes automatically.</p>
      ) : null}

      {output.reasoning ? (
        <details open={active} className="rounded-lg border border-line bg-panel-soft px-3 py-2">
          <summary className="cursor-pointer text-caption font-semibold text-text">Visible reasoning and progress</summary>
          <div className="md mt-2 text-caption text-text-muted" dangerouslySetInnerHTML={renderFullMarkdown(output.reasoning)} />
        </details>
      ) : null}

      {output.response ? (
        <div>
          <div className="mb-1 text-caption font-semibold text-text">Agent response</div>
          <div className="md rounded-lg border border-line bg-bg px-3 py-2 text-body" dangerouslySetInnerHTML={renderFullMarkdown(output.response)} />
        </div>
      ) : null}

      {run.error ? <p className="text-caption text-warn">{run.error}</p> : null}
      {candidate ? (
        <div className="space-y-3 border-t border-line pt-3">
          <div className="space-y-1">
            {run.days.map((day) => (
              <div key={day.day} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-panel-soft px-3 py-2 text-caption">
                <span><span className="mr-2 font-mono text-text-muted">{day.day}</span>{day.summary}</span>
                <span className="font-mono font-semibold text-accent">{(day.estimatedMinutes / 60).toFixed(1)} h</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-caption text-text-muted">
              Review this candidate, then replace the current summary or keep it.
            </p>
            <div className="flex gap-2">
              <form action={reviewBillingRun}>
                <input type="hidden" name="runId" value={run.id} />
                <input type="hidden" name="decision" value="discard" />
                <button className="h-9 rounded-lg border border-line bg-panel px-3 text-caption font-semibold text-text hover:border-accent">Discard</button>
              </form>
              <form action={reviewBillingRun}>
                <input type="hidden" name="runId" value={run.id} />
                <input type="hidden" name="decision" value="accept" />
                <button className="h-9 rounded-lg bg-accent px-4 text-caption font-semibold text-bg hover:opacity-90">Accept new summary</button>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
