import {
  applyWorkItemProposal,
  rejectWorkItemProposal,
} from "@/lib/work-items/actions";
import Link from "next/link";
import { proposalReviewPath } from "@/lib/work-items/proposal-links";
import type { ProposalRelatedItem } from "@/lib/work-items/proposal-review-context";

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
  agentSlug: string;
  sourceUrl?: string;
  relatedItems?: ProposalRelatedItem[];
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

function hasOwn(op: Op, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(op, key);
}

function previewValue(value: unknown): string {
  if (value === null) return "none";
  if (value === undefined) return "";
  if (typeof value === "string") return value.trim() || "(empty)";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fieldRows(op: Op): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, key: string) => {
    if (!hasOwn(op, key)) return;
    rows.push({ label, value: previewValue(op[key]) });
  };

  switch (op.op) {
    case "create_epic":
      add("Ref", "ref");
      add("Description", "description");
      add("Assignee", "assignee");
      add("Acting manager", "actingManager");
      break;
    case "create_task":
      add("Ref", "ref");
      add("Epic", "epic");
      add("Blocked by", "blockedBy");
      add("Description", "description");
      add("Assignee", "assignee");
      add("Acting manager", "actingManager");
      break;
    case "create_subtask":
      add("Ref", "ref");
      add("Parent", "parent");
      add("Description", "description");
      add("Assignee", "assignee");
      add("Acting manager", "actingManager");
      break;
    case "update_epic":
      add("Target", "target");
      add("Title", "title");
      add("Description", "description");
      add("Assignee", "assignee");
      add("Acting manager", "actingManager");
      add("Status", "status");
      add("Alert reporter", "alert_reporter");
      break;
    case "update_task":
      add("Target", "target");
      add("Title", "title");
      add("Description", "description");
      add("Epic", "epic");
      add("Parent", "parent");
      add("Blocked by", "blockedBy");
      add("Assignee", "assignee");
      add("Acting manager", "actingManager");
      add("Status", "status");
      break;
    case "comment_task":
      add("Target", "target");
      add("Comment", "body");
      break;
  }

  return rows;
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
  agentSlug?: string;
  proposals: ProposalForReview[];
}) {
  if (proposals.length === 0) return null;

  return (
    <div className="border-t border-line bg-panel-soft px-4 py-3 shrink-0 space-y-3">
      <div className="text-micro font-semibold uppercase tracking-wider text-accent">
        Work-item proposals awaiting your review ({proposals.length})
      </div>

      {proposals.map((proposal) => {
        const ops = parseOps(proposal.operations);
        const results = parseResults(proposal.validation);
        const errorCount = results.filter((r) => !r.ok).length;
        const resolvedAgentSlug = proposal.agentSlug || agentSlug;

        return (
          <div
            key={proposal.id}
            id={`proposal-${proposal.id}`}
            className="scroll-mt-24 rounded-card border border-line bg-panel p-3 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body font-semibold text-text">
                  {proposal.summary || `${ops.length} change${ops.length === 1 ? "" : "s"}`}
                </p>
                <p className="mt-0.5 text-nano text-text-muted">
                  {proposal.projectName} · @{proposal.agentSlug} · {ops.length} operation{ops.length === 1 ? "" : "s"}
                  {errorCount > 0 ? ` · ${errorCount} need attention` : ""}
                </p>
                <p className="mt-1 text-nano text-text-muted">
                  Published <time dateTime={proposal.createdAt}>{new Intl.DateTimeFormat("en-AU", {
                    timeZone: "Australia/Brisbane", dateStyle: "medium", timeStyle: "short",
                  }).format(new Date(proposal.createdAt))} AEST</time>
                </p>
                <div className="mt-1 flex gap-3 text-caption text-accent">
                  <Link href={proposalReviewPath(proposal.id)} className="hover:underline">Direct review link</Link>
                  {proposal.sourceUrl ? <Link href={proposal.sourceUrl} className="hover:underline">Original conversation</Link> : null}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <form action={applyWorkItemProposal}>
                  <input type="hidden" name="proposalId" value={proposal.id} />
                  {resolvedAgentSlug ? <input type="hidden" name="agentSlug" value={resolvedAgentSlug} /> : null}
                  <button
                    type="submit"
                    className="rounded-lg bg-accent px-control-x py-control-y text-caption font-medium text-bg hover:opacity-90"
                  >
                    Apply
                  </button>
                </form>
                <form action={rejectWorkItemProposal}>
                  <input type="hidden" name="proposalId" value={proposal.id} />
                  {resolvedAgentSlug ? <input type="hidden" name="agentSlug" value={resolvedAgentSlug} /> : null}
                  <button
                    type="submit"
                    className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium text-text-muted hover:border-crit hover:text-crit"
                  >
                    Reject
                  </button>
                </form>
              </div>
            </div>

            {proposal.relatedItems && proposal.relatedItems.length > 0 ? (
              <div className="mt-3 text-caption">
                <p className="font-medium text-text-muted">Related work · current status</p>
                <ul className="mt-1 space-y-1">
                  {proposal.relatedItems.map(item => (
                    <li key={`${item.kind}:${item.id}`} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-text-muted">{item.kind}</span>
                      {item.href ? <Link href={item.href} className="text-accent hover:underline">{item.label}</Link> : <span>{item.label}</span>}
                      <span className="rounded border border-line px-1.5 text-text">{item.status}</span>
                      {item.archived ? <span className="text-text-muted">Archived</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <details className="mt-3 rounded-lg border border-line bg-panel-soft">
              <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-3 py-2 text-caption font-medium text-text marker:text-text-muted">
                <span>Preview changes</span>
                <span className="text-nano font-normal text-text-muted">
                  {ops.length} operation{ops.length === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="max-h-[min(24rem,45vh)] overflow-y-auto border-t border-line p-3">
                <ul className="space-y-3">
                  {ops.map((op, i) => {
                    const label = opLabel(op);
                    const result = results[i];
                    const ok = result ? result.ok : true;
                    const rows = fieldRows(op);
                    return (
                      <li key={i} className="rounded-lg border border-line bg-panel p-2.5 text-caption">
                        <div className="flex items-start gap-2">
                          <span
                            className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                              ok ? "bg-accent" : "bg-crit"
                            }`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p>
                              <span className="font-medium text-text">{label.kind}:</span>{" "}
                              <span className="text-text">{label.title}</span>
                              {label.detail ? (
                                <span className="text-text-muted"> — {label.detail}</span>
                              ) : null}
                            </p>
                            {!ok && result?.errors.length ? (
                              <p className="mt-1 text-crit">⚠ {result.errors.join("; ")}</p>
                            ) : null}
                          </div>
                        </div>
                        {rows.length > 0 ? (
                          <dl className="mt-2 grid gap-1.5 border-t border-line pt-2">
                            {rows.map((row) => (
                              <div key={`${i}-${row.label}`} className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                                <dt className="font-medium text-text-muted">{row.label}</dt>
                                <dd className="min-w-0 whitespace-pre-wrap break-words text-text">
                                  {row.value}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          </div>
        );
      })}
    </div>
  );
}
