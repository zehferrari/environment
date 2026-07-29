import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import {
  inspectOriginBranch,
  mergeTaskBranchIntoEpic,
  publishEpicBranch,
  removeMergedOriginChildBranch,
} from "@/lib/deploy/epic-merge-git";

// Auto-merge a Done Epic-child task's branch into the Epic integration branch.
//
// EPICS ONLY: a standalone task (no epic parent) is never merged here — its
// branch lands on production directly and is picked up by merge-detect.
//
// Split execution model: pm.service runs inside a systemd sandbox
// (ProtectSystem=strict, no repo in ReadWritePaths) that blocks `git worktree
// add`, fetch ref-writes, and push/SSH — so the poll below only SELECTS
// candidates and ENQUEUES spool jobs. The unsandboxed pm-epic-merge-runner
// (same pattern as pm-verify-runner) picks each job up and calls
// runEpicMergeSpoolJob() via scripts/pm-epic-merge-job.ts, which does the git
// work and the DB bookkeeping (merge.ok record / Review bounce / cleanup).
//
// Idempotency + retry: a successful (or no-op) merge records a
// `pm.epic.merge.ok` activity; the poll query excludes tasks that already have
// one, and the spool uses one deterministic file per task, so each task is
// merged at most once. A merge conflict (or any git failure) bounces the task
// back to Review with a comment — once it leaves Done it drops out of the poll
// set, and re-completing it (after a local fix) retries the merge.

export const EPIC_MERGE_DIR = process.env.PM_EPIC_MERGE_DIR ?? "/var/lib/pm/epic-merge";

export type EpicMergeJob =
  | {
      kind: "merge";
      jobId: string;
      taskId: string;
      projectId: string;
      // Only Epic-Done finalization may merge a child archived by the same
      // human Done transition. The background poll never opts into this.
      includeArchived?: boolean;
      enqueuedAt: string;
    }
  | {
      kind: "cleanup";
      jobId: string;
      epicId: string;
      projectId: string;
      repositoryPath: string;
      epicBranch: string;
      branches: string[];
      enqueuedAt: string;
    };

// One deterministic spool filename per subject so a 60s poll tick can never
// stack duplicate jobs while the runner is busy. `.running`/`.failed` suffixes
// are runner claim states (see deploy/pm-epic-merge-runner).
function jobFileName(job: EpicMergeJob) {
  return job.kind === "merge" ? `merge-${job.taskId}.json` : `cleanup-${job.epicId}.json`;
}

async function enqueueEpicMergeJob(job: EpicMergeJob): Promise<string | null> {
  await mkdir(EPIC_MERGE_DIR, { recursive: true, mode: 0o770 });
  const name = jobFileName(job);
  const target = path.join(EPIC_MERGE_DIR, name);
  if (
    existsSync(target) ||
    existsSync(`${target}.running`) ||
    existsSync(`${target}.failed`)
  ) {
    return null; // already queued / in flight / awaiting operator retry
  }
  // Atomic write (write tmp + rename) so the runner never reads a partial file.
  const tmp = path.join(EPIC_MERGE_DIR, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  await rename(tmp, target);
  return target;
}

// The production branch the Epic integration branch is cut from when it does
// not exist yet: project override -> first workspace default -> "main".
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

async function monitorAgentUser(): Promise<{ id: string; username: string } | null> {
  const monitor = await db.agent.findFirst({
    where: { role: "monitor", deactivatedAt: null, user: { is: { status: "active" } } },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { id: true, username: true } } },
  });
  return monitor?.user ?? null;
}

// The agent user that authors the merge-failure comment / bounce: the Epic's
// Deploy Reviewer when it is an active agent, else the monitor agent.
async function resolveEpicMergeActor(
  deployReviewerId: string | null,
): Promise<{ id: string; username: string } | null> {
  if (deployReviewerId) {
    const reviewer = await db.user.findFirst({
      where: {
        id: deployReviewerId,
        status: "active",
        kind: "agent",
        agent: { is: { deactivatedAt: null } },
      },
      select: { id: true, username: true },
    });
    if (reviewer) return reviewer;
  }
  return monitorAgentUser();
}

