import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db as defaultDb } from "@/lib/db";

const execFileAsync = promisify(execFile);

export type DeploymentScope = "epic" | "task";
export type DeploymentMonitorAction = "opened-prs" | "reporter-email-required";

export interface ReporterIdentity {
  userId: string;
  name: string;
  email: string | null;
}

export interface DeploymentTarget {
  taskId: string | null;
  epicId: string | null;
  workItemKey: string | null;
  title: string;
  branchName: string;
  commitPrefix: string | null;
}

export interface DeploymentProjectConfig {
  projectId: string;
  projectSlug: string;
  repositoryPath: string;
  provider: "bitbucket";
  productionBranch: string;
  workspace: string;
  repoSlug: string;
}

export interface DeploymentPlan {
  scope: DeploymentScope;
  scopeId: string;
  project: DeploymentProjectConfig;
  reporter: ReporterIdentity;
  targets: DeploymentTarget[];
}

export interface BranchVerification {
  branchName: string;
  localSha: string;
  remoteSha: string | null;
  pushed: boolean;
  matchingCommitCount: number;
}

export interface OpenedDeploymentPr {
  target: DeploymentTarget;
  url: string;
  providerPrId: string;
  sourceBranch: string;
  targetBranch: string;
  latestCommitSha: string;
}

export interface DeploymentMonitorResult {
  action: DeploymentMonitorAction;
  reporter: ReporterIdentity;
  prompt?: { userId: string; question: string };
  prs?: OpenedDeploymentPr[];
}

type DbClient = typeof defaultDb;
const prisma = (client: DbClient) => client as unknown as any;

function reporterName(user: { name: string | null; username: string }) {
  return user.name?.trim() || user.username;
}

function parseBitbucketRemote(url: string): { workspace: string; repoSlug: string } | null {
  const ssh = /bitbucket\.org[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url.trim());
  if (ssh) return { workspace: ssh[1], repoSlug: ssh[2] };
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "bitbucket.org") return null;
    const [, workspace, rawRepo] = parsed.pathname.split("/");
    if (!workspace || !rawRepo) return null;
    return { workspace, repoSlug: rawRepo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 1024 * 1024 * 4,
  });
  return String(stdout).trim();
}

async function remoteBitbucketRepo(repositoryPath: string) {
  const remote = await git(repositoryPath, ["remote", "get-url", "origin"]);
  const parsed = parseBitbucketRemote(remote);
  if (!parsed) throw new Error(`origin remote is not a Bitbucket repository: ${remote}`);
  return parsed;
}

