// ENV-123 — the execution strip.
//
// The task description for this work is explicit about what an operator must be
// able to read off the task without opening the comment history:
//
//   Execution: stalled
//   Reason: no active run
//   Last durable action: started at 09:24
//   Recovery: new run queued
//
// This component is the only renderer of those four lines in the UI. It takes
// the already-rendered shape from `lib/agents/watchdog/state.ts` so the page,
// the board badge and the agent context block cannot drift apart.
//
// It renders nothing when there is no row. A task the watchdog has never
// evaluated genuinely has no known execution state, and inventing "idle" for it
// would be exactly the guessing this task exists to remove.

import {
  renderExecutionState,
  type ExecutionState,
} from "@/lib/agents/watchdog/state";

export interface TaskExecutionStateRow {
  state: string;
  reasonCode: string | null;
  reasonDetail: string | null;
  lastDurableAction: string | null;
  lastDurableActionAt: Date | null;
  recoveryAction: string | null;
  recoveryAt: Date | null;
  detectorId: string | null;
  escalatedAt: Date | null;
  updatedAt: Date;
}

const STATE_TONE: Record<ExecutionState, string> = {
  running: "text-ok",
  idle: "text-text-muted",
  stalled: "text-crit",
  blocked: "text-warn",
  waiting_review: "text-accent",
};

/** Compact one-word cue for the board card. Exported for the badge. */
export function executionStateTone(state: string): string {
  return STATE_TONE[state as ExecutionState] ?? "text-text-muted";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="shrink-0 text-nano font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words text-caption text-text">{value}</span>
    </div>
  );
}

export function TaskExecutionStrip({
  executionState,
}: {
  executionState: TaskExecutionStateRow | null | undefined;
}) {
  if (!executionState) return null;
  const rendered = renderExecutionState(executionState);

  return (
    <div
      data-task-execution-strip
      data-execution-state={rendered.state}
      className="space-y-1 rounded-card border border-line bg-panel-soft p-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-nano font-semibold uppercase tracking-wider text-text-muted">
          Execution
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-caption font-semibold ${executionStateTone(rendered.state)}`}
        >
          {rendered.state.replaceAll("_", " ")}
        </span>
      </div>
      {rendered.reason ? <Row label="Reason" value={rendered.reason} /> : null}
      {rendered.lastDurableAction ? (
        <Row label="Last durable action" value={rendered.lastDurableAction} />
      ) : null}
      {rendered.recovery ? <Row label="Recovery" value={rendered.recovery} /> : null}
      <p className="text-nano text-text-muted">
        {executionState.escalatedAt
          ? "PM stopped auto-recovering this task and escalated it. It needs a human look."
          : "Observed by PM's workflow watchdog — no need to infer this from the comments."}
      </p>
    </div>
  );
}
