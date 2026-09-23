// pm-verify-branch-pushed — monitor-side branch verifier.
//
// Consumes ONE spool job dropped when an assignee moves a code-touching task to
// Review. The monitor verifies the task branch before any reviewer is woken.
//
// Standalone tasks (no epic — the branch goes to origin and PRs against the
// deployment target):
//   1. resolve the branch's local worktree when available;
//   2. fail if that worktree still has uncommitted changes;
//   3. push clean local branch commits that have not reached origin yet;
//   4. verify the project's effective PR target is an ancestor of origin/<branch>;
//   5. verify origin/<branch> contains the task prefix with the right identity;
//   6. if this branch is the currently served PM worktree, rebuild/restart it;
//   7. wake the reviewer only after the gate passes, otherwise wake the assignee.
//
// Epic children (job.epicChild — P6 local-only branches, NEVER pushed):
//   the verified ref is LOCAL refs/heads/<branch>; the base gate runs against
//   origin's current Epic integration branch (with the local ref only as a
//   missing-origin fallback) instead of the deployment target; there is no
//   auto-push and no local-vs-origin sync check. Commit-prefix, identity,
//   dirty-worktree, live-rebuild, and wake gating are unchanged.
//
// Invoked as: pnpm exec tsx scripts/pm-verify-branch-pushed.ts <job-file>

import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import {
  BRANCH_VERIFY_DIR,
  enqueueBranchVerifyJob,
  type BranchVerifyJob,
} from "@/lib/deploy/branch-verify";
import { isProtectedBranch, parseProtectedBranches } from "@/lib/projects/protected-branches";
import {
  fetchVerificationBase,
  fetchVerificationBranch,
  resolveEpicVerificationBase,
  validateEpicBase,
  validateLocalBranchBase,
  validateOriginBase,
  type BranchBaseValidation,
} from "@/lib/deploy/branch-base";
import { subjectHasCommitPrefix } from "@/lib/work-items/commit-prefix";
import { inspectOriginBranch } from "@/lib/deploy/epic-merge-git";
import {
  reconcileStandaloneBranch,
  type StandaloneBranchRecoveryResult,
} from "@/lib/deploy/standalone-branch-recovery";
import {
  completeTaskReviewHandoffAfterValidation,
  failTaskReviewValidation,
  recordTaskReviewOperationalError,
  type RepositoryProcedureCallback,
} from "@/lib/tasks/review-handoff";
import { resolveActiveMonitorAgent, updateTaskRepositoryState } from "@/lib/tasks/repository-state";
import {
  isOperationalRepositoryFailure,
  semanticCommitDescriptionWarning,
} from "@/lib/tasks/repository-validation";
import { synchronizeEpicChild, renderEpicSyncHandoff } from "@/lib/deploy/epic-child-sync";
import { withDevPublication, assertDevPublicationCandidate, DevPublicationError } from "@/lib/deploy/dev-publication";

const exec = promisify(execFile);
const SWITCH_SCRIPT = process.env.PM_SWITCH_SCRIPT ?? "/usr/local/sbin/pm-switch";

type GitCommit = {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  date: string;
  subject: string;
};
type ExpectedIdentity = { name: string; email: string };
type IdentityMismatch = {
  expected: ExpectedIdentity;
  author: string;
  committer: string;
};
type WorktreeRecord = {
  path: string;
  branch: string | null;
  head: string | null;
};
type LocalState = {
  checkPath: string | null;
  branchWorktreePath: string | null;
  dirtyStatus: string | null;
  dirtyError: string | null;
  localSha: string | null;
  remoteSha: string | null;
  pushed: boolean;
  pushError: string | null;
  pushDeferred?: boolean;
};
type RebuildResult =
  | { attempted: false; reason: string }
  | { attempted: true; ok: true; target: string; log: string }
  | { attempted: true; ok: false; target: string; error: string; log: string };

function procedureCallbackForJob(job: BranchVerifyJob): RepositoryProcedureCallback {
  if (
    job.schemaVersion !== 2 ||
    !job.procedureRunId ||
    !job.procedureStepId ||
    job.workflowCycleId === undefined ||
    !job.repositoryRunId ||
    typeof job.repositoryRunVersion !== "number"
  ) {
    throw new Error("Exact schema-v2 validation job identity is required.");
  }
  return {
    procedureRunId: job.procedureRunId,
    procedureStepId: job.procedureStepId,
    workflowCycleId: job.workflowCycleId,
    jobId: job.jobId,
    baseSha: job.baseSha ?? null,
    // PHASEE-07: round-trip V2 identity fields from the spooled job so the
    // callback carries the full V2RepositoryJobIdentity for exact correlation.
    schemaVersion: job.schemaVersion,
    commandReceiptId: job.commandReceiptId ?? null,
    repositoryRunId: job.repositoryRunId ?? null,
    repositoryRunVersion: job.repositoryRunVersion ?? null,
    candidateSha: job.previousCandidateSha ?? null,
  };
}

type CommitResult =
  | { ok: true; created: false; sha: null }
  | { ok: true; created: true; sha: string; subject: string }
  | { ok: false; error: string };

function parseLog(out: string): GitCommit[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, date, ...rest] = line.split("|");
      return {
        sha: sha ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        committerName: committerName ?? "",
        committerEmail: committerEmail ?? "",
        date: date ?? "",
        subject: rest.join("|"),
      };
    });
}

function trimError(err: unknown, max = 800) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim().slice(0, max);
}

async function run(
  command: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number; cwd?: string } = {},
) {
  const { stdout } = await exec(command, args, {
    timeout: opts.timeout ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    cwd: opts.cwd,
  });
  return stdout.trim();
}

async function git(repo: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) {
  return run("git", ["-C", repo, ...args], opts);
}

async function gitOrNull(repo: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}) {
  try {
    return await git(repo, args, opts);
  } catch {
    return null;
  }
}

function real(p: string | null | undefined) {
  if (!p) return null;
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

type ValidationExecutionResult = {
  ok: boolean;
  summary: string | null;
  checks: Array<{ name: string; status: "passed" | "failed"; required: boolean; exitCode: number | null }>;
};

async function runCandidateValidationChecks(args: {
  job: BranchVerifyJob;
  reviewRunId: string;
  candidateSha: string;
  worktreePath: string;
}): Promise<ValidationExecutionResult> {
  const profile = args.job.validationProfile ?? { id: null, version: 0, commands: [] };
  if (profile.commands.length === 0) return { ok: true, summary: null, checks: [] };
  const checks: ValidationExecutionResult["checks"] = [];
  for (const command of profile.commands) {
    const startedAt = new Date();
    const row = await db.validationCheckRun.upsert({
      where: { jobId_checkName: { jobId: args.job.jobId, checkName: command.name } },
      create: {
        projectId: args.job.projectId,
        taskId: args.job.taskId,
        reviewRunId: args.reviewRunId,
        candidateSha: args.candidateSha,
        jobId: args.job.jobId,
        profileId: profile.id,
        profileVersion: profile.version,
        checkName: command.name,
        executable: command.executable,
        arguments: JSON.stringify(command.args),
        required: command.required,
        status: "running",
        startedAt,
      },
      update: {
        reviewRunId: args.reviewRunId,
        candidateSha: args.candidateSha,
        profileId: profile.id,
        profileVersion: profile.version,
        executable: command.executable,
        arguments: JSON.stringify(command.args),
        required: command.required,
        status: "running",
        exitCode: null,
        output: null,
        startedAt,
        finishedAt: null,
      },
      select: { id: true },
    });
    try {
      const result = await exec(command.executable, command.args, {
        cwd: args.worktreePath,
        timeout: command.timeoutSeconds * 1000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const output = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim().slice(-16_000);
      await db.validationCheckRun.update({
        where: { id: row.id },
        data: { status: "passed", exitCode: 0, output: output || null, finishedAt: new Date() },
      });
      checks.push({ name: command.name, status: "passed", required: command.required, exitCode: 0 });
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
      const exitCode = typeof failed.code === "number" ? failed.code : null;
      const output = [failed.stdout, failed.stderr, failed.message]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n")
        .trim()
        .slice(-16_000);
      await db.validationCheckRun.update({
        where: { id: row.id },
        data: { status: "failed", exitCode, output: output || null, finishedAt: new Date() },
      });
      checks.push({ name: command.name, status: "failed", required: command.required, exitCode });
    }
  }
  const requiredFailures = checks.filter((check) => check.required && check.status === "failed");
  return {
    ok: requiredFailures.length === 0,
    summary: [
      `Validation profile v${profile.version}: ${checks.filter((check) => check.status === "passed").length}/${checks.length} checks passed.`,
      requiredFailures.length > 0
        ? `Required failures: ${requiredFailures.map((check) => check.name).join(", ")}.`
        : null,
    ].filter(Boolean).join(" "),
    checks,
  };
}

function parseWorktrees(out: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: Partial<WorktreeRecord> = {};
  const flush = () => {
    if (current.path) {
      records.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? null,
      });
    }
    current = {};
  };

  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return records;
}

async function branchWorktree(repo: string, branchName: string) {
  const out = await gitOrNull(repo, ["worktree", "list", "--porcelain"], { timeout: 30_000 });
  if (!out) return null;
  return parseWorktrees(out).find((record) => record.branch === branchName)?.path ?? null;
}

async function currentBranch(repo: string) {
  return gitOrNull(repo, ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 10_000 });
}

