// pm-verify-branch-pushed — monitor-side branch verifier.
//
// Consumes ONE spool job dropped by app/api/agent/tasks/[taskId]/workflow when
// an assignee moves a code-touching task to Review. Runs as the monitor agent
// via pm-verify-runner.service and uses the already-cloned local repo as the
// source of truth: a `git fetch origin <branchName>` + a `git log
// origin/<branchName>` to (a) confirm the branch was pushed and (b) confirm
// at least one recent commit subject starts with the resolved COMMIT_PREFIX.
//
// Writes a single Comment + a pm.repo.verify.{ok,fail} ActivityLog row, then
// deletes the job file. Bitbucket REST is NOT called in this pass — the local
// remote IS Bitbucket, and `git fetch` reuses whatever credentials are already
// configured on the local clone.
//
// Invoked as: pnpm exec tsx scripts/pm-verify-branch-pushed.ts <job-file>

import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import { BRANCH_VERIFY_DIR, type BranchVerifyJob } from "@/lib/deploy/branch-verify";

const exec = promisify(execFile);

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

async function fetchBranch(repo: string, branch: string): Promise<string | null> {
  try {
    await exec("git", ["-C", repo, "fetch", "--quiet", "origin", branch], { timeout: 60_000 });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.trim().slice(0, 400);
  }
}

