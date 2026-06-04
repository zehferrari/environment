import React from "react";
import Link from "next/link";
import { canShowDeploymentForTask, DEPLOYMENT_STATUSES } from "@/lib/deploy/deployment-status";

export type DeploymentPrRow = {
  id: string;
  provider: string;
  providerPrId: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  latestCommitSha: string;
  status: string;
  updatedAt: Date | string;
  task?: { workItemKey?: string | null; title?: string | null } | null;
};

export function canShowDeploymentTab(item: { epicId?: string | null; parentTaskId?: string | null } | "epic") {
  if (item === "epic") return true;
  return canShowDeploymentForTask(item);
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
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Deployment status
      </span>
      <select
        form={formId}
        name="deploymentStatus"
        defaultValue={defaultValue}
        className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
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
}) {
  return (
    args.provider.toLowerCase() === "bitbucket" &&
    args.viewerKind === "human" &&
    Boolean(args.viewerId && args.reporterId && args.viewerId === args.reporterId)
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "Deployment Approved": return "Approved";
    case "Successfully Deployed": return "Succeeded";
    case "Deployment Error": return "Error";
    default: return status || "Not Required";
  }
}

function prTitle(row: DeploymentPrRow, fallbackTitle: string) {
  const prefix = row.task?.workItemKey ? `${row.task.workItemKey}: ` : "";
  return `${prefix}${row.task?.title || fallbackTitle}`;
}

function mergeState(row: DeploymentPrRow) {
  const status = row.status.toLowerCase();
  if (["merged", "fulfilled"].includes(status)) return "Merged";
  if (["declined", "rejected"].includes(status)) return "Declined";
  return "Waiting for merge";
}

function approvalState(deploymentStatus: string) {
  return deploymentStatus === "Not Required" ? "Not required" : "Approved";
}

function deployResult(row: DeploymentPrRow, deploymentStatus: string) {
  const status = row.status.toLowerCase();
  if (deploymentStatus === "Successfully Deployed") return "Deploy script succeeded";
  if (deploymentStatus === "Deployment Error") return "Deploy script failed";
  if (["failed", "error"].includes(status)) return "Pipeline failed";
  if (["merged", "fulfilled"].includes(status)) return "Awaiting deployment result";
  return "Pipeline pending";
}

function errorExcerpt(row: DeploymentPrRow, deploymentStatus: string) {
  if (deploymentStatus === "Deployment Error") {
    return "Deployment failed; monitor will attach the captured log excerpt when available.";
  }
  if (["failed", "error"].includes(row.status.toLowerCase())) {
    return "Provider reported a failed PR/pipeline state; full log excerpt pending monitor update.";
  }
  return null;
}

function StatusPill({ children }: { children: string }) {
  return (
    <span className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)]">
      {children}
    </span>
  );
}

function DeploymentActions({ row, canAct }: { row: DeploymentPrRow; canAct: boolean }) {
  if (row.provider.toLowerCase() !== "bitbucket") {
    return <span className="text-xs text-[var(--color-text-muted)]">Actions unavailable for {row.provider}</span>;
  }
  if (!canAct) {
    return <span className="text-xs text-[var(--color-text-muted)]">Reporter-only actions</span>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled className="rounded-lg border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-text-muted)] opacity-70">
        Approve
      </button>
      <button type="button" disabled className="rounded-lg border border-[var(--color-line)] px-2 py-1 text-xs text-[var(--color-text-muted)] opacity-70">
        Merge
      </button>
    </div>
  );
}

export default function DeploymentTab({
  mode,
  title,
  deploymentStatus,
  rows,
  canAct,
}: {
  mode: "task" | "epic";
  title: string;
  deploymentStatus: string;
  rows: DeploymentPrRow[];
  canAct: (row: DeploymentPrRow) => boolean;
}) {
  const mockedRows = rows.length > 0 ? rows : [{
    id: "mock-deployment-record",
    provider: "bitbucket",
    providerPrId: "pending",
    url: "",
    sourceBranch: "work branch pending",
    targetBranch: "main",
    latestCommitSha: "pending",
    status: deploymentStatus === "Not Required" ? "not-required" : "open",
    updatedAt: new Date(0),
  }];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Deployment</div>
          <div className="mt-1 text-sm text-[var(--color-text-muted)]">
            {mode === "epic" ? "Epic child PR rollup" : "Top-level task PR"}
          </div>
        </div>
        <StatusPill>{statusLabel(deploymentStatus)}</StatusPill>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--color-line)]">
        <table className="min-w-full divide-y divide-[var(--color-line)] text-sm">
          <thead className="bg-[var(--color-panel-soft)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
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
          <tbody className="divide-y divide-[var(--color-line)]">
            {mockedRows.map((row) => {
              const excerpt = errorExcerpt(row, deploymentStatus);
              return (
                <tr key={row.id} className="align-top">
                  <td className="px-3 py-3">
                    <div className="font-medium text-[var(--color-text)]">
                      {row.url ? <Link className="underline decoration-dotted" href={row.url}>{prTitle(row, title)}</Link> : prTitle(row, title)}
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">{row.provider} · {row.providerPrId} · {row.status}</div>
                  </td>
                  <td className="px-3 py-3 text-xs text-[var(--color-text-muted)]">
                    <code>{row.sourceBranch}</code> → <code>{row.targetBranch}</code>
                  </td>
                  <td className="px-3 py-3"><code className="text-xs">{row.latestCommitSha.slice(0, 12)}</code></td>
                  <td className="px-3 py-3"><StatusPill>{approvalState(deploymentStatus)}</StatusPill></td>
                  <td className="px-3 py-3 text-xs text-[var(--color-text-muted)]">{mergeState(row)}</td>
                  <td className="px-3 py-3 text-xs text-[var(--color-text-muted)]">
                    <div>{deployResult(row, deploymentStatus)}</div>
                    {excerpt ? <pre className="mt-2 max-w-xs whitespace-pre-wrap rounded-lg bg-[var(--color-bg)] p-2 font-mono text-[11px]">{excerpt}</pre> : null}
                  </td>
                  <td className="px-3 py-3"><DeploymentActions row={row} canAct={canAct(row)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
