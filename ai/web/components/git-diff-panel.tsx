import Link from "next/link";
import type { TaskGitFileDiffResult, TaskGitDiffLine } from "@/lib/tasks/git-changes";

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

// Side-by-side unified-diff viewer shared by the Task/Epic "Changes" tabs and the
// project-level "Changes" tab. `closeHref` returns to the commit list.
export default function GitDiffPanel({
  diff,
  closeHref,
}: {
  diff: TaskGitFileDiffResult;
  closeHref: string;
}) {
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
          href={closeHref}
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
