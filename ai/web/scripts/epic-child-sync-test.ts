import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synchronizeEpicChild, renderEpicSyncHandoff } from "../lib/deploy/epic-child-sync";

const root = mkdtempSync(join(tmpdir(), "pm-epic-sync-"));
const repo = join(root, "repo");
const task = join(root, "task");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", "--all"); git(repo, "commit", "-m", "Epic update");
  return git(repo, "rev-parse", "HEAD");
}
async function main() {
  execFileSync("git", ["init", "-b", "epic", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "PM Test"); git(repo, "config", "user.email", "pm@example.invalid");
  const initial = commit("shared.txt", "initial\n");
  git(repo, "worktree", "add", "-b", "child", task);
  const base = commit("epic.txt", "new Epic change\n");
  writeFileSync(join(task, "shared.txt"), "task implementation\n");
  git(task, "add", "shared.txt");
  writeFileSync(join(task, "new-test.txt"), "untracked test evidence\n");
  const args = { worktreePath: task, branchName: "child", baseSha: base, requestId: "job-1", commitSubject: "TASK-1 implement", gitUserName: "PM Test", gitUserEmail: "pm@example.invalid" };
  const synced = await synchronizeEpicChild(args);
  assert.equal(synced.outcome, "revalidate", synced.error ?? "");
  assert.equal(synced.originalSha, initial);
  assert.equal(readFileSync(join(task, "shared.txt"), "utf8"), "task implementation\n");
  assert.equal(readFileSync(join(task, "new-test.txt"), "utf8"), "untracked test evidence\n");
  assert.equal(readFileSync(join(task, "epic.txt"), "utf8"), "new Epic change\n");
  assert.equal(git(task, "show", `${synced.checkpointSha}:new-test.txt`), "untracked test evidence");
  git(task, "merge-base", "--is-ancestor", base, "HEAD");
  assert.equal(git(task, "status", "--porcelain"), "");
  assert.equal(git(task, "for-each-ref", "refs/remotes"), "", "synchronization never publishes or fetches child refs");
  assert.match(renderEpicSyncHandoff(synced, "child", "epic"), /Revalidation is required/);
  assert.equal((await synchronizeEpicChild(args)).outcome, "revalidate", "duplicate job cannot certify changed source");
  assert.equal((await synchronizeEpicChild({ ...args, requestId: "job-2" })).outcome, "unchanged");
  console.log("PASS dirty tracked/untracked preservation, local-only synchronization, revalidation and duplicate delivery");

  const marker = join(git(task, "rev-parse", "--absolute-git-dir"), "pm-epic-sync.json");
  writeFileSync(marker, JSON.stringify({ ...synced, outcome: "error", headSha: synced.checkpointSha, requestId: "interrupted", branchName: "child" }));
  assert.equal((await synchronizeEpicChild({ ...args, requestId: "recovered" })).outcome, "revalidate", "a crash after merge cannot bypass fresh validation");
  assert.equal((await synchronizeEpicChild({ ...args, requestId: "revalidated" })).outcome, "unchanged");
  console.log("PASS interrupted merge completion still requires revalidation");

  const conflictingBase = commit("shared.txt", "Epic implementation\n");
  const conflictArgs = { ...args, baseSha: conflictingBase, requestId: "job-3" };
  const conflict = await synchronizeEpicChild(conflictArgs);
  assert.equal(conflict.outcome, "conflicts", conflict.error ?? "");
  assert.deepEqual(conflict.conflictPaths, ["shared.txt"]);
  assert.match(renderEpicSyncHandoff(conflict, "child", "epic"), /stage only resolved files/);
  assert.equal(git(task, "show", `${conflict.checkpointSha}:shared.txt`), "task implementation");
  const waiting = await synchronizeEpicChild({ ...conflictArgs, requestId: "job-4" });
  assert.equal(waiting.outcome, "conflicts", "unresolved files cannot be automatically staged or committed");
  // Even explicitly staged conflict markers are not accepted.
  git(task, "add", "shared.txt");
  const markers = await synchronizeEpicChild({ ...conflictArgs, requestId: "job-5" });
  assert.equal(markers.outcome, "conflicts");
  assert.match(markers.error ?? "", /diff --check/);
  writeFileSync(join(task, "shared.txt"), "Epic and task implementation\n");
  git(task, "add", "shared.txt");
  const resolved = await synchronizeEpicChild({ ...conflictArgs, requestId: "job-6" });
  assert.equal(resolved.outcome, "revalidate", resolved.error ?? "");
  git(task, "merge-base", "--is-ancestor", conflictingBase, "HEAD");
  assert.equal(git(task, "status", "--porcelain"), "");
  assert.equal((await synchronizeEpicChild({ ...conflictArgs, requestId: "job-7" })).outcome, "unchanged");
  console.log("PASS PM-owned conflict continuation and fresh validation after resolution; staged markers rejected");

  const rejected = await synchronizeEpicChild({ ...args, worktreePath: repo, branchName: "epic" });
  assert.equal(rejected.outcome, "error");
  assert.match(rejected.error ?? "", /registered linked/);
  const wrongBranch = await synchronizeEpicChild({ ...args, branchName: "other" });
  assert.equal(wrongBranch.outcome, "error");
  assert.equal(git(repo, "rev-parse", "epic"), conflictingBase, "PM never edits the Epic integration branch here");
  console.log("PASS primary-checkout/wrong-branch refusal and unchanged Epic ref");
}
main().finally(() => rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
