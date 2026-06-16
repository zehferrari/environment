import Link from "next/link";
import { MessageTimestamp } from "@/components/message-avatar";
import GitDiffPanel from "@/components/git-diff-panel";
import type { TaskGitChangesResult, TaskGitFileDiffResult } from "@/lib/tasks/git-changes";

function changeLabel(status: string) {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("M")) return "modified";
  if (status.startsWith("D")) return "deleted";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  return status.toLowerCase();
}

export default function TaskChangesPanel({
  changes,
  branchName,
  commitPrefix,
  commitPrefixes,
  scopeLabel = "task",
  baseHref,
  selectedDiff,
}: {
  changes: TaskGitChangesResult;
  branchName: string | null;
  commitPrefix: string | null;
  commitPrefixes?: string[];
  scopeLabel?: string;
  baseHref: string;
  selectedDiff: TaskGitFileDiffResult | null;
}) {
  const fileHref = (commitHash: string, path: string) => {
    const params = new URLSearchParams({ tab: "changes", commit: commitHash, file: path });
    return `${baseHref}?${params.toString()}#diff`;
  };
  const selectedKey = selectedDiff ? `${selectedDiff.commitHash}:${selectedDiff.filePath}` : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-panel-soft px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text">Repository Changes</h3>
            <p className="mt-1 text-xs text-text-muted">
              Local Git commits from the branch, filtered by commit prefix and this {scopeLabel}&apos;s work window when available.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-text-muted">
            {branchName ? (
              <span className="rounded-md border border-line bg-bg px-2 py-1 font-mono">
                {changes.ref ?? branchName}
              </span>
            ) : null}
            {(commitPrefixes && commitPrefixes.length > 0 ? commitPrefixes : commitPrefix ? [commitPrefix] : []).slice(0, 12).map((prefix) => (
              <span key={prefix} className="rounded-md border border-line bg-bg px-2 py-1 font-mono">
                {prefix}
              </span>
            ))}
            {commitPrefixes && commitPrefixes.length > 12 ? (
              <span className="rounded-md border border-line bg-bg px-2 py-1">
                +{commitPrefixes.length - 12}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {changes.error ? (
        <p className="rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3 text-sm text-text-muted">
          {changes.error}
        </p>
      ) : null}

      {!changes.error && changes.commits.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-panel-soft/30 px-4 py-6 text-center text-sm text-text-muted">
          No matching commits found for this {scopeLabel} yet.
        </p>
      ) : null}

      {selectedDiff ? (
        <GitDiffPanel diff={selectedDiff} closeHref={`${baseHref}?tab=changes`} />
      ) : null}

      <ol className="space-y-3">
        {changes.commits.map((commit) => (
          <li key={commit.hash} className="rounded-xl border border-line bg-panel-soft px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <span className="font-mono text-accent">{commit.shortHash}</span>
                  <span>{commit.authorName}</span>
                  <MessageTimestamp value={commit.authoredAt} />
                </div>
                <h4 className="mt-1 break-words text-sm font-semibold text-text">
                  {commit.subject}
                </h4>
              </div>
              <span className="rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-text-muted">
                {commit.files.length} {commit.files.length === 1 ? "file" : "files"}
              </span>
            </div>
            {commit.files.length > 0 ? (
              <ul className="mt-3 max-h-56 space-y-1 overflow-auto border-t border-line pt-3 text-xs">
                {commit.files.map((file, index) => (
                  <li
                    key={`${commit.hash}:${index}`}
                    className={`grid grid-cols-[5rem_minmax(0,1fr)] gap-2 rounded-md px-1 py-0.5 ${
                      selectedKey === `${commit.hash}:${file.path}`
                        ? "bg-accent/[0.10]"
                        : ""
                    }`}
                  >
                    <span className="text-text-muted">{changeLabel(file.status)}</span>
                    <Link
                      href={fileHref(commit.hash, file.path)}
                      className="min-w-0 break-all font-mono text-text transition hover:text-accent"
                    >
                      {file.path}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
