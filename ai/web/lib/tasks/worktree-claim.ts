import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { resolveGitIdentity } from "@/lib/settings/system";
import {
  effectiveEpicBranchName,
  effectiveTaskBranchName,
} from "@/lib/work-items/branches";
import {
  reserveTaskRepositoryState,
  updateTaskRepositoryState,
} from "@/lib/tasks/repository-state";

const exec = promisify(execFile);

// Reuse the unsandboxed repository runner spool. pm.service can write here,
// while pm-epic-merge-runner runs as the repository owner and has the Git/SSH
// access needed for fetch, branch creation, and `git worktree add`.
export const REPOSITORY_JOB_DIR =
  process.env.PM_EPIC_MERGE_DIR ?? "/var/lib/pm/epic-merge";

export type WorktreeClaimJob = {
  kind: "claim";
  jobId: string;
  taskId: string;
  projectId: string;
  repositoryPath: string;
  branchName: string;
  epicBranch: string | null;
  expectedGitUserName: string | null;
  expectedGitUserEmail: string | null;
  responsePath: string;
  enqueuedAt: string;
};

export type WorktreeClaimResult =
  | {
      ok: true;
      taskId: string;
      repositoryRoot: string;
      worktreePath: string;
      branchName: string;
      headSha: string;
      mode: "existing" | "provisioned";
    }
  | {
      ok: false;
      taskId: string;
      error: string;
    };

export type TaskWorktreeResult =
  | {
      required: false;
      reason: "no_repository";
    }
  | {
      required: true;
      repositoryRoot: string;
      worktreePath: string;
      branchName: string;
      headSha: string;
      mode: "existing" | "provisioned";
    };

export class TaskWorktreeError extends Error {
  constructor(
    message: string,
    readonly taskId: string,
  ) {
    super(message);
    this.name = "TaskWorktreeError";
  }
}

function conciseError(err: unknown) {
  const value = err as { stderr?: string; stdout?: string; message?: string };
  return String(value.stderr || value.stdout || value.message || err)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 1000);
}