export async function resolveDeploymentPlan(args: {
  scope: DeploymentScope;
  scopeId: string;
  db?: DbClient;
}): Promise<DeploymentPlan> {
  const db = prisma(args.db ?? defaultDb);
  if (args.scope === "epic") {
    const epic = await db.epic.findUnique({
      where: { id: args.scopeId },
      include: {
        reporter: { select: { id: true, username: true, name: true, email: true } },
        project: true,
        tasks: { where: { deletedAt: null, archivedAt: null, parentTaskId: null }, orderBy: { rank: "asc" } },
      },
    });
    if (!epic || epic.deletedAt || epic.archivedAt) throw new Error("Epic not found");
    if (!epic.reporter) throw new Error("Epic reporter is required before deployment");
    if (!epic.project.repositoryPath) throw new Error("Project repositoryPath is required before deployment");
    const repo = await remoteBitbucketRepo(epic.project.repositoryPath);
    const childTargets = epic.tasks.filter((task: any) => task.branchName);
    const targets = childTargets.length
      ? childTargets.map((task: any): DeploymentTarget => ({
          taskId: task.id,
          epicId: epic.id,
          workItemKey: task.workItemKey,
          title: task.title,
          branchName: task.branchName!,
          commitPrefix: task.commitPrefix ?? epic.commitPrefix,
        }))
      : epic.branchName
        ? [{
            taskId: null,
            epicId: epic.id,
            workItemKey: epic.workItemKey,
            title: epic.title,
            branchName: epic.branchName,
            commitPrefix: epic.commitPrefix,
          }]
        : [];
    if (targets.length === 0) throw new Error("No deployable branch found on Epic or child Tasks");
    return {
      scope: "epic",
      scopeId: epic.id,
      project: {
        projectId: epic.project.id,
        projectSlug: epic.project.slug,
        repositoryPath: epic.project.repositoryPath,
        provider: "bitbucket",
        productionBranch: epic.project.deploymentProductionBranch ?? "main",
        workspace: epic.project.deploymentBitbucketWorkspace ?? repo.workspace,
        repoSlug: epic.project.deploymentBitbucketRepoSlug ?? repo.repoSlug,
      },
      reporter: { userId: epic.reporter.id, name: reporterName(epic.reporter), email: epic.reporter.email },
      targets,
    };
  }

  const task = await db.task.findUnique({
    where: { id: args.scopeId },
    include: {
      reporter: { select: { id: true, username: true, name: true, email: true } },
      project: true,
      epic: { select: { id: true, status: true } },
    },
  });
  if (!task || task.deletedAt || task.archivedAt) throw new Error("Task not found");
  if (task.epicId) throw new Error("Deployment can only be approved from an Epic or top-level Task");
  if (!task.reporter) throw new Error("Task reporter is required before deployment");
  if (!task.project.repositoryPath) throw new Error("Project repositoryPath is required before deployment");
  if (!task.branchName) throw new Error("Task branchName is required before deployment");
  const repo = await remoteBitbucketRepo(task.project.repositoryPath);
  return {
    scope: "task",
    scopeId: task.id,
    project: {
      projectId: task.project.id,
      projectSlug: task.project.slug,
      repositoryPath: task.project.repositoryPath,
      provider: "bitbucket",
      productionBranch: task.project.deploymentProductionBranch ?? "main",
      workspace: task.project.deploymentBitbucketWorkspace ?? repo.workspace,
      repoSlug: task.project.deploymentBitbucketRepoSlug ?? repo.repoSlug,
    },
    reporter: { userId: task.reporter.id, name: reporterName(task.reporter), email: task.reporter.email },
    targets: [{
      taskId: task.id,
      epicId: null,
      workItemKey: task.workItemKey,
      title: task.title,
      branchName: task.branchName,
      commitPrefix: task.commitPrefix,
    }],
  };
}