async function readLog(repo: string, branch: string): Promise<{ commits: GitCommit[]; error: string | null }> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repo, "log", `origin/${branch}`, "--format=%H|%an|%ae|%cn|%ce|%aI|%s", "-n", "20"],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return { commits: parseLog(stdout), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { commits: [], error: msg.trim().slice(0, 400) };
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

function renderOkBody(args: {
  branchName: string;
  head: GitCommit;
  match: GitCommit;
  commitPrefix: string | null;
  expectedIdentity: ExpectedIdentity | null;
}): string {
  const lines = [
    `✓ origin/${args.branchName} verified by the monitor agent.`,
    "",
    `- HEAD: \`${args.head.sha.slice(0, 10)}\` — ${args.head.subject}`,
    `  - ${authorLabel(args.head)} @ ${args.head.date}`,
  ];
  if (args.commitPrefix) {
    if (args.match.sha !== args.head.sha) {
      lines.push(
        `- Latest \`${args.commitPrefix}\`-prefixed commit: \`${args.match.sha.slice(0, 10)}\` — ${args.match.subject}`,
        `  - ${authorLabel(args.match)} @ ${args.match.date}`,
      );
    } else {
      lines.push(`- HEAD subject starts with \`${args.commitPrefix}\`.`);
    }
  } else {
    lines.push("- No COMMIT_PREFIX configured on task/epic; HEAD treated as the verified state.");
  }
  if (args.expectedIdentity) {
    lines.push(`- Git identity verified: ${args.expectedIdentity.name} <${args.expectedIdentity.email}>.`);
  }
  return lines.join("\n");
}

function renderFailBody(args: {
  branchName: string;
  head: GitCommit | null;
  match: GitCommit | null;
  commitPrefix: string | null;
  fetchError: string | null;
  logError: string | null;
  identityMismatch: IdentityMismatch | null;
}): string {
  const fetchAuthError = Boolean(
    args.fetchError && /(?:unauthorized|permission denied|could not read from remote|access rights|repository not found)/i.test(args.fetchError),
  );
  const lines = [`⚠ origin/${args.branchName} not verified.`, ""];
  if (args.fetchError) lines.push(`- \`git fetch origin ${args.branchName}\` failed: \`${args.fetchError}\``);
  if (args.logError) lines.push(`- \`git log\` failed: \`${args.logError}\``);
  if (!args.head) {
    lines.push(`- No commits found on \`origin/${args.branchName}\`. Was the branch pushed?`);
  } else {
    lines.push(`- HEAD on origin/${args.branchName}: \`${args.head.sha.slice(0, 10)}\` — ${args.head.subject}  (${authorLabel(args.head)} @ ${args.head.date})`);
    if (args.commitPrefix) {
      if (args.match) {
        lines.push(`- Latest \`${args.commitPrefix}\`-prefixed commit visible locally: \`${args.match.sha.slice(0, 10)}\` — ${args.match.subject}`);
      } else {
        lines.push(
          `- None of the last 20 commits on \`origin/${args.branchName}\` start with \`${args.commitPrefix}\`. Did the assignee push with the right prefix?`,
        );
      }
    }
  }
  if (args.identityMismatch) {
    lines.push(
      `- Git identity mismatch on the verified commit. Expected ${args.identityMismatch.expected.name} <${args.identityMismatch.expected.email}>.`,
      `  - Author: ${args.identityMismatch.author}`,
      `  - Committer: ${args.identityMismatch.committer}`,
    );
  }
  lines.push("");
  if (fetchAuthError) {
    lines.push(
      "This is a monitor verifier repository-access problem, not proof that the assignee failed to push.",
      "Fix the monitor verifier's git credentials for this repository, then re-trigger `ready_for_review` to refresh this check.",
    );
  } else {
    lines.push(
      args.identityMismatch
        ? "Assignee: fix the branch so the matching commit author and committer use the required project identity, then force-push with lease and re-trigger `ready_for_review`."
        : `Assignee: commit any local changes with \`${args.commitPrefix ?? "<COMMIT_PREFIX not set>"}\` at the START of every commit message, then \`git push origin ${args.branchName}\`. Once the push lands, re-trigger \`ready_for_review\` to refresh this check.`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) throw new Error("Usage: pm-verify-branch-pushed <job.json>");
  if (!existsSync(jobFile)) throw new Error(`Job file not found: ${jobFile}`);
  if (!jobFile.startsWith(BRANCH_VERIFY_DIR)) {
    throw new Error(`Refusing to read job file outside ${BRANCH_VERIFY_DIR}`);
  }

  const job = JSON.parse(readFileSync(jobFile, "utf8")) as BranchVerifyJob;

  const fetchError = await fetchBranch(job.repositoryPath, job.branchName);
  const { commits, error: logError } = await readLog(job.repositoryPath, job.branchName);
  const head = commits[0] ?? null;
  const match = job.commitPrefix
    ? commits.find((c) => c.subject.startsWith(job.commitPrefix!)) ?? null
    : head;
  const requiredIdentity = expectedIdentity(job);
  const mismatch = identityMismatch(match, requiredIdentity);

  const verifiedOk = !fetchError && !logError && head !== null && match !== null && !mismatch;
  const kind = verifiedOk ? "pm.repo.verify.ok" : "pm.repo.verify.fail";

  const body = verifiedOk
    ? renderOkBody({ branchName: job.branchName, head: head!, match: match!, commitPrefix: job.commitPrefix, expectedIdentity: requiredIdentity })
    : renderFailBody({ branchName: job.branchName, head, match, commitPrefix: job.commitPrefix, fetchError, logError, identityMismatch: mismatch });

  const monitorUsername = process.env.PM_MONITOR_USER ?? process.env.USER ?? "monitor";
  const monitor = await db.user.findFirst({
    where: { username: monitorUsername, status: "active" },
    select: { id: true },
  });
  if (!monitor) throw new Error(`monitor user ${monitorUsername} not found — cannot post verifier comment`);

  await db.$transaction([
    db.comment.create({
      data: { taskId: job.taskId, userId: monitor.id, body },
    }),
    db.activityLog.create({
      data: {
        projectId: job.projectId,
        taskId: job.taskId,
        userId: monitor.id,
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
          fetchError,
          logError,
          requestedByAgentSlug: job.requestedByAgentSlug,
        }),
      },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: verifiedOk,
        taskId: job.taskId,
        branch: job.branchName,
        headSha: head?.sha ?? null,
        matchSha: match?.sha ?? null,
        identityMismatch: mismatch,
        fetchError,
        logError,
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
