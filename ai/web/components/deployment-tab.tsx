import React from "react";
import Link from "next/link";
import {
  canShowDeploymentForTask,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_PR_LOCAL_CHANGES_PENDING,
} from "@/lib/deploy/deployment-status";

export type DeploymentPrRow = {
  id: string;
  provider: string;
  providerPrId: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  latestCommitSha: string;
  status: string;
  localChangeSummary?: string | null;
  localChangeApprovedAt?: Date | string | null;
  localChangeApprovedById?: string | null;
  deploymentExitCode?: number | null;
  deploymentStdout?: string | null;
  deploymentStderr?: string | null;
  deploymentReportedAt?: Date | string | null;
  updatedAt: Date | string;
  task?: { workItemKey?: string | null; title?: string | null } | null;
};

const LOCAL_CHANGES_PENDING = DEPLOYMENT_PR_LOCAL_CHANGES_PENDING;

export function canShowDeploymentTab(item: { epicId?: string | null; parentTaskId?: string | null } | "epic") {
  if (item === "epic") return true;
  return item.epicId == null && canShowDeploymentForTask(item);
}

export function DeploymentStatusSelect({
  formId,
  defaultValue,
}: {
  formId: string;
  defaultValue: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">
        Deployment status
      </span>
      <select
        form={formId}
        name="deploymentStatus"
        defaultValue={defaultValue}
        className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption outline-none focus:border-accent"
        aria-label="Deployment status"
      >
        {DEPLOYMENT_STATUSES.map((status) => (
          <option key={status} value={status}>{status}</option>
        ))}
      </select>
    </label>
  );
}

export function canShowDeploymentAction(args: {
  provider: string;
  viewerKind: string;
  viewerId: string | null;
  reporterId: string | null;
  reviewerId?: string | null;
  onlyReportersCanApprovePullRequests?: boolean;
}) {
  const isReporter = Boolean(args.viewerId && args.reporterId && args.viewerId === args.reporterId);
  const isReviewer = Boolean(args.viewerId && args.reviewerId && args.viewerId === args.reviewerId);
  return (
    args.provider.toLowerCase() === "bitbucket" &&
    args.viewerKind === "human" &&
    (args.onlyReportersCanApprovePullRequests ? isReporter : isReporter || isReviewer)
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "Ready to Deploy": return "Ready to Deploy";
    case "Deployment Approved": return "Approved";
    case "Successfully Deployed": return "Deployed";
    case "Deployment Error": return "Error";
    default: return status || "Not Required";
  }
}

// The deploy pipeline stage, in plain language, for the git-detection model.
function deployStageNote(mode: "task" | "epic", status: string, productionBranch: string | null) {
  const prod = productionBranch ?? "the production branch";
  switch (status) {
    case "Ready to Deploy":
      return mode === "epic"
        ? "Awaiting the pre-merge deploy review of the whole contribution (Deploy Reviewer, or the monitor agent)."
        : `Cleared for deployment. Watching origin/${prod} for the commit prefix — it resolves to Deployed automatically once the work lands there.`;
    case "Deployment Approved":
      return `Review approved — cleared for merge. Watching origin/${prod} for the commit prefix; it resolves to Deployed automatically once the work lands there.`;
    case "Successfully Deployed":
      return `The contribution has landed on origin/${prod}.`;
    case "Deployment Error":
      return "The deployment failed — see the details below.";
    default:
      return `Deployment is not required for this ${mode === "epic" ? "Epic" : "task"} (optional post-Done step).`;
  }
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-nano font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-caption text-text">{value}</div>
    </div>
  );
}

function prTitle(row: DeploymentPrRow, fallbackTitle: string) {
  const prefix = row.task?.workItemKey ? `${row.task.workItemKey}: ` : "";
  return `${prefix}${row.task?.title || fallbackTitle}`;
}