export async function verifyDeploymentBranch(args: {
  repositoryPath: string;
  branchName: string;
  commitPrefix: string | null;
  reporter: ReporterIdentity;
  targetBranch: string;
}): Promise<BranchVerification> {
  await git(args.repositoryPath, ["rev-parse", "--verify", `refs/heads/${args.branchName}`]);
  const dirty = await git(args.repositoryPath, ["status", "--porcelain"]);
  if (dirty) throw new Error(`Worktree is not clean for ${args.branchName}`);
  const localSha = await git(args.repositoryPath, ["rev-parse", args.branchName]);
  const remoteLine = await git(args.repositoryPath, ["ls-remote", "--heads", "origin", args.branchName]).catch(() => "");
  const remoteSha = remoteLine ? remoteLine.split(/\s+/)[0] : null;
  let matchingCommitCount = 0;
  if (args.commitPrefix) {
    const log = await git(args.repositoryPath, [
      "log",
      `${args.targetBranch}..${args.branchName}`,
      "--format=%H%x00%an%x00%ae%x00%s",
      `--grep=^${escapeRegExp(args.commitPrefix)}`,
    ]).catch(() => "");
    const rows = log ? log.split("\n") : [];
    matchingCommitCount = rows.filter((row) => {
      const [, authorName, authorEmail] = row.split("\0");
      return authorName === args.reporter.name && authorEmail === args.reporter.email;
    }).length;
    if (matchingCommitCount === 0) {
      throw new Error(`No ${args.commitPrefix} commits authored as ${args.reporter.name} <${args.reporter.email}> found on ${args.branchName}`);
    }
  }
  let pushed = false;
  if (remoteSha !== localSha) {
    await git(args.repositoryPath, ["push", "origin", `${args.branchName}:${args.branchName}`]);
    pushed = true;
  }
  return { branchName: args.branchName, localSha, remoteSha: remoteSha ?? localSha, pushed, matchingCommitCount };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bitbucketAuth() {
  const username = process.env.BITBUCKET_USERNAME ?? process.env.BITBUCKET_USER;
  const password = process.env.BITBUCKET_APP_PASSWORD ?? process.env.BITBUCKET_TOKEN;
  if (!username || !password) throw new Error("BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD are required");
  return Buffer.from(`${username}:${password}`).toString("base64");
}

export async function createBitbucketPullRequest(args: {
  project: DeploymentProjectConfig;
  target: DeploymentTarget;
  reporter: ReporterIdentity;
  latestCommitSha: string;
}): Promise<OpenedDeploymentPr> {
  if (!args.reporter.email) throw new Error("Reporter email is required before opening a PR");
  const title = `${args.target.workItemKey ? `${args.target.workItemKey}: ` : ""}${args.target.title}`;
  const body = [
    `Reporter: ${args.reporter.name} <${args.reporter.email}>`,
    `Source: ${args.target.branchName}`,
    `Target: ${args.project.productionBranch}`,
    `Latest commit: ${args.latestCommitSha}`,
  ].join("\n");
  const res = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(args.project.workspace)}/${encodeURIComponent(args.project.repoSlug)}/pullrequests`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${bitbucketAuth()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        title,
        description: body,
        source: { branch: { name: args.target.branchName } },
        destination: { branch: { name: args.project.productionBranch } },
        close_source_branch: false,
      }),
    },
  );
  if (!res.ok) throw new Error(`Bitbucket PR create failed (${res.status}): ${await res.text()}`);
  const json = await res.json() as { id?: number | string; links?: { html?: { href?: string } } };
  return {
    target: args.target,
    url: json.links?.html?.href ?? "",
    providerPrId: String(json.id ?? ""),
    sourceBranch: args.target.branchName,
    targetBranch: args.project.productionBranch,
    latestCommitSha: args.latestCommitSha,
  };
}

export async function handleDeploymentApproved(args: {
  scope: DeploymentScope;
  scopeId: string;
  db?: DbClient;
  createPr?: typeof createBitbucketPullRequest;
}): Promise<DeploymentMonitorResult> {
  const db = prisma(args.db ?? defaultDb);
  const createPr = args.createPr ?? createBitbucketPullRequest;
  const plan = await resolveDeploymentPlan({ scope: args.scope, scopeId: args.scopeId, db });
  if (!plan.reporter.email) {
    await recordReporterEmailPrompt({ db, plan });
    return {
      action: "reporter-email-required",
      reporter: plan.reporter,
      prompt: {
        userId: plan.reporter.userId,
        question: `What email should be cached for ${plan.reporter.name} before opening deployment PRs?`,
      },
    };
  }
  const prs: OpenedDeploymentPr[] = [];
  for (const target of plan.targets) {
    const verification = await verifyDeploymentBranch({
      repositoryPath: plan.project.repositoryPath,
      branchName: target.branchName,
      commitPrefix: target.commitPrefix,
      reporter: plan.reporter,
      targetBranch: plan.project.productionBranch,
    });
    const pr = await createPr({
      project: plan.project,
      target,
      reporter: plan.reporter,
      latestCommitSha: verification.localSha,
    });
    prs.push(pr);
    await db.deploymentPullRequest.create({
      data: {
        projectId: plan.project.projectId,
        taskId: target.taskId,
        epicId: target.epicId,
        provider: "bitbucket",
        providerPrId: pr.providerPrId,
        url: pr.url,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        latestCommitSha: pr.latestCommitSha,
        reporterUserId: plan.reporter.userId,
        reporterName: plan.reporter.name,
        reporterEmail: plan.reporter.email,
        status: "open",
      },
    });
  }
  return { action: "opened-prs", reporter: plan.reporter, prs };
}

async function recordReporterEmailPrompt(args: { db: any; plan: DeploymentPlan }) {
  const target = args.plan.targets[0];
  const existing = await args.db.activityLog.findFirst({
    where: {
      projectId: args.plan.project.projectId,
      kind: "deployment.reporter_email_required",
      ...(target?.taskId ? { taskId: target.taskId } : {}),
    },
    select: { id: true },
  });
  if (existing) return;
  await args.db.activityLog.create({
    data: {
      projectId: args.plan.project.projectId,
      taskId: target?.taskId ?? null,
      userId: args.plan.reporter.userId,
      kind: "deployment.reporter_email_required",
      payload: JSON.stringify({
        scope: args.plan.scope,
        scopeId: args.plan.scopeId,
        reporterUserId: args.plan.reporter.userId,
        prompt: `What email should be cached for ${args.plan.reporter.name} before opening deployment PRs?`,
      }),
    },
  });
}
