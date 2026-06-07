import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TaskGitFileChange = {
  status: string;
  path: string;
};

export type TaskGitCommit = {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  files: TaskGitFileChange[];
};

export type TaskGitChangesResult = {
  commits: TaskGitCommit[];
  ref: string | null;
  error: string | null;
};

export type TaskGitChangesWindow = {
  since: Date | string;
  until?: Date | string | null;
};

export type TaskGitDiffLine = {
  kind: "hunk" | "context" | "change";
  leftNo: number | null;
  rightNo: number | null;
  leftText: string;
  rightText: string;
  leftType: "context" | "remove" | "empty";
  rightType: "context" | "add" | "empty";
};

export type TaskGitFileDiffResult = {
  commitHash: string;
  filePath: string;
  lines: TaskGitDiffLine[];
  error: string | null;
};

async function git(args: string[], cwd: string) {
  return execFileAsync("git", args, {
    cwd,
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
}

async function resolveRef(repositoryPath: string, branchName: string) {
  const candidates = [`origin/${branchName}`, branchName];
  for (const ref of candidates) {
    try {
      await git(["rev-parse", "--verify", "--quiet", ref], repositoryPath);
      return ref;
    } catch {
      // Try the next local ref. This intentionally never fetches.
    }
  }
  return null;
}

function parseLog(stdout: string) {
  const commits: TaskGitCommit[] = [];
  let current: TaskGitCommit | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\x1f");
    if (fields.length === 6) {
      if (current) commits.push(current);
      const [hash, shortHash, authorName, authorEmail, authoredAt, subject] = fields;
      current = {
        hash,
        shortHash,
        authorName,
        authorEmail,
        authoredAt,
        subject,
        files: [],
      };
      continue;
    }

    if (!current) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    current.files.push({
      status: line.slice(0, tab),
      path: line.slice(tab + 1),
    });
  }

  if (current) commits.push(current);
  return commits;
}

function parseMs(value: Date | string | null | undefined) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function normalizeWindows(windows: TaskGitChangesWindow[] | null | undefined) {
  return (windows ?? []).flatMap((window) => {
    const since = parseMs(window.since);
    if (since === null) return [];
    const until = window.until === null || window.until === undefined
      ? Number.POSITIVE_INFINITY
      : parseMs(window.until);
    if (until === null) return [];
    return [{ since, until }] as const;
  });
}

function normalizePrefixes(commitPrefix: string | string[] | null | undefined) {
  const values = Array.isArray(commitPrefix) ? commitPrefix : [commitPrefix];
  return [...new Set(values.flatMap((value) => {
    const prefix = value?.trim().toLowerCase();
    return prefix ? [prefix] : [];
  }))];
}

function subjectStartsWithPrefix(subject: string, prefix: string) {
  if (!subject.startsWith(prefix)) return false;
  const next = subject.charAt(prefix.length);
  return !next || /[^a-z0-9]/i.test(next);
}

function filterCommits(
  commits: TaskGitCommit[],
  commitPrefix: string | string[] | null,
  windows: TaskGitChangesWindow[] | null | undefined,
) {
  const normalizedPrefixes = normalizePrefixes(commitPrefix);
  const normalizedWindows = normalizeWindows(windows);
  const filtered = commits.filter((commit) => {
    const subject = commit.subject.toLowerCase();
    if (
      normalizedPrefixes.length > 0 &&
      !normalizedPrefixes.some((prefix) => subjectStartsWithPrefix(subject, prefix))
    ) {
      return false;
    }
    if (normalizedWindows.length === 0) return true;
    const authoredAt = parseMs(commit.authoredAt);
    if (authoredAt === null) return false;
    return normalizedWindows.some((window) => (
      authoredAt >= window.since && authoredAt <= window.until
    ));
  });

  return filtered.slice(0, 30);
}

function parseUnifiedDiff(stdout: string, commitHash: string, filePath: string): TaskGitFileDiffResult {
  const lines: TaskGitDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let removals: Array<{ no: number; text: string }> = [];
  let additions: Array<{ no: number; text: string }> = [];

  const flushChanges = () => {
    const count = Math.max(removals.length, additions.length);
    for (let i = 0; i < count; i += 1) {
      const left = removals[i] ?? null;
      const right = additions[i] ?? null;
      lines.push({
        kind: "change",
        leftNo: left?.no ?? null,
        rightNo: right?.no ?? null,
        leftText: left?.text ?? "",
        rightText: right?.text ?? "",
        leftType: left ? "remove" : "empty",
        rightType: right ? "add" : "empty",
      });
    }
    removals = [];
    additions = [];
  };

  for (const rawLine of stdout.split("\n")) {
    if (rawLine.startsWith("@@ ")) {
      flushChanges();
      const match = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldLine = match ? Number(match[1]) : oldLine;
      newLine = match ? Number(match[2]) : newLine;
      inHunk = true;
      lines.push({
        kind: "hunk",
        leftNo: null,
        rightNo: null,
        leftText: rawLine,
        rightText: rawLine,
        leftType: "empty",
        rightType: "empty",
      });
      continue;
    }
    if (!inHunk) continue;
    if (rawLine.startsWith("\\ No newline")) continue;

    const marker = rawLine.slice(0, 1);
    const text = rawLine.slice(1);
    if (marker === "-") {
      removals.push({ no: oldLine, text });
      oldLine += 1;
      continue;
    }
    if (marker === "+") {
      additions.push({ no: newLine, text });
      newLine += 1;
      continue;
    }

    flushChanges();
    if (marker === " ") {
      lines.push({
        kind: "context",
        leftNo: oldLine,
        rightNo: newLine,
        leftText: text,
        rightText: text,
        leftType: "context",
        rightType: "context",
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  flushChanges();
  return { commitHash, filePath, lines, error: null };
}

export async function getTaskGitChanges(args: {
  repositoryPath: string | null | undefined;
  branchName: string | null | undefined;
  commitPrefix: string | string[] | null | undefined;
  windows?: TaskGitChangesWindow[] | null | undefined;
}): Promise<TaskGitChangesResult> {
  if (!args.repositoryPath) {
    return { commits: [], ref: null, error: "Project repository path is not set." };
  }
  if (!args.branchName) {
    return { commits: [], ref: null, error: "Task branch is not set." };
  }

  const ref = await resolveRef(args.repositoryPath, args.branchName);
  if (!ref) {
    return {
      commits: [],
      ref: null,
      error: `No local ref found for ${args.branchName}.`,
    };
  }

  try {
    const { stdout } = await git([
      "log",
      "--max-count=80",
      "--date=iso-strict",
      "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
      "--name-status",
      ref,
      "--",
    ], args.repositoryPath);
    return {
      commits: filterCommits(parseLog(stdout), args.commitPrefix ?? null, args.windows),
      ref,
      error: null,
    };
  } catch (error) {
    return {
      commits: [],
      ref,
      error: error instanceof Error ? error.message : "Unable to read Git changes.",
    };
  }
}

export async function getTaskGitFileDiff(args: {
  repositoryPath: string | null | undefined;
  commitHash: string | null | undefined;
  filePath: string | null | undefined;
}): Promise<TaskGitFileDiffResult | null> {
  const commitHash = args.commitHash?.trim() ?? "";
  const filePath = args.filePath?.trim() ?? "";
  if (!commitHash || !filePath) return null;
  if (!args.repositoryPath) {
    return { commitHash, filePath, lines: [], error: "Project repository path is not set." };
  }
  if (!/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    return { commitHash, filePath, lines: [], error: "Invalid commit hash." };
  }

  try {
    const { stdout } = await git([
      "show",
      "--format=",
      "--no-ext-diff",
      "--find-renames",
      "--find-copies",
      "--unified=80",
      commitHash,
      "--",
      filePath,
    ], args.repositoryPath);
    return parseUnifiedDiff(stdout, commitHash, filePath);
  } catch (error) {
    return {
      commitHash,
      filePath,
      lines: [],
      error: error instanceof Error ? error.message : "Unable to read file diff.",
    };
  }
}
