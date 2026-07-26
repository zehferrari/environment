import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { effectiveCommitPrefix, effectiveTaskCommitPrefix } from "@/lib/work-items/keys";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 * 4 });
  return String(stdout).trim();
}

// The production branch a contribution must land on to count as deployed:
// project override -> workspace default -> "main". (Mirrors the effective
// settings hierarchy without pulling the full resolver.)
async function productionBranchFor(projectId: string): Promise<string> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      deploymentProductionBranch: true,
      workspaces: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { workspace: { select: { deploymentProductionBranch: true } } },
      },
    },
  });
  return (
    project?.deploymentProductionBranch?.trim() ||
    project?.workspaces[0]?.workspace.deploymentProductionBranch?.trim() ||
    "main"
  );
}

// Has a contribution carrying `commitPrefix` in its subject landed on
// origin/<productionBranch>? Squash-safe: we match the commit MESSAGE, not the
// original sha (a squash-merge rewrites the sha but keeps the work-item prefix).
// Returns the landing commit sha, or null.
async function findLandedCommit(repoPath: string, productionBranch: string, commitPrefix: string) {
  const sha = await git(repoPath, [
    "log",
    `origin/${productionBranch}`,
    "--fixed-strings",
    `--grep=${commitPrefix}`,
    "-1",
    "--format=%H",
  ]).catch(() => "");
  return sha || null;
}

type DeployWatchProject = {
  slug: string;
  repositoryPath: string | null;
};

const deployProjectSelect = { slug: true, repositoryPath: true } as const;

async function markDeployed(args: {
  scope: "epic" | "task";
  id: string;
  projectId: string;
  from: string;
  branch: string;
  sha: string;
  prefix: string;
}) {
  await db.$transaction(async (tx) => {
    if (args.scope === "epic") {
      await tx.epic.update({ where: { id: args.id }, data: { deploymentStatus: "Successfully Deployed" } });
    } else {
      await tx.task.update({ where: { id: args.id }, data: { deploymentStatus: "Successfully Deployed" } });
    }
    await tx.activityLog.create({
      data: {
        projectId: args.projectId,
        ...(args.scope === "task" ? { taskId: args.id } : {}),
        kind: args.scope === "epic" ? "epic.deployment_status" : "task.deployment_status",
        payload: JSON.stringify({
          [args.scope === "epic" ? "epicId" : "taskId"]: args.id,
          from: args.from,
          to: "Successfully Deployed",
          via: "merge_detected",
          branch: args.branch,
          sha: args.sha,
          commitPrefix: args.prefix,
        }),
      },
    });
  });
  publishBoardTouch(args.projectId);
}

// Provider-agnostic deploy detection: for every epic cleared for merge (post
// deploy-review approve) and every standalone task opted into deployment,
// fetch origin once per repo and check whether the item's COMMIT_PREFIX now
// appears on the production branch; if so, resolve it to Successfully Deployed.
// Runs on the deployment-watcher poll alongside the Bitbucket-PR poller.
export async function pollDeploymentMerges(): Promise<{ checked: number; deployed: number }> {
  const [epics, tasks] = await Promise.all([
    db.epic.findMany({
      where: {
        deletedAt: null,
        deploymentStatus: "Deployment Approved",
        project: { repositoryPath: { not: null } },
      },
      select: {
        id: true,
        projectId: true,
        deploymentStatus: true,
        workItemKey: true,
        commitPrefix: true,
        project: { select: deployProjectSelect },
      },
    }),
    db.task.findMany({
      where: {
        deletedAt: null,
        epicId: null,
        parentTaskId: null,
        deploymentStatus: { in: ["Ready to Deploy", "Deployment Approved"] },
        project: { repositoryPath: { not: null } },
      },
      select: {
        id: true,
        projectId: true,
        deploymentStatus: true,
        workItemKey: true,
        commitPrefix: true,
        project: { select: deployProjectSelect },
      },
    }),
  ]);

  let checked = 0;
  let deployed = 0;
  // One fetch per repo per tick.
  const fetched = new Set<string>();
  const ensureFetched = async (repoPath: string) => {
    if (fetched.has(repoPath)) return;
    fetched.add(repoPath);
    await git(repoPath, ["fetch", "--quiet", "origin"]).catch(() => {});
  };

  for (const epic of epics) {
    const repoPath = (epic.project as DeployWatchProject).repositoryPath;
    if (!repoPath) continue;
    const prefix = effectiveCommitPrefix({ commitPrefix: epic.commitPrefix, workItemKey: epic.workItemKey });
    if (!prefix) continue;
    checked++;
    try {
      await ensureFetched(repoPath);
      const branch = await productionBranchFor(epic.projectId);
      const sha = await findLandedCommit(repoPath, branch, prefix);
      if (!sha) continue;
      await markDeployed({ scope: "epic", id: epic.id, projectId: epic.projectId, from: epic.deploymentStatus, branch, sha, prefix });
      deployed++;
    } catch (err) {
      console.error("[pm] merge detect (epic) failed:", epic.id, err);
    }
  }

  for (const task of tasks) {
    const repoPath = (task.project as DeployWatchProject).repositoryPath;
    if (!repoPath) continue;
    const prefix = effectiveTaskCommitPrefix({ workItemKey: task.workItemKey, commitPrefix: task.commitPrefix });
    if (!prefix) continue;
    checked++;
    try {
      await ensureFetched(repoPath);
      const branch = await productionBranchFor(task.projectId);
      const sha = await findLandedCommit(repoPath, branch, prefix);
      if (!sha) continue;
      await markDeployed({ scope: "task", id: task.id, projectId: task.projectId, from: task.deploymentStatus, branch, sha, prefix });
      deployed++;
    } catch (err) {
      console.error("[pm] merge detect (task) failed:", task.id, err);
    }
  }

  return { checked, deployed };
}