async function readLog(repo: string, baseRef: string, branchRef: string): Promise<{ commits: GitCommit[]; error: string | null }> {
  try {
    const stdout = await git(
      repo,
      ["log", `${baseRef}..${branchRef}`, "--format=%H|%an|%ae|%cn|%ce|%aI|%s"],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return { commits: parseLog(stdout), error: null };
  } catch (err) {
    return { commits: [], error: trimError(err, 400) };
  }
}

type CheckpointReviewBaseline = {
  candidateSha: string;
  checkpoint: GitCommit;
};

async function recordedCheckpointReviewBaseline(args: {
  job: BranchVerifyJob;
  state: LocalState;
  baseValidation: BranchBaseValidation;
}): Promise<CheckpointReviewBaseline | null> {
  const { job, state, baseValidation } = args;
  const baseSha = job.baseSha?.trim() || null;
  if (
    !job.epicChild ||
    !baseSha ||
    state.localSha !== baseSha ||
    baseValidation.originBaseSha !== baseSha ||
    baseValidation.branchSha !== baseSha
  ) {
    return null;
  }

  const activities = await db.activityLog.findMany({
    where: { taskId: job.taskId, kind: "pm.repo.checkpoint.ok" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  for (const activity of activities) {
    try {
      const payload = JSON.parse(activity.payload ?? "{}") as {
        taskBranch?: unknown;
        epicBranch?: unknown;
        checkpointSha?: unknown;
        epicSha?: unknown;
      };
      if (
        payload.taskBranch !== job.branchName ||
        payload.epicBranch !== job.epicBranch ||
        payload.epicSha !== baseSha ||
        typeof payload.checkpointSha !== "string"
      ) {
        continue;
      }
      try {
        await git(job.repositoryPath, ["merge-base", "--is-ancestor", payload.checkpointSha, baseSha], { timeout: 10_000 });
      } catch {
        continue;
      }
      const raw = await gitOrNull(
        job.repositoryPath,
        ["show", "-s", "--format=%H|%an|%ae|%cn|%ce|%aI|%s", payload.checkpointSha],
        { timeout: 10_000 },
      );
      const checkpoint = raw ? parseLog(raw)[0] ?? null : null;
      if (!checkpoint) continue;
      return { candidateSha: baseSha, checkpoint };
    } catch {
      // Ignore malformed historical activity and continue searching.
    }
  }
  return null;
}

function authorLabel(commit: GitCommit) {
  return `${commit.authorName} <${commit.authorEmail}>`;
}

function committerLabel(commit: GitCommit) {
  return `${commit.committerName} <${commit.committerEmail}>`;
}

function expectedIdentity(job: BranchVerifyJob): ExpectedIdentity | null {
  if (!job.expectedGitUserName || !job.expectedGitUserEmail) return null;
  return { name: job.expectedGitUserName, email: job.expectedGitUserEmail };
}

function identityMismatch(commit: GitCommit | null, expected: ExpectedIdentity | null): IdentityMismatch | null {
  if (!commit || !expected) return null;
  const authorOk = commit.authorName === expected.name && commit.authorEmail === expected.email;
  const committerOk = commit.committerName === expected.name && commit.committerEmail === expected.email;
  if (authorOk && committerOk) return null;
  return {
    expected,
    author: authorLabel(commit),
    committer: committerLabel(commit),
  };
}

async function inspectLocalState(job: BranchVerifyJob, epicMode: boolean): Promise<LocalState> {
  const worktreePath = await branchWorktree(job.repositoryPath, job.branchName);
  const repoBranch = await currentBranch(job.repositoryPath);
  const checkPath = worktreePath ?? (repoBranch === job.branchName ? job.repositoryPath : null);
  const commandPath = worktreePath ?? job.repositoryPath;

  let dirtyStatus: string | null = null;
  let dirtyError: string | null = null;
  if (checkPath) {
    try {
      dirtyStatus = await git(checkPath, ["status", "--porcelain"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    } catch (err) {
      dirtyError = trimError(err, 400);
    }
  }

  const localSha = await gitOrNull(commandPath, ["rev-parse", "--verify", `refs/heads/${job.branchName}`], { timeout: 10_000 });
  const remoteSha = epicMode
    ? null
    : await gitOrNull(commandPath, ["rev-parse", "--verify", `refs/remotes/origin/${job.branchName}`], { timeout: 10_000 });

  return {
    checkPath: checkPath ? real(checkPath) ?? checkPath : null,
    branchWorktreePath: worktreePath ? real(worktreePath) ?? worktreePath : null,
    dirtyStatus: dirtyStatus || null,
    dirtyError,
    localSha,
    remoteSha,
    pushed: false,
    pushError: null,
  };
}

async function publishLocalState(job: BranchVerifyJob, inspected: LocalState): Promise<LocalState> {
  const state = { ...inspected };
  const commandPath = state.branchWorktreePath ?? job.repositoryPath;

  // Standalone recovery push only. A missing remote feature branch makes the
  // initial fetch fail, but a clean local branch is precisely what the monitor
  // is expected to publish. Git still rejects non-fast-forward pushes, so
  // attempting this is fail-safe. Epic children never call this function.
  if (
    !state.dirtyStatus &&
    !state.dirtyError &&
    state.localSha
  ) {
    try {
      // The host pre-push hook blocks PM-managed task refs for interactive
      // agents. This runner is the trusted publication boundary after PM has
      // created and validated the submission commit.
      await withDevPublication({
        projectId: job.projectId, taskId: job.taskId, branch: job.branchName, attemptId: `review:${job.jobId}`,
        publish: async () => {
          await assertDevPublicationCandidate({ projectId: job.projectId, repositoryPath: commandPath, branch: job.branchName, sha: state.localSha! });
          if (state.localSha !== state.remoteSha) await git(commandPath, ["push", "--no-verify", "origin", `${job.branchName}:${job.branchName}`], { timeout: 90_000, maxBuffer: 1024 * 1024 });
          const remote = await inspectOriginBranch(commandPath, job.branchName);
          if (!remote.ok || remote.sha !== state.localSha) throw new Error("Origin did not confirm the exact review submission SHA.");
          return { sha: state.localSha };
        }, publishedSha: result => result.sha,
      });
      state.pushed = state.localSha !== state.remoteSha;
      await fetchVerificationBranch(commandPath, job.branchName, job.baseBranch);
      state.remoteSha = await gitOrNull(commandPath, ["rev-parse", "--verify", `refs/remotes/origin/${job.branchName}`], { timeout: 10_000 });
    } catch (err) {
      state.pushError = trimError(err, 500);
      state.pushDeferred = err instanceof DevPublicationError && err.retryable;
    }
  }

  return state;
}

async function localState(job: BranchVerifyJob, epicMode: boolean): Promise<LocalState> {
  const inspected = await inspectLocalState(job, epicMode);
  return epicMode ? inspected : publishLocalState(job, inspected);
}

function commitSubject(job: BranchVerifyJob) {
  const prefix = job.commitPrefix?.trim();
  const summary = job.taskTitle?.trim() || `Update ${job.branchName}`;
  return `${prefix ? `${prefix} ` : ""}${summary}`.slice(0, 240);
}

async function commitPendingWorktreeChanges(job: BranchVerifyJob): Promise<CommitResult> {
  const worktreePath = await branchWorktree(job.repositoryPath, job.branchName);
  if (!worktreePath) {
    return { ok: false, error: `No registered worktree was found for ${job.branchName}.` };
  }
  let status: string;
  try {
    status = await git(worktreePath, ["status", "--porcelain"], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, error: `Could not inspect the task worktree: ${trimError(err, 500)}` };
  }
  if (!status) return { ok: true, created: false, sha: null };
  if (!job.expectedGitUserName || !job.expectedGitUserEmail) {
    return {
      ok: false,
      error: "The effective project Git identity is incomplete; PM cannot create the submission commit.",
    };
  }

  const subject = commitSubject(job);
  try {
    await git(worktreePath, ["add", "--all"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    await git(
      worktreePath,
      [
        "-c",
        `user.name=${job.expectedGitUserName}`,
        "-c",
        `user.email=${job.expectedGitUserEmail}`,
        "commit",
        "-m",
        subject,
      ],
      { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const sha = await git(worktreePath, ["rev-parse", "HEAD"], { timeout: 10_000 });
    return { ok: true, created: true, sha, subject };
  } catch (err) {
    return { ok: false, error: `PM could not create the submission commit: ${trimError(err, 700)}` };
  }
}

function semanticDescriptionWarning(job: BranchVerifyJob, head: GitCommit | null) {
  return semanticCommitDescriptionWarning({
    taskTitle: job.taskTitle,
    taskDescription: job.taskDescription,
    commitPrefix: job.commitPrefix,
    commitSubject: head?.subject,
  });
}

async function gitCommonDir(repo: string) {
  const out = await gitOrNull(repo, ["rev-parse", "--git-common-dir"], { timeout: 10_000 });
  if (!out) return null;
  return real(path.isAbsolute(out) ? out : path.resolve(repo, out));
}

async function servedWorktree() {
  const wd = await run("systemctl", ["show", "-p", "WorkingDirectory", "--value", "pm.service"], { timeout: 10_000 }).catch(() => "");
  const suffix = "/ai/web/.next/standalone";
  if (!wd.endsWith(suffix)) return null;
  return real(wd.slice(0, -suffix.length));
}

async function isSameRepo(a: string, b: string) {
  const [aCommon, bCommon] = await Promise.all([gitCommonDir(a), gitCommonDir(b)]);
  return Boolean(aCommon && bCommon && aCommon === bCommon);
}

function tail(value: string, lines = 30) {
  return value.split("\n").slice(-lines).join("\n").trim();
}

async function rebuildLiveWorktreeIfNeeded(job: BranchVerifyJob, state: LocalState): Promise<RebuildResult> {
  const served = await servedWorktree();
  if (!served) return { attempted: false, reason: "pm.service served worktree not detected" };

  const servedBranch = await currentBranch(served);
  if (servedBranch !== job.branchName) {
    return { attempted: false, reason: `served branch is ${servedBranch ?? "unknown"}, not ${job.branchName}` };
  }
  if (!(await isSameRepo(served, job.repositoryPath))) {
    return { attempted: false, reason: "served worktree belongs to a different repository" };
  }
  if (state.branchWorktreePath && real(state.branchWorktreePath) !== served) {
    return { attempted: false, reason: "verified branch worktree is not the served worktree" };
  }

  try {
    // The verifier itself uses Prisma against the same SQLite database that
    // pm-switch migrates before rebuilding the live worktree. Release the
    // verifier connection before invoking pm-switch; otherwise Prisma migrate
    // can fail with `database is locked` even after pm.service/pm-consumer have
    // been stopped. The module-level client reconnects on the next DB query.
    await db.$disconnect();
    const output = await run(SWITCH_SCRIPT, [served], { timeout: 240_000, maxBuffer: 1024 * 1024 * 4 });
    return { attempted: true, ok: true, target: served, log: tail(output) };
  } catch (err) {
    const anyErr = err as { stdout?: string; stderr?: string };
    const log = tail(`${anyErr.stdout ?? ""}\n${anyErr.stderr ?? ""}`);
    return { attempted: true, ok: false, target: served, error: trimError(err, 800), log };
  }
}

function authLikeError(value: string | null) {
  return Boolean(value && /(?:unauthorized|permission denied|could not read from remote|access rights|repository not found)/i.test(value));
}

function renderOkBody(args: {
  branchName: string;
  branchRefLabel: string;
  epicMode: boolean;
  head: GitCommit;
  match: GitCommit;
  commitPrefix: string | null;
  expectedIdentity: ExpectedIdentity | null;
  baseValidation: BranchBaseValidation;
  state: LocalState;
  rebuild: RebuildResult;
  candidateSha: string;
  checkpointBaseline: boolean;
}): string {
  const lines = [`${args.branchRefLabel} verified by the monitor agent.`, ""];
  if (args.checkpointBaseline) {
    lines.push(
      `- Candidate: \`${args.candidateSha.slice(0, 10)}\` is the task's recorded, already-published Epic checkpoint baseline.`,
      `- Checkpoint commit: \`${args.head.sha.slice(0, 10)}\` - ${args.head.subject}`,
      `  - ${authorLabel(args.head)} @ ${args.head.date}`,
      "- No repository changes were added after that checkpoint; finalization will use the no-change cleanup path.",
    );
  } else {
    lines.push(
      `- HEAD: \`${args.head.sha.slice(0, 10)}\` - ${args.head.subject}`,
      `  - ${authorLabel(args.head)} @ ${args.head.date}`,
    );
  }
  if (args.commitPrefix) {
    if (args.match.sha !== args.head.sha) {
      lines.push(
        `- Latest \`${args.commitPrefix}\`-prefixed commit: \`${args.match.sha.slice(0, 10)}\` - ${args.match.subject}`,
        `  - ${authorLabel(args.match)} @ ${args.match.date}`,
      );
    } else {
      lines.push(`- HEAD subject starts with \`${args.commitPrefix}\`.`);
    }
  } else {
    lines.push("- No COMMIT_PREFIX configured on task/epic; HEAD treated as the verified state.");
  }
  if (args.epicMode) {
    lines.push(
      `- Base verified: Epic branch \`${args.baseValidation.baseBranch}\` \`${args.baseValidation.originBaseSha?.slice(0, 10)}\` is an ancestor of \`refs/heads/${args.branchName}\`.`,
      args.checkpointBaseline
        ? `- Epic-child branch: local-only by design — never pushed. This candidate is already present on \`${args.baseValidation.baseBranch}\`; after reviewer acceptance PM removes the child worktree/local branch and only then marks the task Done.`
        : `- Epic-child branch: local-only by design — never pushed. After reviewer acceptance PM merges it into \`${args.baseValidation.baseBranch}\`, removes the child worktree/local branch, and only then marks the task Done.`,
    );
  } else {
    lines.push(
      `- Base verified: origin/${args.baseValidation.baseBranch} \`${args.baseValidation.originBaseSha?.slice(0, 10)}\` is an ancestor of \`origin/${args.branchName}\`.`,
    );
  }
  if (args.state.pushed) {
    lines.push(`- Monitor pushed the clean local branch to \`origin/${args.branchName}\`.`);
  }
  if (args.state.checkPath) {
    lines.push(`- Local worktree checked clean: \`${args.state.checkPath}\`.`);
  }
  if (args.expectedIdentity) {
    lines.push(`- Git identity verified: ${args.expectedIdentity.name} <${args.expectedIdentity.email}>.`);
  }
  if (args.rebuild.attempted && args.rebuild.ok) {
    lines.push(`- Live PM worktree rebuilt/restarted: \`${args.rebuild.target}\`.`);
  }
  return lines.join("\n");
}

function renderNoChangeBody(args: {
  branchName: string;
  branchRefLabel: string;
  epicMode: boolean;
  candidateSha: string;
  baseValidation: BranchBaseValidation;
  state: LocalState;
}): string {
  return [
    `${args.branchRefLabel} verified by the monitor agent.`,
    "",
    `- Candidate: \`${args.candidateSha.slice(0, 10)}\` exactly matches the task's recorded repository base.`,
    "- Classification: no repository changes. This was derived from the clean registered worktree and exact SHA comparison; it was not supplied by the assignee.",
    args.epicMode
      ? `- Epic-child branch remains local-only and is based on \`${args.baseValidation.baseBranch}\`.`
      : `- Standalone branch is synchronized with origin and based on \`${args.baseValidation.baseBranch}\`.`,
    args.state.checkPath
      ? `- Registered worktree checked clean: \`${args.state.checkPath}\`.`
      : null,
    "- Reviewer acceptance will use the no-change cleanup path for this exact candidate.",
  ].filter(Boolean).join("\n");
}

function renderProtectedBranchBody(args: { branchName: string; epicMode: boolean; protectedBranches: string[] }) {
  return [
    `Branch \`${args.branchName}\` is blocked from reviewer hand-off.`,
    "",
    `- Branch \`${args.branchName}\` is configured as a protected agent branch for this project.`,
    args.protectedBranches.length > 0 ? `- Protected branches: ${args.protectedBranches.map((branch) => `\`${branch}\``).join(", ")}.` : null,
    "",
    "Assignee: start the task on an allowed task branch, leave the corrected changes uncommitted and unpushed, then call `ready_for_review` again. PM owns commit and publication.",
  ].filter(Boolean).join("\n");
}

function renderPreflightFailBody(args: {
  job: BranchVerifyJob;
  epicMode: boolean;
  fetchError: string | null;
  baseValidation: BranchBaseValidation;
  state: LocalState;
  recovery: StandaloneBranchRecoveryResult | null;
}) {
  const branchRef = `refs/heads/${args.job.branchName}`;
  const baseRef = args.epicMode
    ? args.baseValidation.baseBranch
    : `origin/${args.baseValidation.baseBranch}`;
  return [
    `Local branch \`${args.job.branchName}\` failed the read-only submission preflight.`,
    "",
    args.fetchError ? `- Base refresh failed: ${args.fetchError}` : null,
    args.state.dirtyError ? `- Local worktree status check failed: \`${args.state.dirtyError}\`` : null,
    args.recovery && !args.recovery.ok
      ? `- Automatic graph recovery stopped safely: ${args.recovery.error}`
      : null,
    !args.baseValidation.ok
      ? `- Branch-base validation failed: ${args.baseValidation.error}.`
      : null,
    !args.baseValidation.ok
      ? `  - ${baseRef}: ${args.baseValidation.originBaseSha?.slice(0, 10) ?? "unavailable"}`
      : null,
    !args.baseValidation.ok
      ? `  - ${branchRef}: ${args.baseValidation.branchSha?.slice(0, 10) ?? "unavailable"}`
      : null,
    !args.baseValidation.ok
      ? `  - merge base: ${args.baseValidation.mergeBaseSha?.slice(0, 10) ?? "unavailable"}`
      : null,
    "- Safety boundary: PM did not create a submission commit and did not push the task branch.",
    "",
    args.epicMode
      ? "PM could not prepare Epic synchronization from this repository state. Report the concrete repository diagnostic; do not manually merge, rebase, commit or push the task branch. PM owns synchronization."
      : `Assignee: update the local task branch from \`origin/${args.baseValidation.baseBranch}\`, preserve the task changes, leave them uncommitted and unpushed, then call \`ready_for_review\` again. PM owns the submission commit and publication.`,
  ].filter(Boolean).join("\n");
}

function renderFailBody(args: {
  branchName: string;
  branchRefLabel: string;
  epicMode: boolean;
  head: GitCommit | null;
  match: GitCommit | null;
  commitPrefix: string | null;
  fetchError: string | null;
  logError: string | null;
  identityMismatch: IdentityMismatch | null;
  baseValidation: BranchBaseValidation;
  state: LocalState;
  rebuild: RebuildResult | null;
}): string {
  const monitorAccessError = authLikeError(args.fetchError) || authLikeError(args.state.pushError);
  const baseLabel = args.epicMode
    ? `Epic branch ${args.baseValidation.baseBranch}`
    : `origin/${args.baseValidation.baseBranch}`;
  const lines = [`${args.branchRefLabel} is not ready for reviewer hand-off.`, ""];
  if (args.state.dirtyError) lines.push(`- Local worktree status check failed: \`${args.state.dirtyError}\``);
  if (args.state.dirtyStatus) {
    lines.push(
      `- Local worktree still has uncommitted changes at \`${args.state.checkPath ?? "unknown"}\`:`,
      "```",
      args.state.dirtyStatus.slice(0, 2000),
      "```",
    );
  }
  if (args.fetchError) lines.push(`- Fetching origin/${args.baseValidation.baseBranch} and origin/${args.branchName} failed: ${args.fetchError}`);
  if (args.state.pushError) lines.push(`- Monitor could not push \`${args.branchName}\` to origin: \`${args.state.pushError}\``);
  if (args.logError) lines.push(`- \`git log\` failed: \`${args.logError}\``);
  if (args.epicMode && args.state.remoteSha) {
    lines.push(
      `- Epic-child policy breach: forbidden remote ref \`origin/${args.branchName}\` exists at \`${args.state.remoteSha.slice(0, 10)}\`.`,
      `- Preserve any remote-only commits locally, then delete \`origin/${args.branchName}\`. Only the Epic branch \`${args.baseValidation.baseBranch}\` may be published.`,
    );
  }
  if (!args.epicMode && args.state.localSha && args.state.remoteSha && args.state.localSha !== args.state.remoteSha) {
    lines.push(
      `- Local branch head \`${args.state.localSha.slice(0, 10)}\` does not match origin head \`${args.state.remoteSha.slice(0, 10)}\`.`,
    );
  }
  if (!args.head) {
    lines.push(
      args.epicMode
        ? `- No commits found on \`refs/heads/${args.branchName}\` beyond the Epic branch base. Commit your work locally on the task branch.`
        : `- No commits found on \`origin/${args.branchName}\`. Was the branch pushed?`,
    );
  } else {
    lines.push(`- HEAD on ${args.branchRefLabel}: \`${args.head.sha.slice(0, 10)}\` - ${args.head.subject} (${authorLabel(args.head)} @ ${args.head.date})`);
    if (args.commitPrefix) {
      if (args.match) {
        lines.push(`- Latest \`${args.commitPrefix}\`-prefixed commit visible locally: \`${args.match.sha.slice(0, 10)}\` - ${args.match.subject}`);
      } else {
        lines.push(
          `- None of the last 20 commits on \`${args.branchRefLabel}\` start with \`${args.commitPrefix}\`.`,
        );
      }
    }
  }
  if (!args.baseValidation.ok) {
    lines.push(
      `- Branch-base validation failed: ${args.baseValidation.error}.`,
      `  - ${baseLabel}: ${args.baseValidation.originBaseSha?.slice(0, 10) ?? "unavailable"}`,
      `  - ${args.branchRefLabel}: ${args.baseValidation.branchSha?.slice(0, 10) ?? "unavailable"}`,
      `  - merge base: ${args.baseValidation.mergeBaseSha?.slice(0, 10) ?? "unavailable"}`,
    );
  }
  if (args.identityMismatch) {
    lines.push(
      `- Git identity mismatch on the verified commit. Expected ${args.identityMismatch.expected.name} <${args.identityMismatch.expected.email}>.`,
      `  - Author: ${args.identityMismatch.author}`,
      `  - Committer: ${args.identityMismatch.committer}`,
    );
  }
  if (args.rebuild?.attempted && !args.rebuild.ok) {
    lines.push(`- Branch verified, but live rebuild/restart failed for \`${args.rebuild.target}\`: \`${args.rebuild.error}\``);
  }
  lines.push("");
  if (monitorAccessError) {
    lines.push(
      "This includes a Monitor Agent repository-access problem. Fix the runner Git credentials, then re-trigger `ready_for_review`; do not ask the assignee to commit or push around the failure.",
    );
  } else if (args.rebuild?.attempted && !args.rebuild.ok) {
    lines.push("Fix the live PM rebuild/restart failure, then re-trigger `ready_for_review` so the reviewer is woken only after the live build is healthy.");
  } else {
    lines.push(
      `Assignee: start the task again, correct the reported problem in the PM-provisioned worktree on \`${args.branchName}\`, leave the changes uncommitted and unpushed, then call \`ready_for_review\` again. PM owns the submission commit and publication.`,
    );
  }
  return lines.join("\n");
}

async function monitorActor(job: BranchVerifyJob) {
  if (job.monitorUserId) {
    const selected = await db.user.findFirst({
      where: {
        id: job.monitorUserId,
        status: "active",
        kind: "agent",
        agent: { is: { role: "monitor", deactivatedAt: null } },
      },
      select: { id: true, username: true },
    });
    if (selected) return { ...selected, kind: "agent" as const };
  }
  const monitor = await resolveActiveMonitorAgent();
  if (!monitor.ok) throw new Error(monitor.error);
  return {
    id: monitor.user.id,
    username: monitor.user.username,
    kind: "agent" as const,
  };
}

async function recordOperationalFailure(
  job: BranchVerifyJob,
  actor: Awaited<ReturnType<typeof monitorActor>> | null,
  error: string,
) {
  await recordTaskReviewOperationalError({ taskId: job.taskId, actor, error });
  const attempt = job.attempt ?? 0;
  if (attempt < 2) {
    await enqueueBranchVerifyJob({
      ...job,
      attempt: attempt + 1,
      requestedAt: new Date().toISOString(),
    });
    return { retrying: true, attempt: attempt + 1 };
  }
  if (actor) {
    await db.comment.create({
      data: {
        taskId: job.taskId,
        userId: actor.id,
        body: [
          "⚙️ Repository validation could not complete because of an operational failure.",
          "",
          error,
          "",
          "The task status was left unchanged and the reviewer was not notified. Operator intervention is required.",
        ].join("\n"),
      },
    });
  }
  return { retrying: false, attempt };
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error("Usage: pm-verify-branch-pushed <job.json>");
  if (!existsSync(jobFile)) throw new Error(`Job file not found: ${jobFile}`);
  if (!jobFile.startsWith(BRANCH_VERIFY_DIR)) {
    throw new Error(`Refusing to read job file outside ${BRANCH_VERIFY_DIR}`);
  }

  const job = JSON.parse(readFileSync(jobFile, "utf8")) as BranchVerifyJob;
  // Legacy and unknown jobs are preserved for operator inspection but never
  // guessed back onto a task or procedure.
  if (
    job.schemaVersion !== 2 ||
    !job.procedureRunId ||
    !job.procedureStepId ||
    job.workflowCycleId === undefined ||
    !job.repositoryRunId ||
    typeof job.repositoryRunVersion !== "number"
  ) {
    const skipPath = `${jobFile}.skipped`;
    console.error(
      `[pm-verify] retired or incomplete job ${job.jobId}; renaming to ${skipPath}.`,
    );
    try {
      renameSync(jobFile, skipPath);
    } catch {
      // If rename fails (e.g. permissions), unlink to prevent re-read loop.
      try { unlinkSync(jobFile); } catch { /* best effort */ }
    }
    return;
  }
  let actor: Awaited<ReturnType<typeof monitorActor>> | null = null;
  try {
    actor = await monitorActor(job);
  } catch (err) {
    const error = trimError(err, 600);
    const retry = await recordOperationalFailure(job, null, error);
    console.log(JSON.stringify({ ok: false, operationalError: error, ...retry }, null, 2));
    unlinkSync(jobFile);
    return;
  }
  const taskCycle = await db.task.findUnique({
    where: { id: job.taskId },
    select: { activeWorkflowCycleId: true },
  });
  if (!taskCycle) {
    console.error(`[pm-verify] dropping verifier job ${job.jobId}: task ${job.taskId} no longer exists`);
    unlinkSync(jobFile);
    return;
  }
  if (job.workflowCycleId !== undefined && taskCycle?.activeWorkflowCycleId !== job.workflowCycleId) {
    const reason = "verifier job no longer belongs to the task's active workflow cycle";
    await db.activityLog.create({
      data: {
        projectId: job.projectId,
        taskId: job.taskId,
        userId: actor.id,
        kind: "pm.repo.verify.rejected_stale_cycle",
        payload: JSON.stringify({
          jobId: job.jobId,
          procedureRunId: job.procedureRunId ?? null,
          procedureStepId: job.procedureStepId ?? null,
          jobWorkflowCycleId: job.workflowCycleId,
          activeWorkflowCycleId: taskCycle?.activeWorkflowCycleId ?? null,
          reason,
        }),
      },
    });
    console.error(`[pm-verify] rejecting stale verifier job ${job.jobId}: job cycle ${job.workflowCycleId ?? "null"}, active cycle ${taskCycle?.activeWorkflowCycleId ?? "null"}`);
    unlinkSync(jobFile);
    return;
  }
  // P6 local-only mode: an Epic child is verified on its LOCAL ref against the
  // Epic integration branch and never pushed, even when the job predates the
  // epicBranch field (epicChild alone forces the no-push rule).
  const epicMode = Boolean(job.epicChild);
  const branchRefLabel = epicMode ? `refs/heads/${job.branchName}` : `origin/${job.branchName}`;
  const project = await db.project.findFirst({
    where: { id: job.projectId },
    select: { agentChangeBlockedBranches: true },
  });
  if (project && isProtectedBranch(project.agentChangeBlockedBranches, job.branchName)) {
    const protectedBranches = parseProtectedBranches(project.agentChangeBlockedBranches);
    const body = renderProtectedBranchBody({ branchName: job.branchName, epicMode, protectedBranches });
    await db.$transaction([
      db.comment.create({
        data: { taskId: job.taskId, userId: actor.id, body },
      }),
      db.activityLog.create({
        data: {
          projectId: job.projectId,
          taskId: job.taskId,
          userId: actor.id,
          kind: "pm.repo.verify.fail",
          payload: JSON.stringify({
            jobId: job.jobId,
            branchName: job.branchName,
            protectedBranches,
            requestedByAgentSlug: job.requestedByAgentSlug,
            reason: "protected-agent-branch",
          }),
        },
      }),
    ]);
    await failTaskReviewValidation({
      taskId: job.taskId,
      actor,
      error: body,
      candidateSha: job.previousCandidateSha ?? null,
      procedureCallback: procedureCallbackForJob(job),
    });
    console.log(JSON.stringify({ ok: false, taskId: job.taskId, branch: job.branchName, protectedBranch: true }, null, 2));
    unlinkSync(jobFile);
    return;
  }

  // Inspect before submission. Epic base drift is a PM-owned synchronization:
  // preserve the work, integrate locally, then return it for fresh validation.
  // Never hand an automatically changed candidate directly to the reviewer.
  let preflightState = await inspectLocalState(job, epicMode);
  let preflightFetchError: string | null = null;
  let preflightBase: BranchBaseValidation;
  let preflightRecovery: StandaloneBranchRecoveryResult | null = null;
  if (epicMode) {
    const epicBase = await resolveEpicVerificationBase(job.repositoryPath, job.epicBranch);
    preflightFetchError = epicBase.error;
    preflightBase = await validateEpicBase(job.repositoryPath, job.branchName, epicBase);
    if (!preflightFetchError && !preflightState.dirtyError && preflightState.branchWorktreePath && preflightBase.originBaseSha) {
      const sync = await synchronizeEpicChild({
        worktreePath: preflightState.branchWorktreePath,
        branchName: job.branchName,
        baseSha: preflightBase.originBaseSha,
        requestId: job.jobId,
        commitSubject: commitSubject(job),
        gitUserName: job.expectedGitUserName,
        gitUserEmail: job.expectedGitUserEmail,
      });
      if (sync.outcome === "error") {
        const retry = await recordOperationalFailure(job, actor, `PM Epic synchronization failed safely: ${sync.error}`);
        console.log(JSON.stringify({ ok: false, phase: "epic-sync", sync, ...retry }));
        unlinkSync(jobFile);
        return;
      }
      const canValidateSynchronizedCandidate = sync.outcome === "revalidate" &&
        (job.validationProfile?.commands.some(command => command.required) ?? false);
      if (canValidateSynchronizedCandidate) {
        // Only an installed required application-validation profile can avoid
        // the handoff. Git cleanliness/ancestry alone is not fresh evidence.
        preflightState = await inspectLocalState(job, true);
        preflightBase = await validateEpicBase(job.repositoryPath, job.branchName, epicBase);
        await db.activityLog.create({ data: {
          projectId: job.projectId, taskId: job.taskId, userId: actor.id,
          kind: "pm.repo.epic_sync", payload: JSON.stringify({ jobId: job.jobId, branchName: job.branchName, ...sync, validationProfileVersion: job.validationProfile!.version, validationRequired: true }),
        } });
      } else if (sync.outcome !== "unchanged") {
        const body = renderEpicSyncHandoff(sync, job.branchName, preflightBase.baseBranch);
        await db.$transaction([
          db.comment.create({ data: { taskId: job.taskId, userId: actor.id, body } }),
          db.activityLog.create({ data: {
            projectId: job.projectId, taskId: job.taskId, userId: actor.id,
            kind: "pm.repo.epic_sync", payload: JSON.stringify({ jobId: job.jobId, branchName: job.branchName, ...sync }),
          } }),
        ]);
        await failTaskReviewValidation({
          taskId: job.taskId, actor, error: body,
          candidateSha: job.previousCandidateSha ?? null,
          procedureCallback: procedureCallbackForJob(job),
        });
        console.log(JSON.stringify({ ok: false, phase: "epic-sync", revalidationRequired: true, sync }));
        unlinkSync(jobFile);
        return;
      }
    }
  } else {
    const fetchedBase = await fetchVerificationBase(job.repositoryPath, job.baseBranch);
    preflightFetchError = fetchedBase.error;
    preflightBase = await validateLocalBranchBase(
      job.repositoryPath,
      job.branchName,
      fetchedBase.baseBranch,
    );
    if (
      !preflightFetchError &&
      !preflightState.dirtyError &&
      !preflightState.dirtyStatus &&
      preflightState.branchWorktreePath
    ) {
      preflightRecovery = await reconcileStandaloneBranch({
        worktreePath: preflightState.branchWorktreePath,
        branchName: job.branchName,
        baseBranch: fetchedBase.baseBranch,
        gitUserName: job.expectedGitUserName,
        gitUserEmail: job.expectedGitUserEmail,
      });
      if (preflightRecovery.ok) {
        preflightState = await inspectLocalState(job, false);
        preflightBase = await validateLocalBranchBase(
          job.repositoryPath,
          job.branchName,
          fetchedBase.baseBranch,
        );
      }
    }
  }

  const preflightOperationalError =
    (isOperationalRepositoryFailure(preflightFetchError) ? preflightFetchError : null) ||
    (isOperationalRepositoryFailure(preflightState.dirtyError) ? preflightState.dirtyError : null) ||
    (preflightRecovery?.operational ? preflightRecovery.error : null);
  if (preflightOperationalError) {
    const retry = await recordOperationalFailure(job, actor, preflightOperationalError);
    console.log(JSON.stringify({
      ok: false,
      taskId: job.taskId,
      branch: job.branchName,
      phase: "preflight",
      operationalError: preflightOperationalError,
      ...retry,
    }, null, 2));
    unlinkSync(jobFile);
    return;
  }

  if (
    preflightFetchError ||
    preflightState.dirtyError ||
    !preflightBase.ok ||
    (preflightRecovery && !preflightRecovery.ok)
  ) {
    const body = renderPreflightFailBody({
      job,
      epicMode,
      fetchError: preflightFetchError,
      baseValidation: preflightBase,
      state: preflightState,
      recovery: preflightRecovery,
    });
    await db.$transaction([
      db.comment.create({
        data: { taskId: job.taskId, userId: actor.id, body },
      }),
      db.activityLog.create({
        data: {
          projectId: job.projectId,
          taskId: job.taskId,
          userId: actor.id,
          kind: "pm.repo.verify.fail",
          payload: JSON.stringify({
            jobId: job.jobId,
            branchName: job.branchName,
            baseBranch: preflightBase.baseBranch,
            epicChild: epicMode,
            reason: "submission-preflight-failed",
            fetchError: preflightFetchError,
            dirtyError: preflightState.dirtyError,
            localSha: preflightState.localSha,
            remoteSha: preflightState.remoteSha,
            baseValidation: preflightBase,
            recovery: preflightRecovery,
            mutated: false,
          }),
        },
      }),
    ]);
    await updateTaskRepositoryState(job.taskId, {
      phase: "action_required",
      candidateSha: job.previousCandidateSha ?? null,
      validationOutcome: "invalid",
      lastError: body,
    });
    await failTaskReviewValidation({
      taskId: job.taskId,
      actor,
      error: body,
      candidateSha: job.previousCandidateSha ?? null,
      procedureCallback: procedureCallbackForJob(job),
    });
    console.log(JSON.stringify({
      ok: false,
      taskId: job.taskId,
      branch: job.branchName,
      phase: "preflight",
      baseValidation: preflightBase,
      mutated: false,
    }, null, 2));
    unlinkSync(jobFile);
    return;
  }

  if (preflightRecovery?.ok && preflightRecovery.changed) {
    await db.activityLog.create({
      data: {
        projectId: job.projectId,
        taskId: job.taskId,
        userId: actor.id,
        kind: "pm.repo.recovery.ok",
        payload: JSON.stringify({
          jobId: job.jobId,
          branchName: job.branchName,
          baseBranch: preflightBase.baseBranch,
          originalSha: preflightRecovery.originalSha,
          recoveredSha: preflightRecovery.recoveredSha,
          remoteSha: preflightRecovery.remoteSha,
          baseSha: preflightRecovery.baseSha,
          mergedRefs: preflightRecovery.mergedRefs,
          forcePush: false,
        }),
      },
    });
  }

  const commitResult = await commitPendingWorktreeChanges(job);
  if (!commitResult.ok) {
    const operational = isOperationalRepositoryFailure(commitResult.error);
    const body = [
      operational
        ? "PM could not create or inspect the submission commit because of an operational failure."
        : "The submission commit could not be validated.",
      "",
      commitResult.error,
    ].join("\n");
    if (operational) {
      const retry = await recordOperationalFailure(job, actor, body);
      console.log(JSON.stringify({ ok: false, operationalError: body, ...retry }, null, 2));
    } else {
      await db.$transaction([
        db.comment.create({
          data: { taskId: job.taskId, userId: actor.id, body },
        }),
        db.activityLog.create({
          data: {
            projectId: job.projectId,
            taskId: job.taskId,
            userId: actor.id,
            kind: "pm.repo.verify.fail",
            payload: JSON.stringify({
              jobId: job.jobId,
              branchName: job.branchName,
              reason: "commit-creation-failed",
              error: commitResult.error,
            }),
          },
        }),
      ]);
      await failTaskReviewValidation({
        taskId: job.taskId,
        actor,
        error: body,
        candidateSha: job.previousCandidateSha ?? null,
        procedureCallback: procedureCallbackForJob(job),
      });
      console.log(JSON.stringify({ ok: false, validationError: body }, null, 2));
    }
    unlinkSync(jobFile);
    return;
  }

  let fetchError: string | null;
  let baseValidation: BranchBaseValidation;
  let commits: GitCommit[];
  let logError: string | null;
  let state: LocalState;
  if (epicMode) {
    // Local-only verification: the base is origin's current Epic integration
    // branch (local fallback only when origin has no Epic ref yet) and the
    // verified ref is refs/heads/<branch>.
    // No auto-push, no local-vs-origin sync gate.
    const epicBase = await resolveEpicVerificationBase(job.repositoryPath, job.epicBranch);
    state = await localState(job, true);
    const remoteTaskBranch = await inspectOriginBranch(job.repositoryPath, job.branchName);
    state.remoteSha = remoteTaskBranch.ok ? remoteTaskBranch.sha : null;
    fetchError = remoteTaskBranch.ok ? null : remoteTaskBranch.reason;
    baseValidation = await validateEpicBase(job.repositoryPath, job.branchName, epicBase);
    if (epicBase.baseRef && state.localSha) {
      ({ commits, error: logError } = await readLog(job.repositoryPath, epicBase.baseRef, `refs/heads/${job.branchName}`));
    } else {
      commits = [];
      logError = null;
    }
  } else {
    let fetched = await fetchVerificationBranch(job.repositoryPath, job.branchName, job.baseBranch);
    state = await localState(job, false);
    if (state.pushDeferred && jobFile.endsWith(".running")) {
      // Keep the exact publication attempt while another task owns Dev or its
      // pipeline is still verifying. No new task turn or review rejection.
      renameSync(jobFile, jobFile.slice(0, -".running".length));
      console.log(JSON.stringify({ ok: false, deferred: true, reason: state.pushError }));
      return;
    }
    // A successful recovery push can turn an initial "remote ref not found"
    // into a valid verification state. Resolve/fetch once more before gating.
    if (state.pushed) {
      fetched = await fetchVerificationBranch(job.repositoryPath, job.branchName, job.baseBranch);
    }
    fetchError = fetched.error;
    ({ commits, error: logError } = await readLog(job.repositoryPath, `origin/${fetched.baseBranch}`, `origin/${job.branchName}`));
    baseValidation = await validateOriginBase(job.repositoryPath, job.branchName, fetched.baseBranch);
  }
  const checkpointBaseline = epicMode && commits.length === 0 && !logError
    ? await recordedCheckpointReviewBaseline({ job, state, baseValidation })
    : null;
  const head = commits[0] ?? checkpointBaseline?.checkpoint ?? null;
  const match = job.commitPrefix
    ? commits.find((c) => subjectHasCommitPrefix(c.subject, job.commitPrefix!)) ??
      (checkpointBaseline && subjectHasCommitPrefix(checkpointBaseline.checkpoint.subject, job.commitPrefix)
        ? checkpointBaseline.checkpoint
        : null)
    : head;
  const requiredIdentity = expectedIdentity(job);
  const mismatch = identityMismatch(match, requiredIdentity);

  // The pushed/synced gate is standalone-only; an Epic child's local ref IS
  // the verified artifact (P6).
  // Epic-child branches must be absent from origin. This is checked against
  // the remote itself (not a stale tracking ref), so --no-verify pushes and
  // branches published before the pre-push hook fail reviewer hand-off.
  const branchSynced = epicMode
    ? !state.remoteSha
    : !state.localSha || !state.remoteSha || state.localSha === state.remoteSha;
  const noChangeCandidate = Boolean(
    !commitResult.created &&
    job.baseSha &&
    state.localSha === job.baseSha &&
    !state.dirtyStatus &&
    !state.dirtyError,
  );
  const gitVerifiedOk =
    !fetchError &&
    !logError &&
    !state.dirtyStatus &&
    !state.dirtyError &&
    !state.pushError &&
    baseValidation.ok &&
    branchSynced &&
    (noChangeCandidate || (head !== null && match !== null && !mismatch));
  const candidateSha = noChangeCandidate
    ? state.localSha
    : checkpointBaseline?.candidateSha ?? head?.sha ?? null;

  let validationChecks: ValidationExecutionResult = { ok: true, summary: null, checks: [] };
  let postValidationDirty: string | null = null;
  let postValidationHead: string | null = null;
  if (gitVerifiedOk && candidateSha) {
    // B5 fix: select the review run by the ACTIVE workflow cycle, not by
    // (taskId, candidateSha). The same candidate SHA may appear in multiple
    // cycles (V23-36); resetting a historical decided lease would destroy
    // review evidence. If the task has an active cycle, use its review run.
    // If not, create a new one. Never mutate a decided (accepted/
    // changes_requested/completed) historical lease.
    const workflowCycleId = job.workflowCycleId !== undefined
      ? job.workflowCycleId
      : taskCycle?.activeWorkflowCycleId ?? null;
    let existingRun: { id: string } | null = null;
    if (workflowCycleId) {
      existingRun = await db.reviewRun.findUnique({
        where: { workflowCycleId },
        select: { id: true },
      });
    }
    // Only reuse if the existing run is NOT in a decided state.
    if (existingRun) {
      const runStatus = await db.reviewRun.findUniqueOrThrow({ where: { id: existingRun.id }, select: { status: true } });
      if (["accepted", "changes_requested", "completed"].includes(runStatus.status)) {
        // The active cycle's lease is already decided — reject this verifier
        // job durably. Record an activity row so the reconciler can detect
        // stale jobs and the operator can investigate. Do NOT create an
        // unbound validation row or mutate the decided lease.
        await db.activityLog.create({
          data: {
            projectId: job.projectId,
            taskId: job.taskId,
            kind: "pm.repo.verify.rejected_decided_lease",
            payload: JSON.stringify({
              jobId: job.jobId,
              workflowCycleId,
              leaseStatus: runStatus.status,
              candidateSha,
              reason: "verifier job arrived for a cycle whose lease is already decided",
            }),
          },
        });
        console.error(`[pm-verify] rejecting verifier job ${job.jobId}: cycle ${workflowCycleId} has a decided lease (${runStatus.status})`);
        unlinkSync(jobFile);
        return;
      }
    }
    const reviewRun = existingRun
      ? await db.reviewRun.update({
          where: { id: existingRun.id },
          data: {
            candidateSha,
            baseSha: job.baseSha ?? null,
            repoTouched: !noChangeCandidate && !checkpointBaseline,
            validationOutcome: "pending",
            status: "validating",
            reviewerId: null,
            reviewedAt: null,
            invalidatedAt: null,
            invalidatedReason: null,
          },
          select: { id: true },
        })
      : await db.reviewRun.create({
          data: {
            taskId: job.taskId,
            workflowCycleId,
            candidateSha,
            baseSha: job.baseSha ?? null,
            repoTouched: !noChangeCandidate && !checkpointBaseline,
            validationOutcome: "pending",
            status: "validating",
          },
          select: { id: true },
        });
    if ((job.validationProfile?.commands.length ?? 0) > 0) {
      if (!state.checkPath) {
        validationChecks = {
          ok: false,
          summary: "The project validation profile could not run because the task has no registered worktree.",
          checks: [],
        };
      } else {
        validationChecks = await runCandidateValidationChecks({
          job,
          reviewRunId: reviewRun.id,
          candidateSha,
          worktreePath: state.checkPath,
        });
        [postValidationDirty, postValidationHead] = await Promise.all([
          gitOrNull(state.checkPath, ["status", "--porcelain"]),
          gitOrNull(state.checkPath, ["rev-parse", "HEAD"]),
        ]);
        if (postValidationDirty) {
          validationChecks.ok = false;
          validationChecks.summary = [
            validationChecks.summary,
            "Validation commands modified the registered worktree; candidate review was refused.",
          ].filter(Boolean).join(" ");
        }
        if (postValidationHead !== candidateSha) {
          validationChecks.ok = false;
          validationChecks.summary = [
            validationChecks.summary,
            `The candidate moved during validation (expected ${candidateSha}, found ${postValidationHead ?? "unreadable"}).`,
          ].filter(Boolean).join(" ");
        }
      }
    }
  }
  const repoVerifiedOk = gitVerifiedOk && validationChecks.ok;
  const rebuild = repoVerifiedOk
    ? await rebuildLiveWorktreeIfNeeded(job, state)
    : null;
  const reviewReady = repoVerifiedOk && (!rebuild?.attempted || rebuild.ok);
  const semanticWarning = reviewReady && !noChangeCandidate ? semanticDescriptionWarning(job, head) : null;
  const advisoryValidationFailures = validationChecks.checks.filter(
    (check) => !check.required && check.status === "failed",
  );
  const validationWarning = advisoryValidationFailures.length > 0
    ? `Optional validation failures: ${advisoryValidationFailures.map((check) => check.name).join(", ")}.`
    : null;
  const successfulOutcome = semanticWarning || validationWarning
    ? "valid_with_warning" as const
    : "valid" as const;
  const validationOutcome = reviewReady ? successfulOutcome : "invalid" as const;
  const kind = reviewReady
    ? semanticWarning ? "pm.repo.verify.warning" : "pm.repo.verify.ok"
    : "pm.repo.verify.fail";

  const baseBody = reviewReady
    ? noChangeCandidate
      ? renderNoChangeBody({ branchName: job.branchName, branchRefLabel, epicMode, candidateSha: candidateSha!, baseValidation, state })
      : renderOkBody({ branchName: job.branchName, branchRefLabel, epicMode, head: head!, match: match!, commitPrefix: job.commitPrefix, expectedIdentity: requiredIdentity, baseValidation, state, rebuild: rebuild!, candidateSha: candidateSha!, checkpointBaseline: Boolean(checkpointBaseline) })
    : renderFailBody({ branchName: job.branchName, branchRefLabel, epicMode, head, match, commitPrefix: job.commitPrefix, fetchError, logError, identityMismatch: mismatch, baseValidation, state, rebuild });
  const validationSection = validationChecks.summary
    ? `Validation profile\n\n${validationChecks.summary}`
    : null;
  const warningSection = [semanticWarning, validationWarning].filter(Boolean).join("\n");
  const body = [
    baseBody,
    validationSection,
    warningSection ? `⚠️ Advisory validation warning\n\n${warningSection}` : null,
  ].filter(Boolean).join("\n\n");
  const operationalError =
    (isOperationalRepositoryFailure(fetchError) ? fetchError : null) ||
    (isOperationalRepositoryFailure(state.pushError) ? state.pushError : null) ||
    (isOperationalRepositoryFailure(state.dirtyError) ? state.dirtyError : null) ||
    (rebuild?.attempted && !rebuild.ok ? rebuild.error : null);

  if (operationalError) {
    const retry = await recordOperationalFailure(job, actor, operationalError);
    console.log(
      JSON.stringify(
        {
          ok: false,
          taskId: job.taskId,
          branch: job.branchName,
          operationalError,
          ...retry,
        },
        null,
        2,
      ),
    );
    unlinkSync(jobFile);
    return;
  }

  await db.$transaction([
    db.comment.create({
      data: { taskId: job.taskId, userId: actor.id, body },
    }),
    db.activityLog.create({
      data: {
        projectId: job.projectId,
        taskId: job.taskId,
        userId: actor.id,
        kind,
        payload: JSON.stringify({
          jobId: job.jobId,
          branchName: job.branchName,
          baseBranch: baseValidation.baseBranch,
          epicChild: epicMode,
          epicBranch: job.epicBranch ?? null,
          commitPrefix: job.commitPrefix,
          headSha: head?.sha ?? null,
          candidateSha,
          checkpointBaseline: checkpointBaseline
            ? {
                epicSha: checkpointBaseline.candidateSha,
                checkpointSha: checkpointBaseline.checkpoint.sha,
              }
            : null,
          noChangeCandidate,
          matchSha: match?.sha ?? null,
          expectedGitUserName: job.expectedGitUserName,
          expectedGitUserEmail: job.expectedGitUserEmail,
          identityMismatch: mismatch,
          baseValidation,
          fetchError,
          logError,
          localCheckPath: state.checkPath,
          branchWorktreePath: state.branchWorktreePath,
          dirty: Boolean(state.dirtyStatus),
          dirtyError: state.dirtyError,
          localSha: state.localSha,
          remoteSha: state.remoteSha,
          pushed: state.pushed,
          pushError: state.pushError,
          rebuild,
          validationOutcome,
          semanticWarning,
          validationWarning,
          validationChecks,
          postValidationDirty,
          postValidationHead,
          pmCreatedCommitSha: commitResult.created ? commitResult.sha : null,
          requestedByAgentSlug: job.requestedByAgentSlug,
        }),
      },
    }),
  ]);
  await updateTaskRepositoryState(job.taskId, {
    phase: reviewReady ? "review_ready" : "action_required",
    candidateSha,
    validationOutcome,
    lastError: reviewReady ? null : body,
  });
  if (reviewReady) {
    await completeTaskReviewHandoffAfterValidation({
      taskId: job.taskId,
      actor,
      candidateSha,
      validationOutcome: successfulOutcome,
      validationSummary: [validationChecks.summary, semanticWarning, validationWarning]
        .filter(Boolean)
        .join(" ") || baseBody,
      repoTouched: !noChangeCandidate && !checkpointBaseline,
      procedureCallback: procedureCallbackForJob(job),
    });
  } else {
    await failTaskReviewValidation({
      taskId: job.taskId,
      actor,
      error: body,
      candidateSha,
      procedureCallback: procedureCallbackForJob(job),
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: reviewReady,
        repoVerifiedOk,
        taskId: job.taskId,
        branch: job.branchName,
        epicChild: epicMode,
        epicBranch: job.epicBranch ?? null,
        headSha: head?.sha ?? null,
        matchSha: match?.sha ?? null,
        dirty: Boolean(state.dirtyStatus),
        pushed: state.pushed,
        identityMismatch: mismatch,
        baseValidation,
        fetchError,
        pushError: state.pushError,
        logError,
        rebuild,
        validationOutcome,
        semanticWarning,
        validationWarning,
        validationChecks,
        postValidationDirty,
        postValidationHead,
        noChangeCandidate,
        pmCreatedCommitSha: commitResult.created ? commitResult.sha : null,
      },
      null,
      2,
    ),
  );

  unlinkSync(jobFile);
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    try {
      await db.$disconnect();
    } catch {}
    process.exit(1);
  });