type MergeCandidate = {
  id: string;
  title: string;
  projectId: string;
  workItemKey: string | null;
  branchName: string | null;
  assigneeId: string | null;
  project: {
    slug: string;
    repositoryPath: string | null;
    defaultGitUserName: string | null;
    defaultGitUserEmail: string | null;
  };
  epic: {
    id: string;
    status: string;
    workItemKey: string | null;
    branchName: string | null;
    deployReviewerId: string | null;
  } | null;
};

const MERGE_CANDIDATE_SELECT = {
  id: true,
  title: true,
  projectId: true,
  workItemKey: true,
  branchName: true,
  assigneeId: true,
  project: {
    select: {
      slug: true,
      repositoryPath: true,
      defaultGitUserName: true,
      defaultGitUserEmail: true,
    },
  },
  epic: {
    select: {
      id: true,
      status: true,
      workItemKey: true,
      branchName: true,
      deployReviewerId: true,
    },
  },
} as const;

async function recordMergeOk(task: MergeCandidate, epicBranch: string, detail: Record<string, unknown>) {
  await db.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      kind: "pm.epic.merge.ok",
      payload: JSON.stringify({ taskId: task.id, epicId: task.epic?.id, epicBranch, ...detail }),
    },
  });
  publishBoardTouch(task.projectId);
}

async function bounceTaskToReview(args: {
  task: MergeCandidate;
  epicBranch: string;
  taskBranch: string;
  reason: string;
}) {
  const { task, epicBranch, taskBranch, reason } = args;
  const actor = await resolveEpicMergeActor(task.epic?.deployReviewerId ?? null);
  const now = new Date();

  await db.$transaction(async (tx) => {
    const maxRank = await tx.task.aggregate({
      where: { status: "Review", archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    await tx.task.update({
      where: { id: task.id },
      data: {
        status: "Review",
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: now,
        archivedAt: null,
        archivedById: null,
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor?.id ?? null,
        kind: "task.move",
        payload: JSON.stringify({ from: "Done", to: "Review", via: "epic_merge_failed", epicBranch, taskBranch }),
      },
    });

    // A prematurely-Done Epic (rolled to Done by this being its last child) must
    // step back to In Progress now that a child has returned to Review.
    if (task.epic && task.epic.status === "Done") {
      await tx.epic.update({
        where: { id: task.epic.id },
        data: { status: "In Progress", statusChangedAt: now },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          userId: actor?.id ?? null,
          kind: "epic.status",
          payload: JSON.stringify({ epicId: task.epic.id, from: "Done", to: "In Progress", via: "epic_merge_failed" }),
        },
      });
    }

    if (actor) {
      const comment = await tx.comment.create({
        data: {
          taskId: task.id,
          userId: actor.id,
          body: `🔀 Auto-merge into the Epic branch \`${epicBranch}\` failed, so this task is back in Review.\n\n${reason}`,
        },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: actor.id,
          kind: "task.comment",
          payload: JSON.stringify({ commentId: comment.id, reason: "epic_merge_failed" }),
        },
      });
    }

    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor?.id ?? null,
        kind: "pm.epic.merge.fail",
        payload: JSON.stringify({ taskId: task.id, epicId: task.epic?.id, epicBranch, taskBranch, reason }),
      },
    });
  });

  if (task.assigneeId && actor) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor: { id: actor.id, username: actor.username, kind: "agent" },
      reason: "review_feedback",
      body: [
        `Your task "${task.title}" could not be auto-merged into the Epic branch \`${epicBranch}\` and is back in Review.`,
        reason,
        `Resolve it and commit your changes locally on \`${taskBranch}\` — never push Epic-child branches. When the task is moved to Done again the integration retries automatically.`,
      ].join("\n"),
    }).catch((err) => console.error("[pm] epic merge bounce notify failed:", task.id, err));
  }

  publishBoardTouch(task.projectId);
}

