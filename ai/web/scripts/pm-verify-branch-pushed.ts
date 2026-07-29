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
//   the Epic integration branch (local refs/heads/<epicBranch>, falling back
//   to origin/<epicBranch>) instead of the deployment target; there is no
//   auto-push and no local-vs-origin sync check. Commit-prefix, identity,
//   dirty-worktree, live-rebuild, and wake gating are unchanged.
//
// Invoked as: pnpm exec tsx scripts/pm-verify-branch-pushed.ts <job-file>

import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
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
  fetchVerificationBranch,
  resolveEpicVerificationBase,
  validateEpicBase,
  validateOriginBase,
  type BranchBaseValidation,
} from "@/lib/deploy/branch-base";
import { subjectHasCommitPrefix } from "@/lib/work-items/commit-prefix";
import { inspectOriginBranch } from "@/lib/deploy/epic-merge-git";
import {
  completeTaskReviewHandoffAfterValidation,
  failTaskReviewValidation,
  recordTaskReviewOperationalError,
} from "@/lib/tasks/review-handoff";
import { resolveActiveMonitorAgent, updateTaskRepositoryState } from "@/lib/tasks/repository-state";
import {
  isOperationalRepositoryFailure,
  semanticCommitDescriptionWarning,
} from "@/lib/tasks/repository-validation";

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
};
type RebuildResult =
  | { attempted: false; reason: string }
  | { attempted: true; ok: true; target: string; log: string }
  | { attempted: true; ok: false; target: string; error: string; log: string };

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
  opts: { timeout?: number; maxBuffer?: number } = {},
) {
  const { stdout } = await exec(command, args, {
    timeout: opts.timeout ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
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

async function localState(job: BranchVerifyJob, epicMode: boolean): Promise<LocalState> {
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
  let remoteSha = epicMode
    ? null
    : await gitOrNull(commandPath, ["rev-parse", "--verify", `refs/remotes/origin/${job.branchName}`], { timeout: 10_000 });
  let pushed = false;
  let pushError: string | null = null;

  // Standalone recovery push only. A missing remote feature branch makes the
  // initial fetch fail, but a clean local branch is precisely what the monitor
  // is expected to publish. Git still rejects non-fast-forward pushes, so
  // attempting this is fail-safe. Epic children are NEVER pushed (P6): the
  // local ref is the verified artifact and the epic-merge runner consumes it.
  if (!epicMode && !dirtyStatus && !dirtyError && localSha && localSha !== remoteSha) {
    try {
      await git(commandPath, ["push", "origin", `${job.branchName}:${job.branchName}`], { timeout: 90_000, maxBuffer: 1024 * 1024 });
      pushed = true;
      await fetchVerificationBranch(commandPath, job.branchName, job.baseBranch);
      remoteSha = await gitOrNull(commandPath, ["rev-parse", "--verify", `refs/remotes/origin/${job.branchName}`], { timeout: 10_000 });
    } catch (err) {
      pushError = trimError(err, 500);
    }
  }

  return {
    checkPath: checkPath ? real(checkPath) ?? checkPath : null,
    branchWorktreePath: worktreePath ? real(worktreePath) ?? worktreePath : null,
    dirtyStatus: dirtyStatus || null,
    dirtyError,
    localSha,
    remoteSha,
    pushed,
    pushError,
  };
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
}): string {
  const lines = [
    `${args.branchRefLabel} verified by the monitor agent.`,
    "",
    `- HEAD: \`${args.head.sha.slice(0, 10)}\` - ${args.head.subject}`,
    `  - ${authorLabel(args.head)} @ ${args.head.date}`,
  ];
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
      `- Epic-child branch: local-only by design — never pushed. After reviewer acceptance PM merges it into \`${args.baseValidation.baseBranch}\`, removes the child worktree/local branch, and only then marks the task Done.`,
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
  // P6 local-only mode: an Epic child is verified on its LOCAL ref against the
  // Epic integration branch and never pushed, even when the job predates the
  // epicBranch field (epicChild alone forces the no-push rule).
  const epicMode = Boolean(job.epicChild);
  const branchRefLabel = epicMode ? `refs/heads/${job.branchName}` : `origin/${job.branchName}`;
  const project = await db.project.findUnique({
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
    });
    console.log(JSON.stringify({ ok: false, taskId: job.taskId, branch: job.branchName, protectedBranch: true }, null, 2));
    unlinkSync(jobFile);
    return;
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
    // Local-only verification: the base is the Epic integration branch (local
    // ref first, origin fallback) and the verified ref is refs/heads/<branch>.
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
    // A successful recovery push can turn an initial "remote ref not found"
    // into a valid verification state. Resolve/fetch once more before gating.
    if (state.pushed) {
      fetched = await fetchVerificationBranch(job.repositoryPath, job.branchName, job.baseBranch);
    }
    fetchError = fetched.error;
    ({ commits, error: logError } = await readLog(job.repositoryPath, `origin/${fetched.baseBranch}`, `origin/${job.branchName}`));
    baseValidation = await validateOriginBase(job.repositoryPath, job.branchName, fetched.baseBranch);
  }
  const head = commits[0] ?? null;
  const match = job.commitPrefix
    ? commits.find((c) => subjectHasCommitPrefix(c.subject, job.commitPrefix!)) ?? null
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
  const repoVerifiedOk =
    !fetchError &&
    !logError &&
    !state.dirtyStatus &&
    !state.dirtyError &&
    !state.pushError &&
    baseValidation.ok &&
    branchSynced &&
    head !== null &&
    match !== null &&
    !mismatch;

  const rebuild = repoVerifiedOk
    ? await rebuildLiveWorktreeIfNeeded(job, state)
    : null;
  const reviewReady = repoVerifiedOk && (!rebuild?.attempted || rebuild.ok);
  const semanticWarning = reviewReady ? semanticDescriptionWarning(job, head) : null;
  const successfulOutcome = semanticWarning ? "valid_with_warning" as const : "valid" as const;
  const validationOutcome = reviewReady ? successfulOutcome : "invalid" as const;
  const kind = reviewReady
    ? semanticWarning ? "pm.repo.verify.warning" : "pm.repo.verify.ok"
    : "pm.repo.verify.fail";

  const baseBody = reviewReady
    ? renderOkBody({ branchName: job.branchName, branchRefLabel, epicMode, head: head!, match: match!, commitPrefix: job.commitPrefix, expectedIdentity: requiredIdentity, baseValidation, state, rebuild: rebuild! })
    : renderFailBody({ branchName: job.branchName, branchRefLabel, epicMode, head, match, commitPrefix: job.commitPrefix, fetchError, logError, identityMismatch: mismatch, baseValidation, state, rebuild });
  const body = semanticWarning
    ? `${baseBody}\n\n⚠️ Advisory validation warning\n\n${semanticWarning}`
    : baseBody;
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
          pmCreatedCommitSha: commitResult.created ? commitResult.sha : null,
          requestedByAgentSlug: job.requestedByAgentSlug,
        }),
      },
    }),
  ]);
  await updateTaskRepositoryState(job.taskId, {
    phase: reviewReady ? "review_ready" : "action_required",
    candidateSha: head?.sha ?? null,
    validationOutcome,
    lastError: reviewReady ? null : body,
  });
  if (reviewReady) {
    await completeTaskReviewHandoffAfterValidation({
      taskId: job.taskId,
      actor,
      candidateSha: head?.sha ?? null,
      validationOutcome: successfulOutcome,
      validationSummary: semanticWarning ?? baseBody,
    });
  } else {
    await failTaskReviewValidation({
      taskId: job.taskId,
      actor,
      error: body,
      candidateSha: head?.sha ?? null,
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
