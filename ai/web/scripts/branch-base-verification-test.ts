import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchVerificationBranch,
  validateOriginBase,
} from "../lib/deploy/branch-base";

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const root = mkdtempSync(join(tmpdir(), "pm-branch-base-"));
const remote = join(root, "remote.git");
const seed = join(root, "seed");
const verifier = join(root, "verifier");

async function main() {
try {
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "master", seed], { stdio: "ignore" });
  git(seed, ["config", "user.name", "PM Test"]);
  git(seed, ["config", "user.email", "pm-test@example.invalid"]);
  writeFileSync(join(seed, "base.txt"), "base\n");
  git(seed, ["add", "base.txt"]);
  git(seed, ["commit", "-m", "base"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "master"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/master"]);

  git(seed, ["checkout", "-b", "feature/v23-3"]);
  writeFileSync(join(seed, "feature.txt"), "feature\n");
  git(seed, ["add", "feature.txt"]);
  git(seed, ["commit", "-m", "V23-3 feature"]);
  git(seed, ["push", "-u", "origin", "feature/v23-3"]);
  execFileSync("git", ["clone", remote, verifier], { stdio: "ignore" });

  const configured = await fetchVerificationBranch(verifier, "feature/v23-3", "master");
  assert.equal(configured.error, null);
  assert.equal(configured.baseBranch, "master", "configured PR target should be authoritative");
  assert.equal((await validateOriginBase(verifier, "feature/v23-3", configured.baseBranch)).ok, true);

  const legacy = await fetchVerificationBranch(verifier, "feature/v23-3");
  assert.equal(legacy.error, null);
  assert.equal(legacy.baseBranch, "master", "legacy jobs should use the remote default branch");

  const missingMain = await fetchVerificationBranch(verifier, "feature/v23-3", "main");
  assert.equal(missingMain.error, null);
  assert.equal(missingMain.baseBranch, "master", "missing conventional main should fall back to remote master");

  git(verifier, ["config", "user.name", "PM Test"]);
  git(verifier, ["config", "user.email", "pm-test@example.invalid"]);
  git(verifier, ["checkout", "-b", "feature/local-only", "origin/master"]);
  writeFileSync(join(verifier, "local-only.txt"), "local only\n");
  git(verifier, ["add", "local-only.txt"]);
  git(verifier, ["commit", "-m", "V23-4 local feature"]);
  const beforePush = await fetchVerificationBranch(verifier, "feature/local-only", "master");
  assert.notEqual(beforePush.error, null, "a feature absent from origin should initially report a fetch error");
  git(verifier, ["push", "origin", "feature/local-only"]);
  const afterPush = await fetchVerificationBranch(verifier, "feature/local-only", "master");
  assert.equal(afterPush.error, null, "the verifier must be able to recover after publishing a local-only branch");
  assert.equal((await validateOriginBase(verifier, "feature/local-only", afterPush.baseBranch)).ok, true);

  git(seed, ["checkout", "master"]);
  writeFileSync(join(seed, "base.txt"), "base advanced\n");
  git(seed, ["add", "base.txt"]);
  git(seed, ["commit", "-m", "advance master"]);
  git(seed, ["push", "origin", "master"]);

  const refreshed = await fetchVerificationBranch(verifier, "feature/v23-3", "master");
  assert.equal(refreshed.error, null);
  const stale = await validateOriginBase(verifier, "feature/v23-3", refreshed.baseBranch);
  assert.equal(stale.ok, false, "feature branches missing the current base tip must fail review");
  assert.match(stale.error ?? "", /does not contain the current origin\/master/);

  console.log("branch-base-verification-test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