// Deployment-watcher poll step (runs inside pm.service): select every Done
// Epic-child task whose branch has not yet been merged into its Epic branch
// and enqueue one spool job each for the pm-epic-merge-runner. No git runs
// here — the pm.service sandbox cannot do git work (see header).
export async function pollEpicTaskMerges(): Promise<{ checked: number; enqueued: number }> {
  const tasks = (await db.task.findMany({
    where: {
      status: "Done",
      epicId: { not: null },
      parentTaskId: null,
      deletedAt: null,
      archivedAt: null,
      project: { repositoryPath: { not: null } },
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
    orderBy: { statusChangedAt: "asc" },
    take: 25,
    select: MERGE_CANDIDATE_SELECT,
  })) as MergeCandidate[];

  let checked = 0;
  let enqueued = 0;

  for (const task of tasks) {
    const repoPath = task.project.repositoryPath;
    const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
    const taskBranch = effectiveTaskBranchName({
      workItemKey: task.workItemKey,
      branchName: task.branchName,
      epic: task.epic,
    });
    if (!repoPath || !epicBranch || !taskBranch) {
      // Nothing actionable (e.g. no derivable branch) — mark done so we stop
      // re-scanning it every tick. No git involved, safe in-process.
      await recordMergeOk(task, epicBranch ?? "", { note: "no derivable branch" });
      continue;
    }

    checked++;
    try {
      const spooled = await enqueueEpicMergeJob({
        kind: "merge",
        jobId: `merge-${task.id}`,
        taskId: task.id,
        projectId: task.projectId,
        enqueuedAt: new Date().toISOString(),
      });
      if (spooled) enqueued++;
    } catch (err) {
      console.error("[pm] epic merge enqueue failed:", task.id, err);
    }
  }

  return { checked, enqueued };
}

// Epic-Done hook: queue Epic publication plus removal of merged LOCAL child
// branches/worktrees once an Epic reaches Done. Called from the auto-rollup
// (lib/tasks/review-automation.ts) and the human epic-status paths
// (lib/epics/actions.ts) AFTER their transactions commit. The runner verifies
// each branch is an ancestor of the pushed Epic branch before deleting it. A
// leaked remote child ref is deleted only after the same ancestry proof.
export async function enqueueEpicDoneCleanup(epicId: string): Promise<{ enqueued: boolean; note?: string }> {
  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      status: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      project: { select: { repositoryPath: true } },
      // Include archived children: moving an Epic to Done archives its tasks
      // in the same transaction that precedes this hook.
      tasks: {
        where: { parentTaskId: null, deletedAt: null },
        select: {
          id: true,
          status: true,
          workItemKey: true,
          branchName: true,
          activity: {
            where: { kind: "pm.epic.merge.ok" },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });
  if (!epic || epic.status !== "Done") return { enqueued: false, note: "epic not Done" };
  const repositoryPath = epic.project.repositoryPath;
  const epicBranch = effectiveEpicBranchName(epic);
  if (!repositoryPath || !epicBranch) return { enqueued: false, note: "no repository or epic branch" };

  const branches = [
    ...new Set(
      epic.tasks
        .map((task) => effectiveTaskBranchName({ ...task, epic }))
        .filter((branch): branch is string => Boolean(branch) && branch !== epicBranch),
    ),
  ];
  // A human Epic-Done transition archives its children in the transaction
  // immediately before this hook. Queue only those explicit children here;
  // the global poll remains restricted to unarchived live work and therefore
  // can never reconsider historical auto-archived Done tasks.
  for (const task of epic.tasks) {
    if (task.status !== "Done" || task.activity.length > 0) continue;
    await enqueueEpicMergeJob({
      kind: "merge",
      jobId: `merge-${task.id}`,
      taskId: task.id,
      projectId: epic.projectId,
      includeArchived: true,
      enqueuedAt: new Date().toISOString(),
    });
  }
  const spooled = await enqueueEpicMergeJob({
    kind: "cleanup",
    jobId: `cleanup-${epic.id}`,
    epicId: epic.id,
    projectId: epic.projectId,
    repositoryPath,
    epicBranch,
    branches,
    enqueuedAt: new Date().toISOString(),
  });
  return { enqueued: Boolean(spooled) };
}

// ---------------------------------------------------------------------------
// Runner-side execution (invoked by scripts/pm-epic-merge-job.ts inside the
// unsandboxed pm-epic-merge-runner service — it has DB access like
// pm-verify-branch-pushed.ts and full git/SSH capability).
// ---------------------------------------------------------------------------

const exec = promisify(execFile);

async function runGit(repo: string, args: string[], opts: { timeout?: number } = {}) {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    timeout: opts.timeout ?? 60_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function runGitOk(repo: string, args: string[], opts: { timeout?: number } = {}) {
  try {
    await runGit(repo, args, opts);
    return true;
  } catch {
    return false;
  }
}

async function executeMergeJob(job: Extract<EpicMergeJob, { kind: "merge" }>) {
  // Re-load the candidate with the poll's exact predicate: the task may have
  // moved, been merged, or been bounced between enqueue and execution.
  const task = (await db.task.findFirst({
    where: {
      id: job.taskId,
      status: "Done",
      epicId: { not: null },
      parentTaskId: null,
      deletedAt: null,
      ...(job.includeArchived ? {} : { archivedAt: null }),
      project: { repositoryPath: { not: null } },
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
    select: MERGE_CANDIDATE_SELECT,
  })) as MergeCandidate | null;
  if (!task) return { taskId: job.taskId, outcome: "skipped" as const, note: "no longer a merge candidate" };

  const repoPath = task.project.repositoryPath!;
  const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
  const taskBranch = effectiveTaskBranchName({
    workItemKey: task.workItemKey,
    branchName: task.branchName,
    epic: task.epic,
  });
  if (!epicBranch || !taskBranch) {
    await recordMergeOk(task, epicBranch ?? "", { note: "no derivable branch" });
    return { taskId: task.id, outcome: "noop" as const, note: "no derivable branch" };
  }

  const baseBranch = await productionBranchFor(task.projectId);
  const remoteTaskBranch = await inspectOriginBranch(repoPath, taskBranch);
  const remoteTaskBranchSha = remoteTaskBranch.ok ? remoteTaskBranch.sha : null;
  const result = await mergeTaskBranchIntoEpic({
    repoPath,
    epicBranch,
    taskBranch,
    baseBranch,
    gitUserName: task.project.defaultGitUserName?.trim() || "PM Monitor",
    gitUserEmail: task.project.defaultGitUserEmail?.trim() || "pm-monitor@localhost",
    message: `Merge ${task.workItemKey ?? taskBranch} into Epic branch ${epicBranch}`,
  });
  if (result.ok) {
    await recordMergeOk(task, epicBranch, {
      taskBranch,
      kind: result.kind,
      ...(result.kind === "merged" ? { sha: result.sha } : {}),
      ...(result.kind === "noop" ? { note: result.note } : {}),
      ...(remoteTaskBranchSha
        ? { unexpectedRemoteTaskBranchSha: remoteTaskBranchSha }
        : {}),
    });
    if (remoteTaskBranchSha) {
      const monitor = await monitorAgentUser();
      await db.$transaction(async (tx) => {
        if (monitor) {
          await tx.comment.create({
            data: {
              taskId: task.id,
              userId: monitor.id,
              body: [
                `⚠️ Epic-child policy breach detected: \`origin/${taskBranch}\` exists at \`${remoteTaskBranchSha.slice(0, 10)}\`.`,
                `PM preserved the work by merging it into the Epic branch \`${epicBranch}\`. The leaked remote task ref will be removed only after ancestry is verified against the pushed Epic branch during Epic-Done finalization.`,
              ].join("\n\n"),
            },
          });
        }
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: monitor?.id ?? null,
            kind: "pm.epic.remote_branch.detected",
            payload: JSON.stringify({
              taskId: task.id,
              taskBranch,
              remoteSha: remoteTaskBranchSha,
              epicBranch,
            }),
          },
        });
      });
    }
    return { taskId: task.id, outcome: result.kind, epicBranch, taskBranch };
  }
  await bounceTaskToReview({ task, epicBranch, taskBranch, reason: result.reason });
  return { taskId: task.id, outcome: "bounced" as const, epicBranch, taskBranch, reason: result.reason };
}

type LocalCleanupItem = {
  branch: string;
  outcome: "removed" | "absent" | "failed" | "needs-root";
  detail: string | null;
};

type CleanupItem = LocalCleanupItem & {
  remoteOutcome: "removed" | "absent" | "failed";
  remoteDetail: string | null;
};

function isPermissionError(detail: string) {
  return /permission denied|operation not permitted|read-only file system/i.test(detail);
}

// Locate the repo-relative worktree-remove helper first (versioned with this
// worktree), falling back to the host-installed copy.
function worktreeRemoveScript() {
  const override = process.env.PM_WORKTREE_REMOVE_SCRIPT;
  if (override) return override;
  const local = path.join(process.cwd(), "deploy", "worktree-remove");
  return existsSync(local) ? local : "/usr/local/sbin/worktree-remove";
}

async function removeLocalBranch(job: Extract<EpicMergeJob, { kind: "cleanup" }>, branch: string): Promise<LocalCleanupItem> {
  const repo = job.repositoryPath;
  const hasLocal = await runGitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!hasLocal) return { branch, outcome: "absent", detail: null };

  const merged = await runGitOk(repo, [
    "merge-base",
    "--is-ancestor",
    `refs/heads/${branch}`,
    `refs/remotes/origin/${job.epicBranch}`,
  ]);
  if (!merged) {
    return {
      branch,
      outcome: "failed",
      detail: `not an ancestor of the pushed Epic branch \`${job.epicBranch}\` — left in place`,
    };
  }

  try {
    // Branch-only mode of the shared cleanup helper: removes the branch's
    // clean worktree (when one exists under <repo>.worktrees) then deletes
    // the local ref. Never contacts origin.
    await exec(
      "python3",
      [
        worktreeRemoveScript(),
        "--branch",
        repo,
        `${repo}.worktrees`,
        branch,
        JSON.stringify([job.epicBranch]),
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    return { branch, outcome: "removed", detail: null };
  } catch (err) {
    const anyErr = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (anyErr.stderr || anyErr.stdout || anyErr.message || String(err)).trim().slice(0, 400);
    return { branch, outcome: isPermissionError(detail) ? "needs-root" : "failed", detail };
  }
}

function renderCleanupBody(job: Extract<EpicMergeJob, { kind: "cleanup" }>, items: CleanupItem[]) {
  const removed = items.filter((item) => item.outcome === "removed");
  const absent = items.filter((item) => item.outcome === "absent");
  const failed = items.filter((item) => item.outcome === "failed");
  const needsRoot = items.filter((item) => item.outcome === "needs-root");
  const remoteRemoved = items.filter((item) => item.remoteOutcome === "removed");
  const remoteFailed = items.filter((item) => item.remoteOutcome === "failed");
  const lines = [
    `🧹 Epic is Done — Epic branch \`${job.epicBranch}\` is published and child-branch cleanup is complete.`,
    "",
  ];
  if (removed.length > 0) {
    lines.push(`- Removed (worktree + local branch): ${removed.map((item) => `\`${item.branch}\``).join(", ")}`);
  }
  if (absent.length > 0) {
    lines.push(`- Already absent locally: ${absent.map((item) => `\`${item.branch}\``).join(", ")}`);
  }
  for (const item of failed) {
    lines.push(`- Failed: \`${item.branch}\` — ${item.detail}`);
  }
  for (const item of needsRoot) {
    lines.push(`- Needs root (likely ACL/permission breakage): \`${item.branch}\` — ${item.detail}`);
  }
  if (remoteRemoved.length > 0) {
    lines.push(
      `- Removed leaked remote task refs after ancestry verification: ${remoteRemoved.map((item) => `\`origin/${item.branch}\``).join(", ")}`,
    );
  }
  for (const item of remoteFailed) {
    lines.push(`- Remote ref preserved: \`origin/${item.branch}\` — ${item.remoteDetail}`);
  }
  lines.push("", `The Epic integration branch \`${job.epicBranch}\` is the published origin record.`);
  return lines.join("\n");
}

