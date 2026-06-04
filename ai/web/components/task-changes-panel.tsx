import Link from "next/link";
import { MessageTimestamp } from "@/components/message-avatar";
import type { TaskGitChangesResult, TaskGitFileDiffResult, TaskGitDiffLine } from "@/lib/tasks/git-changes";

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
  baseHref,
  selectedDiff,
}: {
  changes: TaskGitChangesResult;
  branchName: string | null;
  commitPrefix: string | null;
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
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Repository Changes</h3>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Local Git commits from the branch, filtered by commit prefix and this item&apos;s work window when available.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-[var(--color-text-muted)]">
            {branchName ? (
              <span className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 font-mono">
                {changes.ref ?? branchName}
              </span>
            ) : null}
            {commitPrefix ? (
              <span className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 font-mono">
                {commitPrefix}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {changes.error ? (
        <p className="rounded-xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/[0.06] px-4 py-3 text-sm text-[var(--color-text-muted)]">
          {changes.error}
        </p>
      ) : null}

      {!changes.error && changes.commits.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] bg-[var(--color-panel-soft)]/30 px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
          No matching commits found for this task yet.
        </p>
      ) : null}

      {selectedDiff ? (
        <DiffPanel diff={selectedDiff} baseHref={baseHref} />
      ) : null}

      <ol className="space-y-3">
        {changes.commits.map((commit) => (
          <li key={commit.hash} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <span className="font-mono text-[var(--color-accent)]">{commit.shortHash}</span>
                  <span>{commit.authorName}</span>
                  <MessageTimestamp value={commit.authoredAt} />
                </div>
                <h4 className="mt-1 break-words text-sm font-semibold text-[var(--color-text)]">
                  {commit.subject}
                </h4>
              </div>
              <span className="rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
                {commit.files.length} {commit.files.length === 1 ? "file" : "files"}
              </span>
            </div>
            {commit.files.length > 0 ? (
              <ul className="mt-3 max-h-56 space-y-1 overflow-auto border-t border-[var(--color-line)] pt-3 text-xs">
                {commit.files.map((file, index) => (
                  <li
                    key={`${commit.hash}:${index}`}
                    className={`grid grid-cols-[5rem_minmax(0,1fr)] gap-2 rounded-md px-1 py-0.5 ${
                      selectedKey === `${commit.hash}:${file.path}`
                        ? "bg-[var(--color-accent)]/[0.10]"
                        : ""
                    }`}
                  >
                    <span className="text-[var(--color-text-muted)]">{changeLabel(file.status)}</span>
                    <Link
                      href={fileHref(commit.hash, file.path)}
                      className="min-w-0 break-all font-mono text-[var(--color-text)] transition hover:text-[var(--color-accent)]"
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

function lineTone(type: TaskGitDiffLine["leftType"] | TaskGitDiffLine["rightType"]) {
  if (type === "remove") return "bg-[var(--color-crit)]/[0.08] text-[var(--color-text)]";
  if (type === "add") return "bg-[var(--color-ok)]/[0.08] text-[var(--color-text)]";
  if (type === "empty") return "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  return "bg-[var(--color-panel-soft)] text-[var(--color-text)]";
}

function DiffCell({
  no,
  text,
  type,
}: {
  no: number | null;
  text: string;
  type: TaskGitDiffLine["leftType"] | TaskGitDiffLine["rightType"];
}) {
  return (
    <div className={`grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] border-b border-[var(--color-line)]/60 ${lineTone(type)}`}>
      <span className="select-none border-r border-[var(--color-line)]/60 px-2 py-1 text-right font-mono text-[11px] text-[var(--color-text-muted)]">
        {no ?? ""}
      </span>
      <code className="min-w-0 whitespace-pre-wrap break-words px-2 py-1 font-mono text-[11px] leading-5">
        {text || " "}
      </code>
    </div>
  );
}

function DiffPanel({ diff, baseHref }: { diff: TaskGitFileDiffResult; baseHref: string }) {
  return (
    <section id="diff" className="scroll-mt-24 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs text-[var(--color-text-muted)]">Selected diff</div>
          <h3 className="break-all font-mono text-sm font-semibold text-[var(--color-text)]">
            {diff.filePath}
          </h3>
        </div>
        <Link
          href={`${baseHref}?tab=changes`}
          className="rounded-md border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:text-[var(--color-accent)]"
        >
          Close
        </Link>
      </div>
      {diff.error ? (
        <p className="px-4 py-3 text-sm text-[var(--color-text-muted)]">{diff.error}</p>
      ) : diff.lines.length === 0 ? (
        <p className="px-4 py-3 text-sm text-[var(--color-text-muted)]">No textual diff available for this file.</p>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <div className="min-w-[56rem]">
            <div className="grid grid-cols-2 border-b border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              <div className="border-r border-[var(--color-line)] px-3 py-2">Before</div>
              <div className="px-3 py-2">After</div>
            </div>
            {diff.lines.map((line, index) => (
              line.kind === "hunk" ? (
                <div
                  key={`${line.leftText}:${index}`}
                  className="border-b border-[var(--color-line)] bg-[var(--color-accent)]/[0.08] px-3 py-1 font-mono text-[11px] text-[var(--color-accent)]"
                >
                  {line.leftText}
                </div>
              ) : (
                <div key={`${line.leftNo}:${line.rightNo}:${index}`} className="grid grid-cols-2">
                  <div className="min-w-0 border-r border-[var(--color-line)]">
                    <DiffCell no={line.leftNo} text={line.leftText} type={line.leftType} />
                  </div>
                  <div className="min-w-0">
                    <DiffCell no={line.rightNo} text={line.rightText} type={line.rightType} />
                  </div>
                </div>
              )
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