// Row statuses are the monitor's actual vocabulary: `open`,
// `local_changes_pending_approval`, then one terminal value —
// `deployed` | `deployment_error` | `declined` | `pipeline_failed`
// (DEPLOYMENT_PR_TERMINAL_STATUSES). State is per-row: the scope-level
// deploymentStatus is a rollup and must not colour sibling rows.
function mergeState(row: DeploymentPrRow) {
  switch (row.status) {
    case LOCAL_CHANGES_PENDING: return "PR not opened";
    case "declined": return "Declined";
    case "pipeline_failed": return "Pipeline failed";
    case "deployed":
    case "deployment_error": return "Merged";
    default: return "Waiting for merge";
  }
}

function approvalState(row: DeploymentPrRow, deploymentStatus: string) {
  if (row.status === LOCAL_CHANGES_PENDING) return "Local commit approval needed";
  if (row.localChangeApprovedAt) return "Local changes approved";
  return deploymentStatus === "Not Required" ? "Not required" : "Approved";
}

function deployResult(row: DeploymentPrRow) {
  switch (row.status) {
    case LOCAL_CHANGES_PENDING: return "Waiting for local commit approval";
    case "deployed": return "Deploy script succeeded";
    case "deployment_error": return "Deploy script failed";
    case "pipeline_failed": return "Not run (pipeline failed)";
    case "declined": return "Not run (PR declined)";
    default: return "Pending merge";
  }
}

function errorExcerpt(row: DeploymentPrRow) {
  if (row.status === LOCAL_CHANGES_PENDING) {
    return row.localChangeSummary
      ? `Uncommitted local changes:\n${row.localChangeSummary}`
      : "Uncommitted local changes are waiting for approval.";
  }
  if (row.status === "deployment_error" || row.status === "pipeline_failed") {
    const log = row.deploymentStderr?.trim() || row.deploymentStdout?.trim() || "";
    const head = row.deploymentExitCode != null ? `Exit code ${row.deploymentExitCode}` : "Failed";
    return log ? `${head}\n${log.slice(-2000)}` : `${head}; no log excerpt was captured.`;
  }
  return null;
}

function StatusPill({ children }: { children: string }) {
  return (
    <span className="inline-flex rounded-full border border-line bg-bg px-2 py-0.5 text-micro font-medium text-text-muted">
      {children}
    </span>
  );
}