async function executeCleanupJob(job: Extract<EpicMergeJob, { kind: "cleanup" }>) {
  const epic = await db.epic.findUnique({
    where: { id: job.epicId },
    select: { id: true, status: true, projectId: true },
  });
  if (!epic || epic.status !== "Done") {
    return { epicId: job.epicId, outcome: "skipped" as const, note: "epic no longer Done" };
  }

  // The Epic can roll to Done before its last child's merge job has run
  // (rollup fires on review_done; the merge poll runs on its own tick). Defer
  // cleanup while any unarchived Done child still lacks a merge record — the
  // job script re-queues the spool file so this retries after the merges land
  // (or drops out via the epic-not-Done skip when a merge bounces).
  const pendingMerges = await db.task.count({
    where: {
      epicId: job.epicId,
      parentTaskId: null,
      deletedAt: null,
      status: "Done",
      activity: { none: { kind: "pm.epic.merge.ok" } },
    },
  });
  if (pendingMerges > 0) {
    return { epicId: job.epicId, outcome: "deferred" as const, note: `${pendingMerges} child merge(s) still pending` };
  }

  // Finalization invariant: an Epic cannot remain Done unless its integration
  // branch is published. This covers manual Epic-Done transitions and legacy
  // local-only integrations in addition to the normal per-child eager pushes.
  const publish = await publishEpicBranch({
    repoPath: job.repositoryPath,
    epicBranch: job.epicBranch,
  });
  if (!publish.ok) {
    const monitor = await monitorAgentUser();
    const now = new Date();
    const body = [
      `🚫 Epic branch \`${job.epicBranch}\` could not be published, so the Epic is back in Review.`,
      "",
      publish.reason,
      "",
      "Resolve the Git/ref problem, then move the Epic to Done again. PM will retry publication before cleaning any child branches.",
    ].join("\n");
    await db.$transaction(async (tx) => {
      await tx.epic.update({
        where: { id: job.epicId },
        data: { status: "Review", statusChangedAt: now },
      });
      if (monitor) {
        await tx.comment.create({ data: { epicId: job.epicId, userId: monitor.id, body } });
      }
      await tx.activityLog.create({
        data: {
          projectId: job.projectId,
          userId: monitor?.id ?? null,
          kind: "epic.status",
          payload: JSON.stringify({
            epicId: job.epicId,
            from: "Done",
            to: "Review",
            via: "epic_publish_failed",
          }),
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: job.projectId,
          userId: monitor?.id ?? null,
          kind: "pm.epic.publish.fail",
          payload: JSON.stringify({
            epicId: job.epicId,
            epicBranch: job.epicBranch,
            reason: publish.reason,
          }),
        },
      });
    });
    publishBoardTouch(job.projectId);
    return {
      epicId: job.epicId,
      outcome: "publish-failed" as const,
      reason: publish.reason,
    };
  }

  // Refresh the pushed Epic ref: it is the merge record every local or leaked
  // remote child deletion is verified against.
  await runGitOk(job.repositoryPath, [
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${job.epicBranch}:refs/remotes/origin/${job.epicBranch}`,
  ], { timeout: 60_000 });

  const items: CleanupItem[] = [];
  for (const branch of job.branches) {
    const remote = await removeMergedOriginChildBranch({
      repoPath: job.repositoryPath,
      epicBranch: job.epicBranch,
      taskBranch: branch,
    });
    const local = await removeLocalBranch(job, branch);
    items.push({
      ...local,
      remoteOutcome: remote.outcome,
      remoteDetail: remote.detail,
    });
  }

  const monitor = await monitorAgentUser();
  const body = renderCleanupBody(job, items);
  await db.$transaction(async (tx) => {
    if (monitor) {
      await tx.comment.create({ data: { epicId: job.epicId, userId: monitor.id, body } });
    }
    await tx.activityLog.create({
      data: {
        projectId: job.projectId,
        userId: monitor?.id ?? null,
        kind: "pm.epic.cleanup",
        payload: JSON.stringify({
          epicId: job.epicId,
          epicBranch: job.epicBranch,
          publish,
          items,
        }),
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: job.projectId,
        userId: monitor?.id ?? null,
        kind: "pm.epic.publish.ok",
        payload: JSON.stringify({
          epicId: job.epicId,
          epicBranch: job.epicBranch,
          kind: publish.kind,
          sha: publish.sha,
        }),
      },
    });
  });
  publishBoardTouch(job.projectId);

  return { epicId: job.epicId, outcome: "done" as const, items };
}

export async function runEpicMergeSpoolJob(job: EpicMergeJob) {
  if (job.kind === "merge") return executeMergeJob(job);
  return executeCleanupJob(job);
}
