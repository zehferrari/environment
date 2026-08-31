import { notFound } from "next/navigation";
import VisualCode from "@/components/visual-code";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth/permissions";
import {
  canReadRepository,
  canWriteRepositoryFile,
  chooseCodeSource,
  getCodeGitState,
  listCodeSources,
  listRepositoryDirectory,
  normalizeRepoRelativePath,
  pathKind,
  readRepositoryFile,
} from "@/lib/projects/repo-code";

export const dynamic = "force-dynamic";

type CodeSearchParams = {
  source?: string | string[];
  path?: string | string[];
  blame?: string | string[];
};

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProjectCodePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<CodeSearchParams>;
}) {
  const [{ slug }, sp] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as CodeSearchParams),
  ]);
  const viewer = await requireViewer();
  if (!viewer.canAccessOwnerFeatures) notFound();
  const project = await db.project.findUnique({
    where: { slug },
    select: {
      slug: true,
      repositoryPath: true,
      deletedAt: true,
      deploymentProductionBranch: true,
      deploymentPrTargetBranch: true,
    },
  });
  if (!project || project.deletedAt || !project.repositoryPath) notFound();

  const canWriteSession = viewer.canAccessOwnerFeatures;
  const sources = await listCodeSources(project.repositoryPath);
  const source = chooseCodeSource(sources, sp.source);
  if (!source) notFound();

  const canRead = await canReadRepository(source.path);
  const relPath = normalizeRepoRelativePath(sp.path);
  const showBlame = single(sp.blame) === "1";
  const kind = canRead ? await pathKind(source, relPath) : "missing";
  const browserPath =
    kind === "file"
      ? parentPath(relPath)
      : kind === "dir"
        ? relPath
        : "";
  const [entries, fileView] = await Promise.all([
    canRead ? listRepositoryDirectory(source, browserPath) : Promise.resolve([]),
    canRead && kind === "file"
      ? readRepositoryFile(source, relPath, showBlame)
      : Promise.resolve(null),
  ]);
  const writeCapability = canWriteSession && canRead && kind === "file"
    ? await canWriteRepositoryFile(source, relPath)
    : {
        ok: false,
        reason: canWriteSession
          ? "Open a writable text file to edit."
          : "Only logged-in human users can run code actions.",
      };
  const targetBranch = project.deploymentPrTargetBranch ?? project.deploymentProductionBranch ?? "main";
  const git = await getCodeGitState(source, sources, targetBranch).catch((error) => ({
    targetBranch,
    targetSourceId: null,
    sourceBranch: source.branch,
    sourceHead: source.head,
    sourceDirty: false,
    sourceStatusCount: 0,
    targetDirty: false,
    targetStatusCount: 0,
    compareUrl: null,
    originLabel: null,
    canOpenPullRequest: false,
    canMerge: false,
    mergeBlockedReason: null,
    error: error instanceof Error ? error.message : "Git status unavailable.",
  }));

  return (
    <div className="space-y-section-gap">
      {!canRead ? (
        <p className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-body text-crit">
          This service cannot read the selected repository folder.
        </p>
      ) : null}

      {kind === "missing" && relPath ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-body text-warn">
          The selected path no longer exists in this source.
        </p>
      ) : null}

      <VisualCode
        activePath={kind === "file" ? relPath : ""}
        browserPath={browserPath}
        entries={entries}
        file={fileView}
        git={git}
        kind={kind}
        relPath={relPath}
        showBlame={showBlame}
        slug={project.slug}
        source={source}
        sources={sources}
        canWrite={canWriteSession}
        canEditFile={writeCapability.ok}
        canWriteReason={writeCapability.reason}
      />
    </div>
  );
}

function parentPath(relPath: string) {
  const parent = relPath ? relPath.split("/").slice(0, -1).join("/") : "";
  return parent === "." ? "" : parent;
}
