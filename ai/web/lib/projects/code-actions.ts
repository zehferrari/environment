"use server";

import { execFile as execFileCb } from "node:child_process";
import { access, lstat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { requireProjectAccess, requireViewer, type Viewer } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import {
  chooseCodeSource,
  listCodeSources,
  normalizeRepoRelativePath,
  resolveInside,
  type CodeSource,
} from "@/lib/projects/repo-code";

const execFile = promisify(execFileCb);
const MAX_SAVE_BYTES = 700 * 1024;

export type CodeActionResult = {
  ok: boolean;
  message: string;
};

type CodeActionInput = {
  slug: string;
  sourceId: string;
  path?: string;
};

type SaveCodeFileInput = CodeActionInput & {
  content: string;
};

type CommitCodeFileInput = CodeActionInput & {
  message: string;
};

type MergeCodeSourceInput = CodeActionInput & {
  targetBranch: string;
};

export async function saveCodeFile(input: SaveCodeFileInput): Promise<CodeActionResult> {
  try {
    const actor = await requireHumanActor();
    const { project, source, relPath } = await resolveActionSource(actor, input);
    if (!relPath) throw new Error("Choose a file before saving.");
    if (input.content.includes("\0")) throw new Error("Cannot save content containing NUL bytes.");
    const size = Buffer.byteLength(input.content, "utf8");
    if (size > MAX_SAVE_BYTES) {
      throw new Error(`File is ${formatBytes(size)}, above the ${formatBytes(MAX_SAVE_BYTES)} save limit.`);
    }
    const abs = resolveInside(source.path, relPath);
    if (!abs) throw new Error("Path is outside the selected repository.");
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) throw new Error("Only existing regular files can be edited here.");
    await access(abs, fsConstants.W_OK).catch(() => {
      throw new Error("The PM service user cannot write this file. Fix the worktree/file ACLs or choose a writable source.");
    });

    await writeFile(abs, input.content, "utf8");
    await logCodeActivity(project.id, actor.id, "code.file.save", {
      source: source.id,
      branch: source.branch,
      path: relPath,
      bytes: size,
    });
    revalidateCodePath(project.slug, source.id, relPath);
    return { ok: true, message: `Saved ${relPath}.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Save failed") };
  }
}

export async function commitCodeFile(input: CommitCodeFileInput): Promise<CodeActionResult> {
  try {
    const actor = await requireHumanActor();
    const { project, source, relPath } = await resolveActionSource(actor, input);
    if (!relPath) throw new Error("Choose a file before committing.");
    const message = input.message.trim();
    if (!message) throw new Error("Commit message is required.");

    await git(source.path, ["add", "--", relPath]);
    const hasStagedChanges = await gitQuiet(source.path, ["diff", "--cached", "--quiet"]);
    if (hasStagedChanges) throw new Error(`No changes to commit for ${relPath}.`);

    const env = gitIdentityEnv(actor);
    const commit = await git(source.path, ["commit", "-m", message], { env });
    const head = await gitText(source.path, ["rev-parse", "--short", "HEAD"]).catch(() => source.head);
    await logCodeActivity(project.id, actor.id, "code.file.commit", {
      source: source.id,
      branch: source.branch,
      path: relPath,
      head,
      message,
    });
    revalidateCodePath(project.slug, source.id, relPath);
    return { ok: true, message: oneLine(commit) || `Committed ${relPath} at ${head}.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Commit failed") };
  }
}

export async function pushCodeSource(input: CodeActionInput): Promise<CodeActionResult> {
  try {
    const actor = await requireHumanActor();
    const { project, source, relPath } = await resolveActionSource(actor, input);
    if (!source.branch || source.branch === "HEAD") throw new Error("Selected source is not on a named branch.");

    const pushed = await git(source.path, ["push", "origin", `HEAD:${source.branch}`], { timeout: 90_000 });
    const head = await gitText(source.path, ["rev-parse", "--short", "HEAD"]).catch(() => source.head);
    await logCodeActivity(project.id, actor.id, "code.branch.push", {
      source: source.id,
      branch: source.branch,
      head,
    });
    revalidateCodePath(project.slug, source.id, relPath);
    return { ok: true, message: oneLine(pushed) || `Pushed ${source.branch} to origin.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Push failed") };
  }
}

export async function mergeCodeSource(input: MergeCodeSourceInput): Promise<CodeActionResult> {
  try {
    const actor = await requireHumanActor();
    const { project, source, sources, relPath } = await resolveActionSource(actor, input);
    const targetBranch = input.targetBranch.trim() || "main";
    if (source.branch === targetBranch) throw new Error("Selected source is already the target branch.");
    const target = sources.find((item) => item.branch === targetBranch);
    if (!target) throw new Error(`No local ${targetBranch} worktree is available.`);

    const sourceStatus = await statusLines(source.path);
    if (sourceStatus.length > 0) throw new Error("Commit or discard source changes before merging.");
    const targetStatus = await statusLines(target.path);
    if (targetStatus.length > 0) throw new Error(`Commit or discard ${targetBranch} changes before merging.`);

    const sourceHead = await gitText(source.path, ["rev-parse", "HEAD"]);
    const mergeMessage = `Merge ${source.branch} into ${targetBranch}`;
    const merged = await git(target.path, ["merge", "--no-ff", sourceHead, "-m", mergeMessage], {
      env: gitIdentityEnv(actor),
      timeout: 60_000,
    });
    const targetHead = await gitText(target.path, ["rev-parse", "--short", "HEAD"]).catch(() => target.head);
    await logCodeActivity(project.id, actor.id, "code.branch.merge", {
      source: source.id,
      sourceBranch: source.branch,
      sourceHead,
      target: target.id,
      targetBranch,
      targetHead,
    });
    revalidateCodePath(project.slug, source.id, relPath);
    revalidatePath(`/projects/${project.slug}/code?source=${target.id}`);
    return { ok: true, message: oneLine(merged) || `Merged ${source.branch} into ${targetBranch}.` };
  } catch (error) {
    return { ok: false, message: errorMessage(error, "Merge failed") };
  }
}

async function requireHumanActor() {
  const viewer = await requireViewer();
  if (!viewer.isOwner) throw new Error("Forbidden");
  const user = await db.user.findUnique({
    where: { id: viewer.id },
    select: { name: true, email: true },
  });
  return {
    ...viewer,
    name: user?.name || user?.email || viewer.username,
    email: user?.email || `${viewer.username}@local.pm`,
  };
}

async function resolveActionSource(viewer: Viewer, input: CodeActionInput) {
  const slug = input.slug.trim();
  if (!slug) throw new Error("Project slug is required.");
  await requireProjectAccess(viewer, { slug });
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    select: { id: true, slug: true, repositoryPath: true },
  });
  if (!project?.repositoryPath) throw new Error("Project repository folder is not set.");
  const sources = await listCodeSources(project.repositoryPath);
  const source = chooseCodeSource(sources, input.sourceId);
  if (!source) throw new Error("Selected source is not available.");
  const relPath = normalizeRepoRelativePath(input.path);
  return { project, sources, source, relPath };
}

async function statusLines(repoPath: string) {
  const status = await gitText(repoPath, ["status", "--porcelain"]);
  return status.split("\n").filter(Boolean);
}

async function gitText(repoPath: string, args: string[], opts: GitOptions = {}) {
  const out = await git(repoPath, args, opts);
  return out.trim();
}

type GitOptions = {
  env?: Record<string, string>;
  timeout?: number;
};

async function git(repoPath: string, args: string[], opts: GitOptions = {}) {
  const { stdout } = await execFile("git", ["-C", repoPath, ...args], {
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: opts.timeout ?? 15_000,
  });
  return stdout.trim();
}

async function gitQuiet(repoPath: string, args: string[]) {
  try {
    await git(repoPath, args);
    return true;
  } catch {
    return false;
  }
}

function gitIdentityEnv(actor: { name: string; email: string }): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: actor.name,
    GIT_AUTHOR_EMAIL: actor.email,
    GIT_COMMITTER_NAME: actor.name,
    GIT_COMMITTER_EMAIL: actor.email,
  };
}

async function logCodeActivity(projectId: string, userId: string, kind: string, payload: Record<string, unknown>) {
  await db.activityLog.create({
    data: {
      projectId,
      userId,
      kind,
      payload: JSON.stringify(payload),
    },
  }).catch(() => null);
}

function revalidateCodePath(slug: string, sourceId: string, relPath: string) {
  const params = new URLSearchParams({ source: sourceId });
  if (relPath) params.set("path", relPath);
  revalidatePath(`/projects/${slug}/code?${params.toString()}`);
  revalidatePath(`/projects/${slug}/code`);
}

function errorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const details = (error as Error & { stderr?: string }).stderr?.trim();
  return details || error.message || fallback;
}

function oneLine(value: string) {
  return value.split("\n").find(Boolean)?.trim() ?? "";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
