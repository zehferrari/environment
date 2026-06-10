"use server";

// Write side of the switchable-single-site feature. Human-triggered browser
// actions write a request file into the spool dir; the privileged
// pm-switch-runner (as zeh) picks it up. The web app never builds or restarts
// anything itself.

import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { readSwitchState, SWITCH_DIR } from "@/lib/deploy/worktrees";
import {
  approveAndMergeBitbucketPullRequest,
  approveLocalChangesAndOpenDeploymentPr,
  DEPLOYMENT_LOCAL_CHANGES_PENDING,
} from "@/lib/deploy/monitor";

export async function requestWorktreeSwitch(
  target: string,
  opts: { rebuild?: boolean } = {},
): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id || session.user.kind === "agent") throw new Error("Forbidden");

  const state = await readSwitchState();
  if (!state.available) {
    throw new Error("Worktree switcher is not installed on this host.");
  }
  const wt = state.worktrees.find((w) => w.name === target || w.path === target);
  if (!wt) throw new Error(`Unknown worktree: ${target}`);
  const rebuild = Boolean(opts.rebuild && wt.served);
  if (wt.served && !rebuild) throw new Error(`${wt.name} is already live.`);
  if (!wt.ready) {
    throw new Error(`${wt.name} has no node_modules — run 'pnpm install' in its ai/web first.`);
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const body = JSON.stringify(
    { id, target: wt.name, rebuild, requestedBy: session.user.name ?? session.user.id, requestedAt: new Date().toISOString() },
    null,
    2
  );
  // Atomic publish: write to a temp file then rename into place.
  const tmp = path.join(SWITCH_DIR, `request.json.tmp-${id}`);
  await writeFile(tmp, body, { mode: 0o664 });
  await rename(tmp, path.join(SWITCH_DIR, "request.json"));
  return { id };
}

export async function requestWorktreeInstall(target: string): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id || session.user.kind === "agent") throw new Error("Forbidden");

  const state = await readSwitchState();
  if (!state.available) {
    throw new Error("Worktree switcher is not installed on this host.");
  }
  const wt = state.worktrees.find((w) => w.name === target || w.path === target);
  if (!wt) throw new Error(`Unknown worktree: ${target}`);
  if (wt.ready) throw new Error(`${wt.name} already has dependencies installed.`);

  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const body = JSON.stringify(
    {
      id,
      action: "install",
      target: wt.name,
      requestedBy: session.user.name ?? session.user.id,
      requestedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const tmp = path.join(SWITCH_DIR, `request.json.tmp-${id}`);
  await writeFile(tmp, body, { mode: 0o664 });
  await rename(tmp, path.join(SWITCH_DIR, "request.json"));
  return { id };
}

async function requireHumanActor() {
  const session = await auth();
  if (!session?.user?.id || session.user.kind === "agent") throw new Error("Forbidden");
  return { id: session.user.id };
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
