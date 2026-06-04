import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db as defaultDb } from "@/lib/db";

const execFileAsync = promisify(execFile);
const LOG_EXCERPT_MAX = 4000;

export type DeploymentScope = "epic" | "task";
export type DeploymentMonitorAction = "opened-prs" | "reporter-email-required";
export type DeploymentPrTerminalStatus = "deployed" | "deployment_error" | "declined" | "pipeline_failed";

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
  mode: "pr-only" | "script" | "pipeline" | "manual";
  onMerge: string | null;
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

export interface ProviderPullRequestState {
  state: "open" | "merged" | "declined";
  mergeSha: string | null;
  pipelineFailed?: boolean;
}

export interface OnMergeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeploymentWatcherResult {
  checked: number;
  completed: number;
  failed: number;
  skipped: number;
}

type DbClient = typeof defaultDb;
const prisma = (client: DbClient) => client as unknown as any;

type DeploymentPrRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  epicId: string | null;
  provider: string;
  providerPrId: string;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  latestCommitSha: string;
  reporterUserId: string;
  reporterName: string;
  reporterEmail: string;
  status: string;
  mergeSha?: string | null;
  deploymentExitCode?: number | null;
  deploymentStdout?: string | null;
  deploymentStderr?: string | null;
  deploymentReportedAt?: Date | string | null;
  project?: {
    repositoryPath: string | null;
    deploymentMode: string;
    deploymentOnMerge: string | null;
    deploymentBitbucketWorkspace: string | null;
    deploymentBitbucketRepoSlug: string | null;
  };
};

function reporterName(user: { name: string | null; username: string }) {
  return user.name?.trim() || user.username;
}

