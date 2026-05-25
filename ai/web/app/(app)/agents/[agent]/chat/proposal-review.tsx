import {
  applyWorkItemProposal,
  rejectWorkItemProposal,
} from "@/lib/work-items/actions";

// Pending work-item proposals an agent submitted (propose → approve).
// Server component: renders the change-set with per-op validation badges
// and Apply / Reject forms wired to the server actions. Nothing is on the
// board until the human applies here.

export type ProposalForReview = {
  id: string;
  summary: string | null;
  operations: string;
  validation: string | null;
  createdAt: string;
  projectName: string;
};

type Op = Record<string, unknown>;
type OpResult = { index: number; ok: boolean; errors: string[] };

function parseOps(raw: string): Op[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Op[]) : [];
  } catch {
    return [];
  }
}

function parseResults(raw: string | null): OpResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { results?: OpResult[] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function opLabel(op: Op): { kind: string; title: string; detail: string } {
  switch (op.op) {
    case "create_epic":
      return { kind: "Epic", title: str(op.title) || "(untitled)", detail: "new" };
    case "create_task":
      return {
        kind: "Task",
        title: str(op.title) || "(untitled)",
        detail: op.epic ? `epic ${str(op.epic)}` : "top-level",
      };
    case "create_subtask":
      return {
        kind: "Sub-task",
        title: str(op.title) || "(untitled)",
        detail: `parent ${str(op.parent)}`,
      };
    case "update_epic":
      return { kind: "Update epic", title: str(op.target), detail: "edit" };
    case "update_task":
      return { kind: "Update task", title: str(op.target), detail: "edit" };
    case "comment_task":
      return { kind: "Comment", title: str(op.target), detail: str(op.body).slice(0, 80) };
    default:
      return { kind: "Op", title: str(op.op) || "(unknown)", detail: "" };
  }
}

export default function ProposalReview({
  agentSlug,
  proposals,
}: {
  agentSlug: string;
  proposals: ProposalForReview[];
}) {
  if (proposals.length === 0) return null;

  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3 shrink-0 space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
        Work-item proposals awaiting your review ({proposals.length})
      </div>

      {proposals.map((proposal) => {
        const ops = parseOps(proposal.operations);
        const results = parseResults(proposal.validation);
        const errorCount = results.filter((r) => !r.ok).length;

        return (
          <div
            key={proposal.id}
            className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--color-text)]">
                  {proposal.summary || `${ops.length} change${ops.length === 1 ? "" : "s"}`}
                </p>
                <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                  {proposal.projectName} · {ops.length} operation{ops.length === 1 ? "" : "s"}
                  {errorCount > 0 ? ` · ${errorCount} need attention` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <form action={applyWorkItemProposal}>
                  <input type="hidden" name="proposalId" value={proposal.id} />
                  <input type="hidden" name="agentSlug" value={agentSlug} />
                  <button
                    type="submit"
                    className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
                  >
                    Apply
                  </button>
                </form>
                <form action={rejectWorkItemProposal}>
                  <input type="hidden" name="proposalId" value={proposal.id} />
                  <input type="hidden" name="agentSlug" value={agentSlug} />
                  <button
                    type="submit"
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:border-[var(--color-crit)] hover:text-[var(--color-crit)]"
                  >
                    Reject
                  </button>
                </form>
              </div>
            </div>

            <ul className="mt-2 space-y-1">
              {ops.map((op, i) => {
                const label = opLabel(op);
                const result = results[i];
                const ok = result ? result.ok : true;
                return (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <span
                      className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        ok ? "bg-[var(--color-accent)]" : "bg-[var(--color-crit)]"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="font-medium text-[var(--color-text)]">{label.kind}:</span>{" "}
                      <span className="text-[var(--color-text)]">{label.title}</span>
                      {label.detail ? (
                        <span className="text-[var(--color-text-muted)]"> — {label.detail}</span>
                      ) : null}
                      {!ok && result?.errors.length ? (
                        <span className="block text-[var(--color-crit)]">⚠ {result.errors.join("; ")}</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
