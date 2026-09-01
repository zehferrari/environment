import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Deliberately NOT lib/tasks/git-changes.ts. That reader serves the Changes and
// Task tabs, where a 2s timeout, a 1MB buffer and a 30-commit cap are correct —
// those pages want the recent handful, fast. A billing period is a fortnight of
// every branch, which blows through all three, so this is its own reader with
// its own limits rather than a widening that would slow every task page.
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// git's --since/--until filter on COMMITTER date; the report groups and bills on
// AUTHOR date. A rebase, a cherry-pick or a late push moves the two apart, so the
// git-side window is padded and the precise author-date filter is applied here.
// The pad only costs extra lines to parse; it cannot let a wrong commit through.
const AUTHOR_DATE_PAD_DAYS = 180;

// Generated files are excluded from the line counts because the estimate is
// about authored work. A pathspec exclusion also drops a commit that touched
// NOTHING else, which is the intended reading: a lockfile bump is not a day's
// work.
//
// The forms below are load-bearing and were checked against git rather than
// assumed. In a pathspec WITHOUT :(glob) magic, `*` crosses `/`, and a leading
// `**/` does NOT match at the repository root — so `**/pnpm-lock.yaml` silently
// keeps the root lockfile, which is the one every repo actually has. A name
// therefore needs both a bare and a `*/`-prefixed form, and a directory needs
// `dir/*` and `*/dir/*`.
const EXCLUDED_FILE_NAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
];

// `*` crosses `/`, so one suffix pattern covers every depth including the root.
const EXCLUDED_SUFFIXES = ["*.min.js", "*.min.css"];

const EXCLUDED_DIRS = ["node_modules", "vendor", "dist", "build"];

export function defaultExcludePathspecs(): string[] {
  return [
    ...EXCLUDED_FILE_NAMES.flatMap((name) => [name, `*/${name}`]),
    ...EXCLUDED_SUFFIXES,
    ...EXCLUDED_DIRS.flatMap((dir) => [`${dir}/*`, `*/${dir}/*`]),
  ];
}

export type BillingCommit = {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  insertions: number;
  deletions: number;
  filesTouched: number;
};

export type BillingLedgerDay = {
  day: string;
  commitCount: number;
  insertions: number;
  deletions: number;
  filesTouched: number;
  firstCommitAt: string | null;
  lastCommitAt: string | null;
  commits: BillingCommit[];
};

export type BillingLedgerTotals = {
  days: number;
  commits: number;
  insertions: number;
  deletions: number;
  filesTouched: number;
};

export type BillingLedger = {
  days: BillingLedgerDay[];
  totals: BillingLedgerTotals;
  ref: string;
  from: string;
  to: string;
  authorEmails: string[];
  error: string | null;
};

export type BillingLedgerArgs = {
  repositoryPath: string | null | undefined;
  from: string;
  to: string;
  authorEmails?: string[] | null;
  branchName?: string | null;
  excludePaths?: string[] | null;
};

async function git(args: string[], cwd: string) {
  return execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

async function resolveRef(repositoryPath: string, branchName: string) {
  for (const ref of [branchName, `origin/${branchName}`]) {
    try {
      await git(["rev-parse", "--verify", "--quiet", ref], repositoryPath);
      return ref;
    } catch {
      // Try the next candidate. This never fetches.
    }
  }
  return null;
}

// YYYY-MM-DD only. Anything else is a caller bug, and letting it reach git as a
// revision argument would be worse than failing here.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBillingDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value);
}