async function runGit(repo: string, args: string[]) {
  const safeRepo = await realpath(repo);
  const { stdout } = await exec("git", [
    "-c",
    `safe.directory=${safeRepo}`,
    "-C",
    safeRepo,
    ...args,
  ], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function resolvePrimaryRepository(repositoryPath: string) {
  const commonRaw = await runGit(repositoryPath, ["rev-parse", "--git-common-dir"]);
  const common = await realpath(path.resolve(repositoryPath, commonRaw));
  if (path.basename(common) !== ".git") {
    throw new Error(`repository common directory is not a .git directory: ${common}`);
  }
  const root = path.dirname(common);
  const codeRoot = await realpath("/srv/Code");
  if (path.dirname(root) !== codeRoot || path.basename(root).endsWith(".worktrees")) {
    throw new Error(
      `repository must resolve to an immutable primary checkout directly under ${codeRoot}; got ${root}`,
    );
  }
  return root;
}

function branchWorktreePath(repositoryRoot: string, branchName: string) {
  return `${repositoryRoot}.worktrees/${branchName.replaceAll("/", "_")}`;
}

export async function inspectRegisteredTaskWorktree(args: {
  repositoryPath: string;
  branchName: string;
}): Promise<
  | {
      ok: true;
      repositoryRoot: string;
      worktreePath: string;
    }
  | {
      ok: false;
      repositoryRoot?: string;
      worktreePath?: string;
      error: string;
    }
> {
  try {
    const repositoryRoot = await resolvePrimaryRepository(args.repositoryPath);
    const worktreePath = branchWorktreePath(repositoryRoot, args.branchName);
    const marker = await lstat(path.join(worktreePath, ".git")).catch(() => null);
    if (!marker?.isFile()) {
      return {
        ok: false,
        repositoryRoot,
        worktreePath,
        error: `${worktreePath} is not a linked Git worktree (.git file missing)`,
      };
    }

    const [actualBranch, repositoryCommon, worktreeCommon, registered] =
      await Promise.all([
        runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        realpath(path.join(repositoryRoot, ".git")),
        runGit(worktreePath, ["rev-parse", "--git-common-dir"]).then((value) =>
          realpath(path.resolve(worktreePath, value)),
        ),
        runGit(repositoryRoot, ["worktree", "list", "--porcelain"]),
      ]);
    if (actualBranch !== args.branchName) {
      return {
        ok: false,
        repositoryRoot,
        worktreePath,
        error: `${worktreePath} is on ${actualBranch}; expected ${args.branchName}`,
      };
    }
    if (repositoryCommon !== worktreeCommon) {
      return {
        ok: false,
        repositoryRoot,
        worktreePath,
        error: `${worktreePath} belongs to a different Git repository`,
      };
    }
    const registeredPaths = registered
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    if (!registeredPaths.includes(worktreePath)) {
      return {
        ok: false,
        repositoryRoot,
        worktreePath,
        error: `${worktreePath} is not registered in ${repositoryRoot}`,
      };
    }
    return { ok: true, repositoryRoot, worktreePath };
  } catch (err) {
    return { ok: false, error: conciseError(err) };
  }
}

function claimBranchExecutable() {
  const override = process.env.PM_CLAIM_BRANCH_BIN?.trim();
  if (override) return override;
  const local = path.resolve(process.cwd(), "../openclaw/bin/claim-branch");
  return existsSync(local) ? local : "/usr/local/bin/claim-branch";
}

async function configureWorktreeIdentity(
  worktreePath: string,
  name: string | null,
  email: string | null,
) {
  if (!name || !email) return;
  await runGit(worktreePath, ["config", "extensions.worktreeConfig", "true"]);
  await runGit(worktreePath, ["config", "--worktree", "user.name", name]);
  await runGit(worktreePath, ["config", "--worktree", "user.email", email]);
  const gitDirRaw = await runGit(worktreePath, ["rev-parse", "--git-dir"]);
  const gitDir = path.resolve(worktreePath, gitDirRaw);
  await writeFile(
    path.join(gitDir, "expected-identity"),
    `${JSON.stringify({ name, email })}\n`,
    { mode: 0o664 },
  );
}

// Runner-side operation. It never trusts a caller-supplied destination:
// repositoryPath is resolved through Git's common dir, and claim-branch owns
// the deterministic <primary>.worktrees/<branch> path.
export async function runWorktreeClaimJob(
  job: WorktreeClaimJob,
): Promise<WorktreeClaimResult> {
  try {
    const before = await inspectRegisteredTaskWorktree({
      repositoryPath: job.repositoryPath,
      branchName: job.branchName,
    });
    if (before.ok) {
      await configureWorktreeIdentity(
        before.worktreePath,
        job.expectedGitUserName,
        job.expectedGitUserEmail,
      );
      return {
        ok: true,
        taskId: job.taskId,
        repositoryRoot: before.repositoryRoot,
        worktreePath: before.worktreePath,
        branchName: job.branchName,
        headSha: await runGit(before.worktreePath, ["rev-parse", "HEAD"]),
        mode: "existing",
      };
    }

    const repositoryRoot = await resolvePrimaryRepository(job.repositoryPath);
    const repoName = path.basename(repositoryRoot);
    const args = [repoName, job.branchName, "--pm"];
    if (job.epicBranch && job.epicBranch !== job.branchName) {
      args.push("--epic", job.epicBranch);
    }
    await exec(claimBranchExecutable(), args, {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    const after = await inspectRegisteredTaskWorktree({
      repositoryPath: repositoryRoot,
      branchName: job.branchName,
    });
    if (!after.ok) {
      throw new Error(`claim-branch returned without a valid worktree: ${after.error}`);
    }
    await configureWorktreeIdentity(
      after.worktreePath,
      job.expectedGitUserName,
      job.expectedGitUserEmail,
    );
    return {
      ok: true,
      taskId: job.taskId,
      repositoryRoot: after.repositoryRoot,
      worktreePath: after.worktreePath,
      branchName: job.branchName,
      headSha: await runGit(after.worktreePath, ["rev-parse", "HEAD"]),
      mode: "provisioned",
    };
  } catch (err) {
    return {
      ok: false,
      taskId: job.taskId,
      error: conciseError(err) || "unknown worktree provisioning error",
    };
  }
}

export async function writeWorktreeClaimResult(
  job: WorktreeClaimJob,
  result: WorktreeClaimResult,
) {
  const spoolRoot = path.resolve(REPOSITORY_JOB_DIR);
  const responsePath = path.resolve(job.responsePath);
  if (
    path.dirname(responsePath) !== spoolRoot ||
    !path.basename(responsePath).startsWith(`claim-${job.taskId}-`) ||
    !responsePath.endsWith(".result")
  ) {
    throw new Error(`Refusing worktree claim response outside ${spoolRoot}`);
  }
  const tmp = `${responsePath}.tmp`;
  await writeFile(tmp, JSON.stringify(result, null, 2), { mode: 0o660 });
  await rename(tmp, responsePath);
}

async function waitForClaimResult(
  responsePath: string,
  timeoutMs = Number(process.env.PM_WORKTREE_CLAIM_TIMEOUT_MS ?? 30_000),
) {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
  const deadline = Date.now() + effectiveTimeout;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(
        await readFile(responsePath, "utf8"),
      ) as WorktreeClaimResult;
      await unlink(responsePath).catch(() => undefined);
      return result;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("repository runner timed out while creating the task worktree");
}

async function enqueueClaimJob(job: WorktreeClaimJob) {
  await mkdir(REPOSITORY_JOB_DIR, { recursive: true, mode: 0o770 });
  const target = path.join(REPOSITORY_JOB_DIR, `${job.jobId}.json`);
  const tmp = path.join(REPOSITORY_JOB_DIR, `.${job.jobId}.json.tmp`);
  await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o660 });
  await rename(tmp, target);
}

export async function ensureTaskCodeWorktree(
  taskId: string,
  actorUserId?: string | null,
  options: { reconcile?: boolean } = {},
): Promise<TaskWorktreeResult> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      project: {
        select: {
          id: true,
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
        },
      },
      epic: {
        select: {
          workItemKey: true,
          branchName: true,
        },
      },
    },
  });
  if (!task?.project.repositoryPath) {
    return { required: false, reason: "no_repository" };
  }
  const branchName = effectiveTaskBranchName(task);
  if (!branchName) {
    const detail = "project has a repository but the task has no effective branch";
    await db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actorUserId ?? null,
        kind: "pm.worktree.claim.fail",
        payload: JSON.stringify({ branchName: null, epicBranch: null, error: detail }),
      },
    });
    throw new TaskWorktreeError(
      "Task worktree cannot be provisioned: configure a Task branch or human work-item key before approving/starting code work.",
      task.id,
    );
  }
  const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;

  const current = await inspectRegisteredTaskWorktree({
    repositoryPath: task.project.repositoryPath,
    branchName,
  });
  if (current.ok && !options.reconcile) {
    const headSha = await runGit(current.worktreePath, ["rev-parse", "HEAD"]);
    await updateTaskRepositoryState(task.id, {
      phase: "active",
      repositoryPath: current.repositoryRoot,
      branchName,
      worktreePath: current.worktreePath,
      epicBranch,
      baseSha: headSha,
      validationOutcome: null,
      lastError: null,
    });
    return {
      required: true,
      repositoryRoot: current.repositoryRoot,
      worktreePath: current.worktreePath,
      branchName,
      headSha,
      mode: "existing",
    };
  }

  const identity = await resolveGitIdentity(task.project);
  const jobId = `claim-${task.id}-${randomUUID()}`;
  const responsePath = path.join(REPOSITORY_JOB_DIR, `${jobId}.result`);
  const job: WorktreeClaimJob = {
    kind: "claim",
    jobId,
    taskId: task.id,
    projectId: task.projectId,
    repositoryPath: task.project.repositoryPath,
    branchName,
    epicBranch,
    expectedGitUserName: identity.name,
    expectedGitUserEmail: identity.email,
    responsePath,
    enqueuedAt: new Date().toISOString(),
  };

  try {
    await updateTaskRepositoryState(task.id, {
      phase: "provisioning",
      repositoryPath: task.project.repositoryPath,
      branchName,
      epicBranch,
      validationOutcome: null,
      lastError: null,
      incrementAttempt: true,
    });
    await enqueueClaimJob(job);
    const result = await waitForClaimResult(responsePath);
    if (!result.ok) throw new Error(result.error);
    await db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actorUserId ?? null,
        kind: "pm.worktree.claim.ok",
        payload: JSON.stringify({
          branchName,
          worktreePath: result.worktreePath,
          mode: result.mode,
          epicBranch,
        }),
      },
    });
    await updateTaskRepositoryState(task.id, {
      phase: "active",
      repositoryPath: result.repositoryRoot,
      branchName,
      worktreePath: result.worktreePath,
      epicBranch,
      baseSha: result.headSha,
      validationOutcome: null,
      lastError: null,
    });
    return {
      required: true,
      repositoryRoot: result.repositoryRoot,
      worktreePath: result.worktreePath,
      branchName,
      headSha: result.headSha,
      mode: result.mode,
    };
  } catch (err) {
    const detail = conciseError(err);
    await reserveTaskRepositoryState(task.id);
    await updateTaskRepositoryState(task.id, {
      phase: "action_required",
      repositoryPath: task.project.repositoryPath,
      branchName,
      epicBranch,
      validationOutcome: "invalid",
      lastError: detail,
    });
    await db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actorUserId ?? null,
        kind: "pm.worktree.claim.fail",
        payload: JSON.stringify({ branchName, epicBranch, error: detail }),
      },
    });
    throw new TaskWorktreeError(
      `Task worktree could not be created or validated for branch ${branchName}: ${detail}`,
      task.id,
    );
  }
}
