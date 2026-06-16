import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { MessageTimestamp } from "@/components/message-avatar";
import GitDiffPanel from "@/components/git-diff-panel";
import { listRepoBranches, getRepoBranchCommits, getTaskGitFileDiff } from "@/lib/tasks/git-changes";

export const dynamic = "force-dynamic";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function changeLabel(status: string) {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("M")) return "modified";
  if (status.startsWith("D")) return "deleted";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  return status.toLowerCase();
}

// Project "Changes" tab — repository commits across all branches (or a single
// selected branch), capped at the 100 most recent. Read-only list, no diff view.
export default async function ProjectChangesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ branch?: string | string[]; commit?: string | string[]; file?: string | string[] }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    select: { repositoryPath: true },
  });
  if (!project) notFound();
  if (!project.repositoryPath) notFound();

  const branches = await listRepoBranches(project.repositoryPath);
  const requestedBranch = single(sp.branch)?.trim() || "";
  const selectedBranch = branches.some((b) => b.name === requestedBranch) ? requestedBranch : "";

  const { commits, error } = await getRepoBranchCommits({
    repositoryPath: project.repositoryPath,
    branchName: selectedBranch || null,
  });

  const selectedCommit = single(sp.commit)?.trim() || "";
  const selectedFile = single(sp.file)?.trim() || "";
  const selectedDiff = selectedCommit && selectedFile
    ? await getTaskGitFileDiff({
        repositoryPath: project.repositoryPath,
        commitHash: selectedCommit,
        filePath: selectedFile,
      })
    : null;

  const basePath = `/projects/${slug}/changes`;
  const branchQuery = selectedBranch ? `branch=${encodeURIComponent(selectedBranch)}` : "";
  const closeHref = branchQuery ? `${basePath}?${branchQuery}` : basePath;
  const fileHref = (commitHash: string, path: string) => {
    const params = new URLSearchParams();
    if (selectedBranch) params.set("branch", selectedBranch);
    params.set("commit", commitHash);
    params.set("file", path);
    return `${basePath}?${params.toString()}#diff`;
  };
  const selectedKey = selectedDiff ? `${selectedDiff.commitHash}:${selectedDiff.filePath}` : null;

  return (
    <div className="space-y-section-gap">
      <form className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-panel p-3 text-body">
        <label className="block">
          <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">
            Branch
          </span>
          <select
            name="branch"
            defaultValue={selectedBranch}
            className="h-9 min-w-[16rem] rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
          >
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="h-9 rounded-lg bg-accent px-3 text-caption font-semibold text-bg hover:opacity-90"
        >
          Apply
        </button>
        <span className="ml-auto self-center text-caption text-text-muted">
          {commits.length} commit{commits.length === 1 ? "" : "s"}
          {selectedBranch ? "" : " across all branches"}
        </span>
      </form>

      {error ? (
        <p className="rounded-card border border-warn/30 bg-warn/[0.06] px-4 py-3 text-body text-text-muted">
          {error}
        </p>
      ) : null}

      {!error && commits.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-panel-soft/30 px-4 py-6 text-center text-body text-text-muted">
          No commits found.
        </p>
      ) : null}

      {selectedDiff ? <GitDiffPanel diff={selectedDiff} closeHref={closeHref} /> : null}

      <ol className="space-y-3">
        {commits.map((commit) => (
          <li key={commit.hash} className="rounded-card border border-line bg-panel-soft px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
                  <span className="font-mono text-accent">{commit.shortHash}</span>
                  <span>{commit.authorName}</span>
                  <MessageTimestamp value={commit.authoredAt} />
                </div>
                <h4 className="mt-1 break-words text-body font-semibold text-text">
                  {commit.subject}
                </h4>
              </div>
              <span className="rounded-md border border-line bg-bg px-2 py-1 text-micro text-text-muted">
                {commit.files.length} {commit.files.length === 1 ? "file" : "files"}
              </span>
            </div>
            {commit.files.length > 0 ? (
              <ul className="mt-3 max-h-56 space-y-1 overflow-auto border-t border-line pt-3 text-caption">
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
