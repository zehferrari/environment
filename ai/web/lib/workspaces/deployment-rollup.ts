import { DEPLOYMENT_STATUSES, type DeploymentStatus } from "@/lib/deploy/deployment-status";
import type { db as appDb } from "@/lib/db";

export type DeploymentRollupCounts = Record<DeploymentStatus, number>;

export type DeploymentRollup = {
  total: number;
  counts: DeploymentRollupCounts;
};

type DeploymentStatusCountRow = {
  projectId: string;
  deploymentStatus: string;
  _count: { _all: number };
};

type DeploymentDb = Pick<typeof appDb, "epic" | "task">;

export function emptyDeploymentRollup(): DeploymentRollup {
  return {
    total: 0,
    counts: Object.fromEntries(DEPLOYMENT_STATUSES.map((status) => [status, 0])) as DeploymentRollupCounts,
  };
}

export function addDeploymentCount(rollup: DeploymentRollup, status: string | null | undefined, count: number) {
  if (!isKnownDeploymentStatus(status) || count <= 0) return rollup;
  rollup.counts[status] += count;
  rollup.total += count;
  return rollup;
}

export function mergeDeploymentRollup(target: DeploymentRollup, source: DeploymentRollup) {
  for (const status of DEPLOYMENT_STATUSES) {
    target.counts[status] += source.counts[status];
  }
  target.total += source.total;
  return target;
}

export function deploymentRollupsByProject(projectIds: string[], rows: DeploymentStatusCountRow[]) {
  const rollups = new Map(projectIds.map((projectId) => [projectId, emptyDeploymentRollup()]));
  for (const row of rows) {
    const rollup = rollups.get(row.projectId);
    if (rollup) addDeploymentCount(rollup, row.deploymentStatus, row._count._all);
  }
  return rollups;
}

export async function getDeploymentRollupsByProject(db: DeploymentDb, projectIds: string[]) {
  const rollups = new Map(projectIds.map((projectId) => [projectId, emptyDeploymentRollup()]));
  if (projectIds.length === 0) return rollups;

  const [epicRows, standaloneTaskRows] = await Promise.all([
    db.epic.groupBy({
      by: ["projectId", "deploymentStatus"],
      where: { projectId: { in: projectIds }, deletedAt: null, archivedAt: null },
      _count: { _all: true },
    }),
    db.task.groupBy({
      by: ["projectId", "deploymentStatus"],
      where: {
        projectId: { in: projectIds },
        deletedAt: null,
        archivedAt: null,
        parentTaskId: null,
        epicId: null,
      },
      _count: { _all: true },
    }),
  ]);

  for (const row of [...epicRows, ...standaloneTaskRows]) {
    const rollup = rollups.get(row.projectId);
    if (rollup) addDeploymentCount(rollup, row.deploymentStatus, row._count._all);
  }

  return rollups;
}

function isKnownDeploymentStatus(value: string | null | undefined): value is DeploymentStatus {
  return typeof value === "string" && (DEPLOYMENT_STATUSES as readonly string[]).includes(value);
}