function deploymentMode(value: string | null | undefined): DeploymentProjectConfig["mode"] {
  if (value === "script" || value === "pipeline" || value === "manual" || value === "pr-only") return value;
  return "pr-only";
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
        mode: deploymentMode(epic.project.deploymentMode),
        onMerge: epic.project.deploymentOnMerge,
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
      mode: deploymentMode(task.project.deploymentMode),
      onMerge: task.project.deploymentOnMerge,
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

export async function fetchBitbucketPullRequestState(row: DeploymentPrRow): Promise<ProviderPullRequestState> {
  const configuredRepo = row.project?.deploymentBitbucketWorkspace && row.project?.deploymentBitbucketRepoSlug
    ? { workspace: row.project.deploymentBitbucketWorkspace, repoSlug: row.project.deploymentBitbucketRepoSlug }
    : row.project?.repositoryPath
      ? await remoteBitbucketRepo(row.project.repositoryPath)
      : null;
  if (!configuredRepo) throw new Error("Bitbucket workspace/repo slug is required to poll deployment PRs");
  const base = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(configuredRepo.workspace)}/${encodeURIComponent(configuredRepo.repoSlug)}`;
  const res = await fetch(`${base}/pullrequests/${encodeURIComponent(row.providerPrId)}`, {
    headers: { authorization: `Basic ${bitbucketAuth()}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Bitbucket PR poll failed (${res.status}): ${await res.text()}`);
  const json = await res.json() as any;
  const rawState = String(json.state ?? "").toUpperCase();
  const state: ProviderPullRequestState["state"] = rawState === "MERGED" || rawState === "FULFILLED"
    ? "merged"
    : rawState === "DECLINED" || rawState === "SUPERSEDED"
      ? "declined"
      : "open";
  const mergeSha = json.merge_commit?.hash ?? json.destination?.commit?.hash ?? null;
  let pipelineFailed = false;
  const commit = mergeSha ?? row.latestCommitSha;
  if (commit) {
    const pipelines = await fetch(`${base}/pipelines/?target.commit.hash=${encodeURIComponent(commit)}&pagelen=5`, {
      headers: { authorization: `Basic ${bitbucketAuth()}`, accept: "application/json" },
    }).catch(() => null);
    if (pipelines?.ok) {
      const body = await pipelines.json() as any;
      pipelineFailed = Array.isArray(body.values) && body.values.some((p: any) => String(p.state?.result?.name ?? p.state?.name ?? "").toUpperCase() === "FAILED");
    }
  }
  return { state, mergeSha, pipelineFailed };
}

export async function runProjectOnMerge(args: {
  repositoryPath: string;
  mode: DeploymentProjectConfig["mode"];
  onMerge: string | null;
  pipelineFailed?: boolean;
}): Promise<OnMergeResult> {
  if (args.mode === "pipeline") {
    return { exitCode: args.pipelineFailed ? 1 : 0, stdout: args.pipelineFailed ? "" : "Pipeline succeeded", stderr: args.pipelineFailed ? "Pipeline failed" : "" };
  }
  if (args.mode !== "script") {
    return { exitCode: 0, stdout: `${args.mode} deployment completed by PR merge`, stderr: "" };
  }
  if (!args.onMerge?.trim()) throw new Error("deployment.onMerge script is required for script deployment mode");
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", args.onMerge], {
      cwd: args.repositoryPath,
      maxBuffer: 1024 * 1024 * 2,
      timeout: Number(process.env.PM_DEPLOYMENT_ON_MERGE_TIMEOUT_MS ?? "300000"),
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: any) {
    return { exitCode: typeof err.code === "number" ? err.code : 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? err) };
  }
}

export async function pollDeploymentPullRequests(args: {
  db?: DbClient;
  fetchState?: (row: DeploymentPrRow) => Promise<ProviderPullRequestState>;
  runOnMerge?: (args: { repositoryPath: string; mode: DeploymentProjectConfig["mode"]; onMerge: string | null; pipelineFailed?: boolean }) => Promise<OnMergeResult>;
} = {}): Promise<DeploymentWatcherResult> {
  const db = prisma(args.db ?? defaultDb);
  const fetchState = args.fetchState ?? fetchBitbucketPullRequestState;
  const runOnMerge = args.runOnMerge ?? runProjectOnMerge;
  const rows: DeploymentPrRow[] = await db.deploymentPullRequest.findMany({
    where: { status: "open" },
    include: { project: true },
    orderBy: { updatedAt: "asc" },
  });
  const result: DeploymentWatcherResult = { checked: rows.length, completed: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const state = await fetchState(row);
    if (state.state === "open" && !state.pipelineFailed) {
      result.skipped += 1;
      continue;
    }
    if (state.state === "declined") {
      await finalizeDeploymentPr({ db, row, status: "declined", mergeSha: state.mergeSha, exitCode: 1, stdout: "", stderr: "Pull request declined" });
      result.failed += 1;
      continue;
    }
    if (state.pipelineFailed) {
      await finalizeDeploymentPr({ db, row, status: "pipeline_failed", mergeSha: state.mergeSha, exitCode: 1, stdout: "", stderr: "Pipeline failed" });
      result.failed += 1;
      continue;
    }
    if (!row.project?.repositoryPath) throw new Error(`Project repositoryPath is required for deployment PR ${row.id}`);
    const mode = deploymentMode(row.project.deploymentMode);
    const deploy = await runOnMerge({ repositoryPath: row.project.repositoryPath, mode, onMerge: row.project.deploymentOnMerge, pipelineFailed: false });
    await finalizeDeploymentPr({
      db,
      row,
      status: deploy.exitCode === 0 ? "deployed" : "deployment_error",
      mergeSha: state.mergeSha,
      exitCode: deploy.exitCode,
      stdout: deploy.stdout,
      stderr: deploy.stderr,
    });
    if (deploy.exitCode === 0) result.completed += 1;
    else result.failed += 1;
  }
  return result;
}

async function finalizeDeploymentPr(args: {
  db: any;
  row: DeploymentPrRow;
  status: DeploymentPrTerminalStatus;
  mergeSha: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
}) {
  const existing = await args.db.deploymentPullRequest.findUnique({ where: { id: args.row.id }, select: { status: true, deploymentReportedAt: true } }).catch(() => null);
  if (existing && existing.status !== "open") return;
  await args.db.deploymentPullRequest.update({
    where: { id: args.row.id },
    data: {
      status: args.status,
      mergeSha: args.mergeSha,
      deploymentExitCode: args.exitCode,
      deploymentStdout: excerpt(args.stdout),
      deploymentStderr: excerpt(args.stderr),
      deploymentReportedAt: new Date(),
    },
  });
  await writeDeploymentOutcome({ db: args.db, row: args.row, status: args.status, mergeSha: args.mergeSha, exitCode: args.exitCode, stdout: args.stdout, stderr: args.stderr });
}

async function writeDeploymentOutcome(args: {
  db: any;
  row: DeploymentPrRow;
  status: DeploymentPrTerminalStatus;
  mergeSha: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
}) {
  const failed = args.status !== "deployed";
  const body = deploymentReportBody(args);
  if (args.row.epicId) {
    const allRows: DeploymentPrRow[] = await args.db.deploymentPullRequest.findMany({ where: { epicId: args.row.epicId } });
    const statuses = allRows.map((r) => r.id === args.row.id ? args.status : r.status);
    const anyFailed = statuses.some((status) => ["deployment_error", "declined", "pipeline_failed"].includes(status));
    const allDeployed = statuses.length > 0 && statuses.every((status) => status === "deployed");
    if (anyFailed || allDeployed) {
      await args.db.epic.update({ where: { id: args.row.epicId }, data: { deploymentStatus: anyFailed ? "Deployment Error" : "Successfully Deployed" } });
    }
    await args.db.comment.create({ data: { epicId: args.row.epicId, userId: args.row.reporterUserId, body } });
  } else if (args.row.taskId) {
    await args.db.task.update({ where: { id: args.row.taskId }, data: { deploymentStatus: failed ? "Deployment Error" : "Successfully Deployed" } });
    await args.db.comment.create({ data: { taskId: args.row.taskId, userId: args.row.reporterUserId, body } });
  }
  await args.db.activityLog.create({
    data: {
      projectId: args.row.projectId,
      taskId: args.row.taskId,
      userId: args.row.reporterUserId,
      kind: "deployment.outcome",
      payload: JSON.stringify({ prId: args.row.id, providerPrId: args.row.providerPrId, status: args.status, mergeSha: args.mergeSha, exitCode: args.exitCode }),
    },
  }).catch(() => null);
}

function deploymentReportBody(args: { row: DeploymentPrRow; status: DeploymentPrTerminalStatus; mergeSha: string | null; exitCode: number; stdout: string; stderr: string }) {
  const statusLabel = args.status === "deployed" ? "Successfully Deployed" : "Deployment Error";
  const lines = [
    `Deployment report: ${statusLabel}`,
    `PR: ${args.row.url}`,
    `Merge SHA: ${args.mergeSha ?? "n/a"}`,
    `Exit status: ${args.exitCode}`,
    `Outcome: ${oneLineOutcome(args.status, args.exitCode)}`,
  ];
  const error = excerpt(args.stderr || args.stdout);
  if (args.status !== "deployed" && error) lines.push(`Error excerpt:\n${error}`);
  return lines.join("\n");
}

function oneLineOutcome(status: DeploymentPrTerminalStatus, exitCode: number) {
  if (status === "deployed") return "PR merged and deployment completed successfully.";
  if (status === "declined") return "PR was declined before deployment.";
  if (status === "pipeline_failed") return "Provider pipeline failed before deployment.";
  return `deployment.onMerge exited with ${exitCode}.`;
}

function excerpt(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (text.length <= LOG_EXCERPT_MAX) return text;
  return `${text.slice(0, LOG_EXCERPT_MAX)}\n… truncated`;
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
