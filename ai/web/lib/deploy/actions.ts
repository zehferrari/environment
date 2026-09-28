"use server";

// Write side of the switchable-single-site feature. Human-triggered browser
// actions write a request file into the spool dir; the privileged
// pm-switch-runner (as the configured service account) picks it up. The web app never builds or restarts
// anything itself.

import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { requireOwner, requireProjectAccess, requireViewer } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { readSwitchState } from "@/lib/deploy/worktrees";
import { getSwitchProject } from "@/lib/deploy/switch-registry";
import { displayWorktreesForRepo, isLinkedWorktreePath, worktreeRepoKey } from "@/lib/deploy/repo-key";
import { isLocalWorktreeProtected, localWorktreeProtectedBranches } from "@/lib/deploy/local-worktree";
import {
  approveAndMergeBitbucketPullRequest,
  approveLocalChangesAndOpenDeploymentPr,
  DEPLOYMENT_LOCAL_CHANGES_PENDING,
} from "@/lib/deploy/monitor";

// Atomic publish of a request into a project's spool: write a temp file then
// rename it into place so the runner never reads a half-written request. The
// small lock also prevents two browser actions from both claiming to queue an
// operation while one request.json would overwrite the other.
const REQUEST_LOCK_STALE_MS = 60_000;

async function acquireRequestLock(lockPath: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await open(lockPath, "wx", 0o664);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (!lockStat) continue;
      const age = Date.now() - lockStat.mtimeMs;
      if (age <= REQUEST_LOCK_STALE_MS || attempt === 1) {
        throw new Error("Another worktree operation is being queued. Try again shortly.");
      }
      const currentLock = await stat(lockPath).catch(() => null);
      if (!currentLock || currentLock.ino !== lockStat.ino || currentLock.mtimeMs !== lockStat.mtimeMs) continue;
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error("Another worktree operation is being queued. Try again shortly.");
}