function DeploymentActions({
  row,
  canAct,
  approveLocalChangesAction,
  approveAndMergeAction,
}: {
  row: DeploymentPrRow;
  canAct: boolean;
  approveLocalChangesAction?: (formData: FormData) => void | Promise<void>;
  approveAndMergeAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (row.provider.toLowerCase() !== "bitbucket") {
    return <span className="text-caption text-text-muted">Actions unavailable for {row.provider}</span>;
  }
  if (!canAct) {
    return <span className="text-caption text-text-muted">Reporter-only actions</span>;
  }
  if (row.status === LOCAL_CHANGES_PENDING) {
    if (!approveLocalChangesAction) {
      return (
        <button type="button" disabled className="rounded-lg border border-line px-2 py-1 text-caption text-text-muted opacity-70">
          Approve local commit
        </button>
      );
    }
    return (
      <form action={approveLocalChangesAction}>
        <input type="hidden" name="deploymentPrId" value={row.id} />
        <button type="submit" className="rounded-lg border border-line bg-bg px-2 py-1 text-caption font-medium text-text hover:border-accent hover:text-accent">
          Approve local commit
        </button>
      </form>
    );
  }
  if (row.status !== "open") {
    return <span className="text-caption text-text-muted">No action</span>;
  }
  if (!approveAndMergeAction) {
    return (
      <button type="button" disabled className="rounded-lg border border-line px-2 py-1 text-caption text-text-muted opacity-70">
        Approve/Merge
      </button>
    );
  }
  return (
    <form action={approveAndMergeAction}>
      <input type="hidden" name="deploymentPrId" value={row.id} />
      <button type="submit" className="rounded-lg border border-line bg-bg px-2 py-1 text-caption font-medium text-text hover:border-accent hover:text-accent">
        Approve/Merge
      </button>
    </form>
  );
}

export default function DeploymentTab({
  mode,
  title,
  deploymentStatus,
  branchName,
  commitPrefix,
  productionBranch,
  rows,
  canAct,
  approveLocalChangesAction,
  approveAndMergeAction,
}: {
  mode: "task" | "epic";
  title: string;
  deploymentStatus: string;
  branchName?: string | null;
  commitPrefix?: string | null;
  productionBranch?: string | null;
  rows: DeploymentPrRow[];
  canAct: (row: DeploymentPrRow) => boolean;
  approveLocalChangesAction?: (formData: FormData) => void | Promise<void>;
  approveAndMergeAction?: (formData: FormData) => void | Promise<void>;
}) {
  // The deploy state, independent of any Bitbucket PR rows: which stage the
  // work is at, and the branch/prefix/production-branch the merge-detection
  // watches for. This renders whether or not the Bitbucket-PR path is in use.
  const statePanel = (
    <div className="space-y-3 rounded-card border border-line bg-panel-soft p-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">Deployment</div>
          <div className="mt-1 text-body text-text-muted">
            {mode === "epic" ? "Whole-Epic contribution" : "Standalone task"}
          </div>
        </div>
        <StatusPill>{statusLabel(deploymentStatus)}</StatusPill>
      </div>
      <p className="text-caption text-text-muted">{deployStageNote(mode, deploymentStatus, productionBranch ?? null)}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <InfoCell label="Branch" value={branchName || "—"} />
        <InfoCell label="Commit prefix" value={commitPrefix || "—"} />
        <InfoCell label="Production branch" value={productionBranch || "main"} />
      </div>
    </div>
  );

  if (rows.length === 0) {
    return (
      <div className="space-y-section-gap">
        {statePanel}
        {deploymentStatus === "Deployment Approved" || deploymentStatus === "Ready to Deploy" ? (
          <div className="rounded-card border border-line bg-panel-soft p-card text-caption text-text-muted">
            No Bitbucket pull-request rows for this {mode === "epic" ? "Epic" : "task"}. Deployment resolves by detecting the
            commit prefix on the production branch — a human (or CI) performs the merge; the poller does the rest. Provider PR
            rows appear here only when the Bitbucket monitor path is configured and a human sets “Deployment Approved”.
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-section-gap">
      {statePanel}

      <div className="overflow-x-auto rounded-card border border-line">
        <table className="min-w-full divide-y divide-line text-body">
          <thead className="bg-panel-soft text-left text-micro uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-3 py-2">PR</th>
              <th className="px-3 py-2">Branches</th>
              <th className="px-3 py-2">Latest commit</th>
              <th className="px-3 py-2">Approval</th>
              <th className="px-3 py-2">Merge</th>
              <th className="px-3 py-2">Deploy result</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const excerpt = errorExcerpt(row);
              return (
                <tr key={row.id} className="align-top">
                  <td className="px-3 py-3">
                    <div className="font-medium text-text">
                      {row.url ? <Link className="underline decoration-dotted" href={row.url}>{prTitle(row, title)}</Link> : prTitle(row, title)}
                    </div>
                    <div className="mt-1 text-caption text-text-muted">{row.provider} · {row.providerPrId} · {row.status.replace(/_/g, " ")}</div>
                  </td>
                  <td className="px-3 py-3 text-caption text-text-muted">
                    <code>{row.sourceBranch}</code> → <code>{row.targetBranch}</code>
                  </td>
                  <td className="px-3 py-3"><code className="text-caption">{row.latestCommitSha.slice(0, 12)}</code></td>
                  <td className="px-3 py-3"><StatusPill>{approvalState(row, deploymentStatus)}</StatusPill></td>
                  <td className="px-3 py-3 text-caption text-text-muted">{mergeState(row)}</td>
                  <td className="px-3 py-3 text-caption text-text-muted">
                    <div>{deployResult(row)}</div>
                    {excerpt ? <pre className="mt-2 max-w-xs whitespace-pre-wrap rounded-lg bg-bg p-2 font-mono text-micro">{excerpt}</pre> : null}
                  </td>
                  <td className="px-3 py-3">
                    <DeploymentActions
                      row={row}
                      canAct={canAct(row)}
                      approveLocalChangesAction={approveLocalChangesAction}
                      approveAndMergeAction={approveAndMergeAction}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
