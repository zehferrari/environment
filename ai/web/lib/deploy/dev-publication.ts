import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { parseDevPublicationConfig, devConfigFingerprint, type DevCommand, type DevPublicationConfig } from "@/lib/projects/dev-publication-config";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import { validateStandingAuthorization } from "@/lib/tasks/standing-authorization";

const exec = promisify(execFile);
export class DevPublicationError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); this.name = "DevPublicationError"; }
}
export const publicationAttemptId = (key: string) => createHash("sha256").update(key).digest("hex");

/** Called by each Git publication primitive after constructing the exact
 * candidate and before push. A task cannot broaden the owner-approved pipeline
 * by modifying deployment files while retaining its standing plan grant. */
export async function assertDevPublicationCandidate(args: { projectId: string; repositoryPath: string; branch: string; sha: string }) {
  const project = await db.project.findUniqueOrThrow({ where: { id: args.projectId }, select: { devPublicationConfig: true, deploymentProductionBranch: true } });
  const config = parseDevPublicationConfig(project.devPublicationConfig);
  if (!config || ["main", "master", project.deploymentProductionBranch].includes(args.branch)) return;
  for (const file of config.configurationFiles) {
    let bytes: Buffer;
    try {
      const result = await exec("git", ["-C", args.repositoryPath, "show", `${args.sha}:${file.path}`], { encoding: "buffer", timeout: 10_000, maxBuffer: 1024 * 1024 });
      bytes = result.stdout;
    } catch { throw new DevPublicationError(`The candidate does not contain pinned deployment configuration ${file.path}; owner review is required.`); }
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new DevPublicationError(`The candidate changes deployment configuration ${file.path}; owner review and a new target authorization are required.`);
  }
}

/** Finalization can release verified task ownership. Unknown outcomes remain
 * reserved until the runner confirms the deployed revision. */
export async function releaseTaskDevLease(tx: Prisma.TransactionClient, args: { taskId: string }) {
  const leases = await tx.devEnvironmentLease.findMany({ where: { taskId: args.taskId, state: "ready" } });
  for (const lease of leases) if (lease.expectedSha && lease.expectedSha === lease.verifiedSha) {
    await tx.devEnvironmentLease.updateMany({ where: { id: lease.id, state: "ready", attemptId: lease.attemptId, verifiedSha: lease.expectedSha }, data: { state: "released" } });
  }
}

async function runRegisteredCommand(command: DevCommand, config: DevPublicationConfig, sha: string, branch: string) {
  const executable = await realpath(command.executable);
  const info = await stat(executable);
  // Commands belong to the host, never the mutable task checkout. An agent
  // cannot replace an owner-approved deployment command through its patch.
  const insideRepo = !relative(await realpath(config.repositoryPath), executable).startsWith("..");
  if (insideRepo || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || /^(ba|da|z|fi)?sh$|^(node|python\d*|perl|ruby|env)$/.test(basename(executable))) {
    throw new DevPublicationError("Dev commands must be installed, root-owned executables outside the repository; mutable scripts and interpreter commands are refused.");
  }
  const replacements: Record<string, string> = { sha, branch, target: config.target, environmentId: config.environmentId };
  const args = command.args.map(arg => arg.replace(/\{(sha|branch|target|environmentId)\}/g, (_, key: string) => replacements[key]));
  try {
    const { stdout } = await exec(executable, args, { cwd: config.repositoryPath, timeout: command.timeoutSeconds * 1000, maxBuffer: 64 * 1024, env: process.env });
    return stdout.trim();
  } catch {
    // Runner credentials and command output never enter task history.
    throw new DevPublicationError("The registered Dev command failed or timed out; inspect the runner locally. The environment remains reserved pending verified recovery.", true);
  }
}

export function verifyDevReceipt(output: string, config: DevPublicationConfig, sha: string): void {
  let receipt: { sha?: string; environmentId?: string; target?: string };
  try { receipt = JSON.parse(output); } catch { throw new DevPublicationError("Dev verification returned no valid JSON receipt.", true); }
  if (receipt.sha !== sha || receipt.environmentId !== config.environmentId || receipt.target !== config.target) {
    throw new DevPublicationError("Dev verification did not confirm the exact published SHA and registered environment/target.", true);
  }
}

/** Every PM publication entry point calls this, including review and Epic
 * finalization. No config preserves legacy policy; configured environments are
 * serialized across projects by the owner-selected environmentId. */