async function publishRequest(spoolDir: string, payload: Record<string, unknown>): Promise<void> {
  const lockPath = path.join(spoolDir, "request.lock");
  const lock = await acquireRequestLock(lockPath);

  try {
    const state = await readSwitchState(spoolDir);
    if (isSwitchJobInProgress(state)) throw new Error("Wait for the current worktree operation to finish.");
    const existing = await readFile(path.join(spoolDir, "request.json"), "utf8").catch(() => "");
    if (existing) {
      try {
        const request = JSON.parse(existing) as { id?: unknown };
        if (typeof request.id === "string" && request.id !== state.job.id) {
          throw new Error("Another worktree operation is already queued.");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Another worktree operation is already queued.") throw error;
        throw new Error("The pending worktree request could not be verified.");
      }
    }
    const body = JSON.stringify(payload, null, 2);
    const tmp = path.join(spoolDir, `request.json.tmp-${payload.id}`);
    await writeFile(tmp, body, { mode: 0o664 });
    await rename(tmp, path.join(spoolDir, "request.json"));
  } finally {
    await lock?.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function requestWorktreeSwitch(
  repoKey: string,
  target: string,
  opts: { rebuild?: boolean } = {},
): Promise<{ id: string }> {
  const owner = await requireOwner();

  const project = getSwitchProject(repoKey);
  if (!project) throw new Error(`No worktree switcher configured for ${repoKey}.`);

  const state = await readSwitchState(project.spoolDir);
  if (!state.available) {
    throw new Error("Worktree switcher is not installed on this host.");
  }
  const wt = state.worktrees.find((w) => w.name === target || w.path === target);
  if (!wt) throw new Error(`Unknown worktree: ${target}`);
  const rebuild = Boolean(opts.rebuild && wt.served && state.siteActive);
  if (wt.served && state.siteActive && !rebuild) throw new Error(`${wt.name} is already live.`);
  if (!wt.ready && !wt.canPrepare) {
    throw new Error(`${wt.name} has no node_modules — run 'pnpm install' in its app dir first.`);
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  await publishRequest(project.spoolDir, {
    id,
    action: "serve",
    target: wt.name,
    // The UI's branch-database model means the stable worktree database.
    // Make that intent explicit so a temporary branch/worktree name mismatch
    // can never make the host switcher guess which production state to serve.
    ...(project.branchDatabases ? { databaseSelection: "worktree" } : {}),
    rebuild,
    requestedBy: owner.username,
    requestedAt: new Date().toISOString(),
  });
  return { id };
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSwitchJobInProgress(state: Awaited<ReturnType<typeof readSwitchState>>): boolean {
  return state.job.state === "queued" || state.job.state === "building" || state.job.state === "working";
}

// Queue local cleanup through the monitor-owned runner. pm.service is sandboxed
// from the shared worktree directories, so the web process must never mutate
// them directly.
export async function requestLocalWorktreeRemoval(
  projectSlug: string,
  target: string,
  options: { discardChanges?: boolean; failedJobId?: string } = {},
): Promise<{ id: string }> {
  const owner = await requireOwner();

  const projectRecord = await db.project.findUnique({
    where: { slug: projectSlug },
    select: {
      id: true,
      deletedAt: true,
      repositoryPath: true,
      deploymentProductionBranch: true,
      deploymentPrTargetBranch: true,
      agentChangeBlockedBranches: true,
    },
  });
  if (!projectRecord || projectRecord.deletedAt) throw new Error("Project not found.");
  const repoKey = worktreeRepoKey(projectRecord.repositoryPath);
  const project = getSwitchProject(repoKey);
  if (!project || !repoKey) throw new Error("This project has no managed local worktrees.");

  const state = await readSwitchState(project.spoolDir);
  if (!state.available) throw new Error("Worktree switcher is not installed on this host.");
  if (isSwitchJobInProgress(state)) throw new Error("Wait for the current worktree operation to finish.");

  const normalizedTarget = target.trim();
  const worktree = displayWorktreesForRepo(state.worktrees, repoKey).find((item) => item.name === normalizedTarget);
  if (!worktree || worktree.needsWorktree || !isLinkedWorktreePath(worktree.path) || !pathIsInside(project.worktreesRoot, worktree.path)) {
    throw new Error("Unknown managed local worktree.");
  }
  if (worktree.served || (state.served && path.resolve(worktree.path) === path.resolve(state.served))) {
    throw new Error("The currently served worktree cannot be removed.");
  }
  const protectedBranches = localWorktreeProtectedBranches(projectRecord);
  if (isLocalWorktreeProtected(worktree.branch, protectedBranches)) {
    throw new Error("This local branch is protected and cannot be removed.");
  }
  if (options.discardChanges === true && (
    !options.failedJobId
    || state.job.id !== options.failedJobId
    || state.job.state !== "error"
    || state.job.action !== "remove"
    || state.job.target !== worktree.name
    || !/worktree has local changes/i.test(state.job.log)
  )) {
    throw new Error("Discarding local changes requires a matching failed safe-removal attempt.");
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  await publishRequest(project.spoolDir, {
    id,
    action: "remove",
    target: worktree.name,
    discardChanges: options.discardChanges === true,
    protectedBranches,
    requestedBy: owner.username,
    requestedAt: new Date().toISOString(),
  });
  await db.activityLog.create({
    data: {
      projectId: projectRecord.id,
      userId: owner.id,
      kind: "project.worktree_remove_requested",
      payload: JSON.stringify({
        worktree: worktree.name,
        branch: worktree.branch,
        discardChanges: options.discardChanges === true,
        remote: false,
      }),
    },
  }).catch(() => null);
  revalidatePath(`/projects/${projectSlug}/settings`);
  return { id };
}

// On/off lifecycle: take the project's site offline (free resources for a
// node-service; engage the maintenance/deny gate for an nginx-docroot) or bring
// it back online on whatever worktree was last served. Human-only, like serve.
export async function setSiteActive(
  repoKey: string,
  active: boolean,
): Promise<{ id: string }> {
  const owner = await requireOwner();

  const project = getSwitchProject(repoKey);
  if (!project) throw new Error(`No worktree switcher configured for ${repoKey}.`);

  const state = await readSwitchState(project.spoolDir);
  if (!state.available) {
    throw new Error("Worktree switcher is not installed on this host.");
  }
  if (active && state.siteActive) throw new Error("Site is already on.");
  if (!active && !state.siteActive) throw new Error("Site is already off.");

  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  await publishRequest(project.spoolDir, {
    id,
    action: active ? "on" : "off",
    target: state.served ?? null,
    requestedBy: owner.username,
    requestedAt: new Date().toISOString(),
  });
  return { id };
}

async function requireHumanActor() {
  const viewer = await requireViewer();
  if (viewer.kind === "agent") throw new Error("Forbidden");
  return viewer;
}

async function loadDeploymentActionRow(rowId: string) {
  return db.deploymentPullRequest.findUnique({
    where: { id: rowId },
    include: {
      project: true,
      task: { select: { id: true, reporterId: true, actingManagerId: true } },
      epic: { select: { id: true, reporterId: true, actingManagerId: true } },
    },
  });
}

function canActOnDeploymentRow(row: Awaited<ReturnType<typeof loadDeploymentActionRow>>, actorId: string) {
  if (!row || row.provider.toLowerCase() !== "bitbucket") return false;
  const reporterId = row.reporterUserId || row.epic?.reporterId || row.task?.reporterId || null;
  const reviewerId = row.epic?.actingManagerId ?? row.task?.actingManagerId ?? null;
  const isReporter = reporterId === actorId;
  const isReviewer = reviewerId === actorId;
  return row.project.onlyReportersCanApprovePullRequests ? isReporter : isReporter || isReviewer;
}

function revalidateDeploymentPaths(row: NonNullable<Awaited<ReturnType<typeof loadDeploymentActionRow>>>) {
  revalidatePath(`/projects/${row.project.slug}`);
  if (row.epicId) revalidatePath(`/projects/${row.project.slug}/epics/${row.epicId}`);
  if (row.taskId) revalidatePath(`/projects/${row.project.slug}/tasks/${row.taskId}`);
}

export async function approveDeploymentLocalChanges(formData: FormData) {
  const actor = await requireHumanActor();
  const rowId = String(formData.get("deploymentPrId") ?? "");
  if (!rowId) return;
  const row = await loadDeploymentActionRow(rowId);
  if (!row || row.status !== DEPLOYMENT_LOCAL_CHANGES_PENDING) return;
  await requireProjectAccess(actor, { id: row.projectId });
  if (!canActOnDeploymentRow(row, actor.id)) throw new Error("Only the reporter or reviewer can approve deployment local changes.");

  await approveLocalChangesAndOpenDeploymentPr({
    rowId: row.id,
    actorUserId: actor.id,
  });
  revalidateDeploymentPaths(row);
}

export async function approveAndMergeDeploymentPullRequest(formData: FormData) {
  const actor = await requireHumanActor();
  const rowId = String(formData.get("deploymentPrId") ?? "");
  if (!rowId) return;
  const row = await loadDeploymentActionRow(rowId);
  if (!row || row.status !== "open") return;
  await requireProjectAccess(actor, { id: row.projectId });
  if (!canActOnDeploymentRow(row, actor.id)) throw new Error("Only the reporter or reviewer can approve and merge deployment pull requests.");

  const result = await approveAndMergeBitbucketPullRequest(row);
  await db.activityLog.create({
    data: {
      projectId: row.projectId,
      taskId: row.taskId,
      userId: actor.id,
      kind: "deployment.pr_approve_merge",
      payload: JSON.stringify({
        prId: row.id,
        providerPrId: row.providerPrId,
        providerState: result.state,
        mergeSha: result.mergeSha,
      }),
    },
  }).catch(() => null);
  revalidateDeploymentPaths(row);
}
