import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBillingLedger, listRepoAuthors, defaultExcludePathspecs } from "@/lib/billing/git-ledger";

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

// Author and committer dates are set separately so the test can reproduce the
// case the reader exists to handle: a commit rebased long after it was written.
function commit(
  repo: string,
  file: string,
  body: string,
  subject: string,
  authorDate: string,
  author: { name: string; email: string },
  committerDate = authorDate,
) {
  const full = path.join(repo, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", subject], {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: committerDate,
  });
}

const zeh = { name: "Zeh", email: "zeh@example.invalid" };
const other = { name: "Other Dev", email: "other@example.invalid" };

async function main() {
  const repo = mkdtempSync(path.join(tmpdir(), "billing-ledger-"));
  try {
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["config", "user.email", "test@example.invalid"]);

    commit(repo, "a.txt", "one\ntwo\n", "PH-1 first", "2026-08-17T09:00:00+10:00", zeh);
    commit(repo, "a.txt", "one\ntwo\nthree\n", "PH-1 second", "2026-08-17T16:30:00+10:00", zeh);
    commit(repo, "b.txt", "x\n", "PH-2 other author", "2026-08-18T11:00:00+10:00", other);
    commit(repo, "c.txt", "y\n", "PH-3 outside the window", "2026-09-04T11:00:00+10:00", zeh);

    // Authored inside the window but committed months later, which is exactly
    // what a rebase does and what the --since/--until pad exists for.
    commit(
      repo,
      "d.txt",
      "z\n",
      "PH-4 rebased",
      "2026-08-19T10:00:00+10:00",
      zeh,
      "2026-12-01T10:00:00+10:00",
    );

    // Generated files must not inflate the counts, and a commit that touches
    // nothing else must not create a billable day at all. The ROOT lockfile is
    // the case a `**/name` pathspec silently misses, so it is covered first.
    commit(repo, "pnpm-lock.yaml", "lockfile\n".repeat(40), "chore: bump lockfile", "2026-08-20T10:00:00+10:00", zeh);
    commit(repo, "web/pnpm-lock.yaml", "lockfile\n".repeat(40), "chore: nested lockfile", "2026-08-22T10:00:00+10:00", zeh);
    commit(repo, "web/dist/bundle.js", "bundle\n".repeat(40), "chore: build output", "2026-08-23T10:00:00+10:00", zeh);
    commit(repo, "app.min.js", "min\n".repeat(40), "chore: minified asset", "2026-08-24T10:00:00+10:00", zeh);

    const period = { from: "2026-08-16", to: "2026-08-31" };

    // --- author filter ---
    const mine = await readBillingLedger({
      repositoryPath: repo,
      ...period,
      authorEmails: [zeh.email],
    });
    assert.equal(mine.error, null);
    assert.deepEqual(mine.days.map((day) => day.day), ["2026-08-17", "2026-08-19"]);

    const first = mine.days[0];
    assert.equal(first.commitCount, 2);
    assert.equal(first.firstCommitAt?.slice(11, 16), "09:00");
    assert.equal(first.lastCommitAt?.slice(11, 16), "16:30");
    assert.deepEqual(first.commits.map((c) => c.subject), ["PH-1 first", "PH-1 second"]);
    // +2 for the initial file, +1 for the added line.
    assert.equal(first.insertions, 3);

    // The rebased commit is grouped on the day it was AUTHORED, not committed.
    assert.equal(mine.days[1].commits[0].subject, "PH-4 rebased");

    // None of the generated-file commits created a billable day.
    for (const [day, what] of [
      ["2026-08-20", "root lockfile"],
      ["2026-08-22", "nested lockfile"],
      ["2026-08-23", "build output"],
      ["2026-08-24", "minified asset"],
    ] as const) {
      assert.ok(!mine.days.some((entry) => entry.day === day), `${what} must not bill a day`);
    }

    // A file that merely looks like an excluded one is still real work.
    commit(repo, "notpnpm-lock.yaml", "real\n", "PH-6 not a lockfile", "2026-08-25T10:00:00+10:00", zeh);
    const lookalike = await readBillingLedger({
      repositoryPath: repo,
      ...period,
      authorEmails: [zeh.email],
    });
    assert.ok(
      lookalike.days.some((entry) => entry.day === "2026-08-25"),
      "a lookalike filename must not be excluded",
    );

    // The pathspec forms themselves, because the root case is easy to get wrong.
    const specs = defaultExcludePathspecs();
    assert.ok(specs.includes("pnpm-lock.yaml"), "a bare name covers the repository root");
    assert.ok(specs.includes("*/pnpm-lock.yaml"), "a */ form covers every subdirectory");
    assert.ok(specs.includes("dist/*") && specs.includes("*/dist/*"));
    assert.ok(!specs.some((spec) => spec.startsWith("**/")), "**/ does not match at the root");

    // The September commit is outside the window.
    assert.ok(!mine.days.some((day) => day.day === "2026-09-04"));

    // --- everyone (includes the other author's day and the lookalike file) ---
    const everyone = await readBillingLedger({ repositoryPath: repo, ...period, authorEmails: [] });
    assert.deepEqual(
      everyone.days.map((day) => day.day),
      ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-25"],
    );
    assert.equal(everyone.totals.days, 4);
    assert.equal(everyone.totals.commits, 5);

    // --- an author who committed nothing yields an empty ledger, not everyone ---
    const nobody = await readBillingLedger({
      repositoryPath: repo,
      ...period,
      authorEmails: ["ghost@example.invalid"],
    });
    assert.equal(nobody.error, null);
    assert.equal(nobody.days.length, 0);

    // --- branch scoping ---
    git(repo, ["checkout", "-b", "feature"]);
    commit(repo, "e.txt", "feature\n", "PH-5 on feature", "2026-08-21T10:00:00+10:00", zeh);
    git(repo, ["checkout", "main"]);

    const allRefs = await readBillingLedger({ repositoryPath: repo, ...period, authorEmails: [zeh.email] });
    assert.ok(allRefs.days.some((day) => day.day === "2026-08-21"), "--all must see other branches");

    const mainOnly = await readBillingLedger({
      repositoryPath: repo,
      ...period,
      authorEmails: [zeh.email],
      branchName: "main",
    });
    assert.ok(!mainOnly.days.some((day) => day.day === "2026-08-21"), "a branch filter must scope");
    assert.equal(mainOnly.ref, "main");

    const missingRef = await readBillingLedger({
      repositoryPath: repo,
      ...period,
      branchName: "no-such-branch",
    });
    assert.match(missingRef.error ?? "", /No local ref/);

    // --- guards ---
    assert.match(
      (await readBillingLedger({ repositoryPath: null, ...period })).error ?? "",
      /repository path/i,
    );
    assert.match(
      (await readBillingLedger({ repositoryPath: repo, from: "nope", to: "2026-08-31" })).error ?? "",
      /YYYY-MM-DD/,
    );
    assert.match(
      (await readBillingLedger({ repositoryPath: repo, from: "2026-08-31", to: "2026-08-16" })).error ?? "",
      /starts after/,
    );

    // --- authors are scoped to the window and counted ---
    const authors = await listRepoAuthors({ repositoryPath: repo, ...period });
    const emails = authors.map((author) => author.email).sort();
    assert.deepEqual(emails, [other.email, zeh.email].sort());
    // Two on the 17th, the rebased 19th, the lookalike 25th, and the feature
    // branch 21st — the generated-file commits are excluded here too, so the
    // count beside a name matches what the report will bill.
    assert.equal(authors.find((author) => author.email === zeh.email)?.commits, 5);

    console.log("billing-git-ledger-test ok");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
