// pm-verify-branch-pushed — monitor-side branch verifier.
//
// Consumes ONE spool job dropped when an assignee moves a code-touching task to
// Review. The monitor verifies the task branch before any reviewer is woken:
//   1. resolve the branch's local worktree when available;
//   2. fail if that worktree still has uncommitted changes;
//   3. push clean local branch commits that have not reached origin yet;
//   4. verify origin/main is an ancestor of origin/<branch>;
//   5. verify origin/<branch> contains the task prefix with the right identity;
//   6. if this branch is the currently served PM worktree, rebuild/restart it;
//   7. wake the reviewer only after the gate passes, otherwise wake the assignee.
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
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { BRANCH_VERIFY_DIR, type BranchVerifyJob } from "@/lib/deploy/branch-verify";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { isProtectedBranch, parseProtectedBranches } from "@/lib/projects/protected-branches";

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
type BranchBaseValidation = {
  ok: boolean;
  originMainSha: string | null;
  branchSha: string | null;
  mergeBaseSha: string | null;
  error: string | null;
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

async function fetchBranch(repo: string, branch: string): Promise<string | null> {
  try {
    const refs = branch === "main" ? ["main"] : ["main", branch];
    await git(repo, ["fetch", "--quiet", "origin", ...refs], { timeout: 60_000 });
    return null;
  } catch (err) {
    return trimError(err, 400);
  }
}

async function validateOriginMainBase(repo: string, branch: string): Promise<BranchBaseValidation> {
  const originMainSha = await gitOrNull(repo, ["rev-parse", "--verify", "refs/remotes/origin/main"], { timeout: 10_000 });
  const branchRef = `origin/${branch}`;
  const branchSha = await gitOrNull(repo, ["rev-parse", "--verify", `refs/remotes/${branchRef}`], { timeout: 10_000 });

  if (!originMainSha) {
    return {
      ok: false,
      originMainSha: null,
      branchSha,
      mergeBaseSha: null,
      error: "origin/main is unavailable after the monitor fetch",
    };
  }
  if (!branchSha) {
    return {
      ok: false,
      originMainSha,
      branchSha: null,
      mergeBaseSha: null,
      error: `${branchRef} is unavailable after the monitor fetch`,
    };
  }

  const mergeBaseSha = await gitOrNull(repo, ["merge-base", "origin/main", branchRef], { timeout: 10_000 });
  if (mergeBaseSha !== originMainSha) {
    return {
      ok: false,
      originMainSha,
      branchSha,
      mergeBaseSha,
      error: `${branchRef} does not contain the current origin/main; recreate or update the branch from origin/main before review`,
    };
  }

  return { ok: true, originMainSha, branchSha, mergeBaseSha, error: null };
}

async function readLog(repo: string, branch: string): Promise<{ commits: GitCommit[]; error: string | null }> {
  try {
    const stdout = await git(
      repo,
      ["log", `origin/${branch}`, "--format=%H|%an|%ae|%cn|%ce|%aI|%s", "-n", "20"],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
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

async function localState(job: BranchVerifyJob, fetchError: string | null): Promise<LocalState> {
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
  let remoteSha = await gitOrNull(commandPath, ["rev-parse", "--verify", `refs/remotes/origin/${job.branchName}`], { timeout: 10_000 });
  let pushed = false;
  let pushError: string | null = null;

  if (!fetchError && !dirtyStatus && !dirtyError && localSha && localSha !== remoteSha) {
    try {
      await git(commandPath, ["push", "origin", `${job.branchName}:${job.branchName}`], { timeout: 90_000, maxBuffer: 1024 * 1024 });
      pushed = true;
      await fetchBranch(commandPath, job.branchName);
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
  head: GitCommit;
  match: GitCommit;
  commitPrefix: string | null;
  expectedIdentity: ExpectedIdentity | null;
  baseValidation: BranchBaseValidation;
  state: LocalState;
  rebuild: RebuildResult;
}): string {
  const lines = [
    `origin/${args.branchName} verified by the monitor agent.`,
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
  lines.push(
    `- Base verified: origin/main \`${args.baseValidation.originMainSha?.slice(0, 10)}\` is an ancestor of \`origin/${args.branchName}\`.`,
  );
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

function renderProtectedBranchBody(args: { branchName: string; protectedBranches: string[] }) {
  return [
    `origin/${args.branchName} is blocked from reviewer hand-off.`,
    "",
    `- Branch \`${args.branchName}\` is configured as a protected agent branch for this project.`,
    args.protectedBranches.length > 0 ? `- Protected branches: ${args.protectedBranches.map((branch) => `\`${branch}\``).join(", ")}.` : null,
    "",
    "Assignee: resume the task, move code-changing work to an allowed task branch, push it, then call `ready_for_review` again.",
  ].filter(Boolean).join("\n");
}

function renderFailBody(args: {
  branchName: string;
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
  const lines = [`origin/${args.branchName} is not ready for reviewer hand-off.`, ""];
  if (args.state.dirtyError) lines.push(`- Local worktree status check failed: \`${args.state.dirtyError}\``);
  if (args.state.dirtyStatus) {
    lines.push(
      `- Local worktree still has uncommitted changes at \`${args.state.checkPath ?? "unknown"}\`:`,
      "```",
      args.state.dirtyStatus.slice(0, 2000),
      "```",
    );
  }
  if (args.fetchError) lines.push(`- Fetching origin/main and origin/${args.branchName} failed: ${args.fetchError}`);
  if (args.state.pushError) lines.push(`- Monitor could not push \`${args.branchName}\` to origin: \`${args.state.pushError}\``);
  if (args.logError) lines.push(`- \`git log\` failed: \`${args.logError}\``);
  if (args.state.localSha && args.state.remoteSha && args.state.localSha !== args.state.remoteSha) {
    lines.push(
      `- Local branch head \`${args.state.localSha.slice(0, 10)}\` does not match origin head \`${args.state.remoteSha.slice(0, 10)}\`.`,
    );
  }
  if (!args.head) {
    lines.push(`- No commits found on \`origin/${args.branchName}\`. Was the branch pushed?`);
  } else {
    lines.push(`- HEAD on origin/${args.branchName}: \`${args.head.sha.slice(0, 10)}\` - ${args.head.subject} (${authorLabel(args.head)} @ ${args.head.date})`);
    if (args.commitPrefix) {
      if (args.match) {
        lines.push(`- Latest \`${args.commitPrefix}\`-prefixed commit visible locally: \`${args.match.sha.slice(0, 10)}\` - ${args.match.subject}`);
      } else {
        lines.push(
          `- None of the last 20 commits on \`origin/${args.branchName}\` start with \`${args.commitPrefix}\`.`,
        );
      }
    }
  }
  if (!args.baseValidation.ok) {
    lines.push(
      `- Branch-base validation failed: ${args.baseValidation.error}.`,
      `  - origin/main: ${args.baseValidation.originMainSha?.slice(0, 10) ?? "unavailable"}`,
      `  - origin/${args.branchName}: ${args.baseValidation.branchSha?.slice(0, 10) ?? "unavailable"}`,
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
      "This includes a monitor repository-access problem. Fix the monitor/verifier Git credentials, or have the assignee push with the required commit prefix, then re-trigger `ready_for_review`.",
    );
  } else if (args.rebuild?.attempted && !args.rebuild.ok) {
    lines.push("Fix the live PM rebuild/restart failure, then re-trigger `ready_for_review` so the reviewer is woken only after the live build is healthy.");
  } else {
    lines.push(
      `Assignee: resume the task, commit any local changes with \`${args.commitPrefix ?? "<COMMIT_PREFIX not set>"}\` at the start of every commit message, push \`origin/${args.branchName}\`, then call \`ready_for_review\` again.`,
    );
  }
  return lines.join("\n");
}

async function monitorActor() {
  const monitorUsername = process.env.PM_MONITOR_USER ?? process.env.USER ?? "monitor";
  const monitor = await db.user.findFirst({
    where: { username: monitorUsername, status: "active" },
    select: { id: true, username: true, kind: true },
  });
  if (!monitor) throw new Error(`monitor user ${monitorUsername} not found - cannot post verifier comment`);
  return {
    id: monitor.id,
    username: monitor.username,
    kind: monitor.kind === "agent" ? "agent" as const : "human" as const,
  };
}

async function notifyAfterGate(args: {
  job: BranchVerifyJob;
  actor: Awaited<ReturnType<typeof monitorActor>>;
  verifiedOk: boolean;
  reviewReady: boolean;
  summary: string;
  monitorAccessProblem: boolean;
}) {
  const task = await db.task.findUnique({
    where: { id: args.job.taskId },
    select: {
      id: true,
      title: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!task) return;

  if (args.reviewReady) {
    const reviewerId = resolveReviewOwnerId(task);
    if (!reviewerId) return;
    await sendTaskWorkflowNotification({
      taskId: args.job.taskId,
      targetUserId: reviewerId,
      actor: args.actor,
      reason: "review_requested",
      body: [
        `Monitor validation passed for "${task.title}".`,
        args.summary,
        "You may now review the completed work. If satisfied, use action=review_done. If changes or blockers remain, use action=review_feedback with one concise comment.",
      ].join("\n"),
    });
    return;
  }

  if (!task.assigneeId || args.monitorAccessProblem) return;
  await sendTaskWorkflowNotification({
    taskId: args.job.taskId,
    targetUserId: task.assigneeId,
    actor: args.actor,
    reason: "review_feedback",
    body: [
      `Monitor validation did not pass for "${task.title}".`,
      args.summary,
      "Resume the task with action=start, fix the branch/commits, push the branch, then call action=ready_for_review again. Do not leave repository changes uncommitted.",
    ].join("\n"),
  });
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error("Usage: pm-verify-branch-pushed <job.json>");
  if (!existsSync(jobFile)) throw new Error(`Job file not found: ${jobFile}`);
  if (!jobFile.startsWith(BRANCH_VERIFY_DIR)) {
    throw new Error(`Refusing to read job file outside ${BRANCH_VERIFY_DIR}`);
  }

  const job = JSON.parse(readFileSync(jobFile, "utf8")) as BranchVerifyJob;
  const project = await db.project.findUnique({
    where: { id: job.projectId },
    select: { agentChangeBlockedBranches: true },
  });
  if (project && isProtectedBranch(project.agentChangeBlockedBranches, job.branchName)) {
    const protectedBranches = parseProtectedBranches(project.agentChangeBlockedBranches);
    const body = renderProtectedBranchBody({ branchName: job.branchName, protectedBranches });
    const actor = await monitorActor();
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
    await notifyAfterGate({
      job,
      actor,
      verifiedOk: false,
      reviewReady: false,
      summary: body,
      monitorAccessProblem: false,
    });
    console.log(JSON.stringify({ ok: false, taskId: job.taskId, branch: job.branchName, protectedBranch: true }, null, 2));
    unlinkSync(jobFile);
    return;
  }

  const fetchError = await fetchBranch(job.repositoryPath, job.branchName);
  const state = await localState(job, fetchError);
  const { commits, error: logError } = await readLog(job.repositoryPath, job.branchName);
  const baseValidation = await validateOriginMainBase(job.repositoryPath, job.branchName);
  const head = commits[0] ?? null;
  const match = job.commitPrefix
    ? commits.find((c) => c.subject.startsWith(job.commitPrefix!)) ?? null
    : head;
  const requiredIdentity = expectedIdentity(job);
  const mismatch = identityMismatch(match, requiredIdentity);

  const branchSynced = !state.localSha || !state.remoteSha || state.localSha === state.remoteSha;
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
  const kind = reviewReady ? "pm.repo.verify.ok" : "pm.repo.verify.fail";

  const body = reviewReady
    ? renderOkBody({ branchName: job.branchName, head: head!, match: match!, commitPrefix: job.commitPrefix, expectedIdentity: requiredIdentity, baseValidation, state, rebuild: rebuild! })
    : renderFailBody({ branchName: job.branchName, head, match, commitPrefix: job.commitPrefix, fetchError, logError, identityMismatch: mismatch, baseValidation, state, rebuild });

  const actor = await monitorActor();
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
          requestedByAgentSlug: job.requestedByAgentSlug,
        }),
      },
    }),
  ]);

  const monitorAccessProblem = authLikeError(fetchError);
  await notifyAfterGate({
    job,
    actor,
    verifiedOk: repoVerifiedOk,
    reviewReady,
    summary: body,
    monitorAccessProblem,
  });

  console.log(
    JSON.stringify(
      {
        ok: reviewReady,
        repoVerifiedOk,
        taskId: job.taskId,
        branch: job.branchName,
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