export async function withDevPublication<T>(args: {
  projectId: string; taskId?: string; branch: string; attemptId: string; grantId?: string;
  publish: () => Promise<T>; publishedSha: (result: T) => string | null | Promise<string | null>;
}, dependencies: { runCommand?: typeof runRegisteredCommand } = {}): Promise<T> {
  const executeCommand = dependencies.runCommand ?? runRegisteredCommand;
  const project = await db.project.findUniqueOrThrow({ where: { id: args.projectId }, select: {
    repositoryPath: true, devPublicationPolicy: true, devPublicationConfig: true,
    deploymentProductionBranch: true, agentChangeBlockedBranches: true,
  } });
  const config = parseDevPublicationConfig(project.devPublicationConfig);
  if (!config) {
    if (args.grantId) throw new DevPublicationError("Standing publication requires registered Dev configuration.");
    return args.publish();
  }
  // Production publication retains its existing explicit deployment boundary.
  // A standing grant can never use that bypass.
  const productionTarget = ["main", "master", project.deploymentProductionBranch].includes(args.branch);
  if (args.grantId && (productionTarget || isProtectedBranch(project.agentChangeBlockedBranches, args.branch))) {
    throw new DevPublicationError("A standing grant cannot publish a protected or production branch.");
  }
  if (productionTarget) {
    return args.publish();
  }
  if (config.repositoryPath !== project.repositoryPath) throw new DevPublicationError("The registered Dev repository does not match this project.");
  if (args.grantId) {
    if (!args.taskId) throw new DevPublicationError("Standing publication must name its task.");
    const authority = await validateStandingAuthorization(db, { taskId: args.taskId, grantId: args.grantId });
    if (!authority.ok) throw new DevPublicationError(authority.reason);
    if (authority.grant.branch !== args.branch) throw new DevPublicationError("The publication branch differs from the standing grant.");
  }
  const fingerprint = devConfigFingerprint(config);
  const id = publicationAttemptId(`${args.projectId}:${args.attemptId}`);
  const attempt = await db.$transaction(async tx => {
    const prior = await tx.devPublicationAttempt.findUnique({ where: { id } });
    if (prior && (prior.configFingerprint !== fingerprint || prior.branch !== args.branch || prior.taskId !== (args.taskId ?? null) || prior.grantId !== (args.grantId ?? null))) throw new DevPublicationError("Publication attempt identity was reused with different scope.");
    if (prior?.state === "verified") return prior;
    const lease = await tx.devEnvironmentLease.findUnique({ where: { environmentId: config.environmentId } });
    const ownVerifiedSlot = !!args.taskId && lease?.taskId === args.taskId && lease.state === "ready";
    if (lease && lease.state !== "released" && lease.attemptId !== id && !ownVerifiedSlot) throw new DevPublicationError("The shared Dev environment is reserved by another publication or pending verification. Retry after that attempt settles.", true);
    if (lease && lease.attemptId === id && ["reserved", "verifying"].includes(lease.state) && lease.expiresAt > new Date()) throw new DevPublicationError("This publication attempt is already executing.", true);
    // A timeout is uncertainty, not permission to overwrite an in-flight pipeline.
    const leaseData = { taskId: args.taskId ?? null, grantId: args.grantId ?? null, attemptId: id, state: "reserved", expiresAt: new Date(Date.now() + 5 * 60_000), lastError: null };
    await tx.devEnvironmentLease.upsert({ where: { environmentId: config.environmentId }, create: { environmentId: config.environmentId, ...leaseData }, update: leaseData });
    return prior ?? tx.devPublicationAttempt.create({ data: { id, projectId: args.projectId, taskId: args.taskId ?? null, grantId: args.grantId ?? null, environmentId: config.environmentId, branch: args.branch, configFingerprint: fingerprint } });
  });
  if (attempt.state === "verified" && attempt.resultJson) return JSON.parse(attempt.resultJson) as T;
  try {
    // Recheck after acquiring the lease; a revoked queued attempt has no effects.
    if (args.grantId && args.taskId) {
      const authority = await validateStandingAuthorization(db, { taskId: args.taskId, grantId: args.grantId });
      if (!authority.ok) throw new DevPublicationError(authority.reason);
    }
    const result: T = attempt.resultJson ? JSON.parse(attempt.resultJson) : await args.publish();
    const sha = await args.publishedSha(result);
    if (!sha) {
      // A failed Git operation may have published before losing its response.
      // Keep the lease until the same attempt reconciles remote state.
      throw new DevPublicationError("Publication did not confirm an exact SHA. Retry this attempt to reconcile before releasing the Dev environment.", true);
    }
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new DevPublicationError("The publication returned an invalid commit SHA.");
    if (attempt.publishedSha && attempt.publishedSha !== sha) throw new DevPublicationError("The publication attempt cannot absorb a different commit.");
    // Also validate no-push/already-published paths before any registered deploy
    // command. An external publisher may have changed pipeline files meanwhile.
    await assertDevPublicationCandidate({ projectId: args.projectId, repositoryPath: config.repositoryPath, branch: args.branch, sha });
    await db.$transaction([
      db.devPublicationAttempt.update({ where: { id }, data: { state: "published", publishedSha: sha, resultJson: JSON.stringify(result), lastError: null } }),
      db.devEnvironmentLease.update({ where: { environmentId: config.environmentId }, data: { state: "verifying", expectedSha: sha } }),
    ]);
    // A published attempt resumes by observing its exact target, never by
    // repeating an uncertain deployment command. Installed deploy commands
    // should also be idempotent for their SHA across process crashes.
    if (config.devOnCheckpoint && !attempt.publishedSha) await executeCommand(config.devOnCheckpoint, config, sha, args.branch);
    const receipt = await executeCommand(config.verify, config, sha, args.branch);
    verifyDevReceipt(receipt, config, sha);
    await db.$transaction([
      db.devPublicationAttempt.update({ where: { id }, data: { state: "verified", verifiedSha: sha, lastError: null } }),
      db.devEnvironmentLease.update({ where: { environmentId: config.environmentId }, data: { state: args.taskId ? "ready" : "released", verifiedSha: sha, lastError: null } }),
      db.activityLog.create({ data: { projectId: args.projectId, taskId: args.taskId ?? null, kind: "pm.dev.publication.verified", payload: JSON.stringify({ attemptId: id, environmentId: config.environmentId, target: config.target, sha, grantId: args.grantId ?? null }) } }),
    ]);
    return result;
  } catch (error) {
    const message = error instanceof DevPublicationError ? error.message : "Dev publication could not settle; the reservation is retained for recovery.";
    await db.$transaction([
      db.devPublicationAttempt.update({ where: { id }, data: { state: "uncertain", lastError: message } }),
      db.devEnvironmentLease.update({ where: { environmentId: config.environmentId }, data: { state: "uncertain", lastError: message } }),
    ]);
    throw new DevPublicationError(message, Date.now() - attempt.createdAt.getTime() < 60 * 60_000);
  }
}