function shiftDay(day: string, deltaDays: number) {
  const [y, m, d] = day.split("-").map(Number);
  const at = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

export function emptyLedger(args: {
  from: string;
  to: string;
  authorEmails: string[];
  ref: string;
  error: string | null;
}): BillingLedger {
  return {
    days: [],
    totals: { days: 0, commits: 0, insertions: 0, deletions: 0, filesTouched: 0 },
    ref: args.ref,
    from: args.from,
    to: args.to,
    authorEmails: args.authorEmails,
    error: args.error,
  };
}

function normalizeEmails(emails: string[] | null | undefined) {
  return [...new Set((emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

// --author is a regex over "Name <email>", so an unescaped address matches more
// than it should ("a.b@x" would match "axb@x"). Escape it, then re-check the
// parsed email against the requested set so a loose match cannot bill someone
// else's commits to this report.
function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// RS/US rather than NUL: execFile refuses an argument containing a null byte,
// and git's own --format has no escape for one either. Both are control
// characters no commit subject contains in practice.
const REC = "\u001e";
const SEP = "\u001f";

function parseLedgerLog(stdout: string, allowedEmails: Set<string>, from: string, to: string) {
  const byDay = new Map<string, BillingLedgerDay>();
  const seen = new Set<string>();
  let current: BillingCommit | null = null;
  let currentDay: string | null = null;

  const flush = () => {
    const commit = current;
    const dayKey = currentDay;
    current = null;
    currentDay = null;
    if (!commit || !dayKey) return;

    if (dayKey < from || dayKey > to) return;
    if (allowedEmails.size > 0 && !allowedEmails.has(commit.authorEmail.toLowerCase())) return;
    // Every file the commit touched was excluded, so it authored nothing billable.
    if (commit.filesTouched === 0) return;
    // --all walks every ref, so the same commit arrives once per branch holding it.
    if (seen.has(commit.hash)) return;
    seen.add(commit.hash);

    let day = byDay.get(dayKey);
    if (!day) {
      day = {
        day: dayKey,
        commitCount: 0,
        insertions: 0,
        deletions: 0,
        filesTouched: 0,
        firstCommitAt: null,
        lastCommitAt: null,
        commits: [],
      };
      byDay.set(dayKey, day);
    }
    day.commits.push(commit);
    day.commitCount += 1;
    day.insertions += commit.insertions;
    day.deletions += commit.deletions;
    day.filesTouched += commit.filesTouched;
  };

  for (const rawLine of stdout.split("\n")) {
    if (rawLine.startsWith(REC)) {
      flush();
      const fields = rawLine.slice(REC.length).split(SEP);
      if (fields.length < 7) continue;
      const [hash, shortHash, authorName, authorEmail, authoredAt, authoredDay, ...rest] = fields;
      current = {
        hash,
        shortHash,
        authorName,
        authorEmail,
        authoredAt,
        // A subject containing the separator would otherwise be truncated.
        subject: rest.join(SEP),
        insertions: 0,
        deletions: 0,
        filesTouched: 0,
      };
      currentDay = authoredDay;
      continue;
    }
    if (!current) continue;
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    // Binary files report "-" for both counts. They still count as a file.
    const added = parts[0] === "-" ? 0 : Number(parts[0]);
    const removed = parts[1] === "-" ? 0 : Number(parts[1]);
    current.insertions += Number.isFinite(added) ? added : 0;
    current.deletions += Number.isFinite(removed) ? removed : 0;
    current.filesTouched += 1;
  }
  flush();

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const day of days) {
    day.commits.sort((a, b) => a.authoredAt.localeCompare(b.authoredAt));
    day.firstCommitAt = day.commits[0]?.authoredAt ?? null;
    day.lastCommitAt = day.commits[day.commits.length - 1]?.authoredAt ?? null;
  }
  return days;
}

function totalsOf(days: BillingLedgerDay[]): BillingLedgerTotals {
  return days.reduce<BillingLedgerTotals>(
    (acc, day) => ({
      days: acc.days + 1,
      commits: acc.commits + day.commitCount,
      insertions: acc.insertions + day.insertions,
      deletions: acc.deletions + day.deletions,
      filesTouched: acc.filesTouched + day.filesTouched,
    }),
    { days: 0, commits: 0, insertions: 0, deletions: 0, filesTouched: 0 },
  );
}

// The deterministic half of a billing report: what was committed, by whom, on
// which day, and how much of it. No judgement, no estimate — those come from the
// agent, and they are checkable against this.
export async function readBillingLedger(args: BillingLedgerArgs): Promise<BillingLedger> {
  const authorEmails = normalizeEmails(args.authorEmails);
  const base = { from: args.from, to: args.to, authorEmails };

  if (!args.repositoryPath) {
    return emptyLedger({ ...base, ref: "", error: "Project repository path is not set." });
  }
  if (!isBillingDay(args.from) || !isBillingDay(args.to)) {
    return emptyLedger({ ...base, ref: "", error: "Billing period must be two YYYY-MM-DD dates." });
  }
  if (args.from > args.to) {
    return emptyLedger({ ...base, ref: "", error: "Billing period starts after it ends." });
  }

  const requestedBranch = args.branchName?.trim() || null;
  let ref = "--all";
  if (requestedBranch) {
    const resolved = await resolveRef(args.repositoryPath, requestedBranch);
    if (!resolved) {
      return emptyLedger({ ...base, ref: "", error: `No local ref found for ${requestedBranch}.` });
    }
    ref = resolved;
  }

  const excludes = (args.excludePaths ?? defaultExcludePathspecs()).map((glob) => `:(exclude)${glob}`);
  const logArgs = [
    "log",
    "--no-merges",
    "--date=short",
    `--format=${REC}%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%ad${SEP}%s`,
    "--numstat",
    `--since=${shiftDay(args.from, -AUTHOR_DATE_PAD_DAYS)}`,
    `--until=${shiftDay(args.to, AUTHOR_DATE_PAD_DAYS + 1)}`,
    ...authorEmails.map((email) => `--author=${escapeRegex(email)}`),
    ref,
    "--",
    ...excludes,
  ];

  try {
    const { stdout } = await git(logArgs, args.repositoryPath);
    const days = parseLedgerLog(stdout, new Set(authorEmails), args.from, args.to);
    return { days, totals: totalsOf(days), ref, ...base, error: null };
  } catch (error) {
    return emptyLedger({
      ...base,
      ref,
      error: error instanceof Error ? error.message : "Unable to read the repository history.",
    });
  }
}

export type RepoAuthor = {
  name: string;
  email: string;
  commits: number;
};

// Populates the author picker. Scoped to the requested window so the list is the
// people who actually worked in the period, not everyone who ever touched the repo.
export async function listRepoAuthors(args: {
  repositoryPath: string | null | undefined;
  from: string;
  to: string;
  branchName?: string | null;
  excludePaths?: string[] | null;
}): Promise<RepoAuthor[]> {
  if (!args.repositoryPath) return [];
  if (!isBillingDay(args.from) || !isBillingDay(args.to)) return [];

  const requestedBranch = args.branchName?.trim() || null;
  let ref = "--all";
  if (requestedBranch) {
    const resolved = await resolveRef(args.repositoryPath, requestedBranch);
    if (!resolved) return [];
    ref = resolved;
  }

  try {
    const { stdout } = await git(
      [
        "log",
        "--no-merges",
        "--date=short",
        `--format=%an${SEP}%ae${SEP}%ad`,
        `--since=${shiftDay(args.from, -AUTHOR_DATE_PAD_DAYS)}`,
        `--until=${shiftDay(args.to, AUTHOR_DATE_PAD_DAYS + 1)}`,
        ref,
        "--",
        // The same exclusions the ledger uses, so the count beside a name is the
        // number of commits that will actually be billed and not a larger number
        // padded out by lockfile bumps.
        ...(args.excludePaths ?? defaultExcludePathspecs()).map((glob) => `:(exclude)${glob}`),
      ],
      args.repositoryPath,
    );
    const byEmail = new Map<string, RepoAuthor>();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, email, day] = line.split(SEP);
      if (!email || !day) continue;
      if (day < args.from || day > args.to) continue;
      const key = email.toLowerCase();
      const existing = byEmail.get(key);
      if (existing) {
        existing.commits += 1;
        continue;
      }
      byEmail.set(key, { name, email, commits: 1 });
    }
    return [...byEmail.values()].sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email));
  } catch {
    return [];
  }
}
