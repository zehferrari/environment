import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  completionReviewReportCanApprove,
  parseCompletionReviewReport,
  renderCompletionReviewReport,
} from "@/lib/epics/completion-review";
import { db } from "@/lib/db";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";

async function databaseSlice() {
  const reviewer = await db.user.create({
    data: {
      username: "epic-reviewer",
      email: "epic-reviewer@example.test",
      kind: "human",
      status: "active",
      isOwner: true,
    },
  });
  const project = await db.project.create({
    data: { slug: "acceptance-test", name: "Acceptance Test" },
  });
  const epic = await db.epic.create({
    data: {
      projectId: project.id,
      title: "Combined delivery",
      status: "In Progress",
      actingManagerId: reviewer.id,
      reporterId: reviewer.id,
    },
  });
  const task = await db.task.create({
    data: {
      projectId: project.id,
      epicId: epic.id,
      title: "Final child",
      status: "Review",
      actingManagerId: reviewer.id,
      reporterId: reviewer.id,
    },
  });

  const completion = await completeReviewedTaskAndAssignNext({
    taskId: task.id,
    actor: { id: reviewer.id, username: reviewer.username, kind: "human" },
    via: "epic-completion-review-test",
  });
  assert.equal(completion.completed, true);
  const [storedEpic, storedTask] = await Promise.all([
    db.epic.findUniqueOrThrow({ where: { id: epic.id } }),
    db.task.findUniqueOrThrow({ where: { id: task.id } }),
  ]);
  assert.equal(storedTask.status, "Done", "the accepted child must complete");
  assert.equal(storedEpic.status, "Review", "the final child must not complete the Epic");
  assert.equal(storedEpic.completionReviewStatus, "Preparing");
  assert.equal(storedEpic.completionReviewCandidateSha, null);

  const spoolDir = process.env.PM_EPIC_MERGE_DIR!;
  const reviewJob = join(spoolDir, `review-${epic.id}.json`);
  assert.equal(existsSync(reviewJob), true, "candidate preparation must be durably enqueued");
  assert.equal(JSON.parse(readFileSync(reviewJob, "utf8")).kind, "review");
  assert.equal(existsSync(join(spoolDir, `cleanup-${epic.id}.json`)), false, "cleanup must remain locked before acceptance");
  await db.$disconnect();
  console.log("epic-completion-review database slice passed");
}

async function main() {
  if (process.env.EPIC_COMPLETION_REVIEW_DB_SLICE === "1") {
    await databaseSlice();
    return;
  }

const approved = parseCompletionReviewReport({
  summary: "The combined candidate satisfies the Epic.",
  requirements: [
    { requirement: "Original request A", status: "Pass", evidence: "Implemented at candidate abc and exercised end to end." },
    { requirement: "Original request B", status: "Pass", evidence: "Targeted and regression evidence agree." },
  ],
  tests: [
    { command: "pnpm test", status: "Pass", evidence: "All 42 tests passed at frozen SHA abc." },
  ],
  residualRisks: "None identified.",
});
assert(approved, "a complete structured report must parse");
assert.equal(completionReviewReportCanApprove(approved), true, "all-Pass evidence may request approval");
assert.match(renderCompletionReviewReport(approved, "APPROVED"), /Requirement matrix/);

const partial = parseCompletionReviewReport({
  ...approved,
  requirements: [
    { requirement: "Original request A", status: "Partial", evidence: "Browser evidence is missing." },
  ],
});
assert(partial);
assert.equal(completionReviewReportCanApprove(partial), false, "a Partial requirement must block approval");

const failedTest = parseCompletionReviewReport({
  ...approved,
  tests: [{ command: "qa/run.sh", status: "Fail", evidence: "Fatal assertion helper error." }],
});
assert(failedTest);
assert.equal(completionReviewReportCanApprove(failedTest), false, "a failed combined gate must block approval");

assert.equal(parseCompletionReviewReport({ summary: "ack" }), null, "acknowledgement-only reviews must be rejected");
assert.equal(parseCompletionReviewReport({
  ...approved,
  requirements: [{ requirement: "A", status: "Unknown", evidence: "none" }],
}), null, "unknown matrix states must be rejected");

const scratch = mkdtempSync(join(tmpdir(), "epic-completion-review-test-"));
try {
  const databaseUrl = `file:${join(scratch, "pm.db")}`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PM_EPIC_MERGE_DIR: join(scratch, "spool"),
    EPIC_COMPLETION_REVIEW_DB_SLICE: "1",
  };
  execFileSync("pnpm", ["prisma", "migrate", "deploy"], { cwd: process.cwd(), env, stdio: "pipe" });
  const child = spawnSync(process.execPath, ["--import", "tsx", process.argv[1]!], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || "database slice failed");
  assert.match(child.stdout, /database slice passed/);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("epic-completion-review-test passed");
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
