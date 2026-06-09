import { execFile as execFileCb } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { displayWorktreesForRepo, worktreeRepoKey } from "@/lib/deploy/repo-key";
import { readSwitchState } from "@/lib/deploy/worktrees";

const execFile = promisify(execFileCb);
const MAX_FILE_BYTES = 700 * 1024;
// Images get a more generous cap than text since screenshots routinely exceed
// the text preview limit; they stream as bytes rather than into the editor.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const HIDDEN_BROWSER_NAMES = new Set([".git", ".next", "node_modules"]);

export type CodeSource = {
  id: string;
  label: string;
  path: string;
  branch: string;
  head: string;
  served: boolean;
};

export type RepoEntry = {
  name: string;
  path: string;
  type: "dir" | "file" | "symlink" | "other";
  size: number | null;
  updatedAt: string | null;
};

export type BlameLine = {
  line: number;
  commit: string;
  author: string;
  authorTime: string | null;
  summary: string | null;
  content: string;
};

export type FileView =
  | { kind: "text"; content: string; size: number; blame: BlameLine[] | null; blameError: string | null }
  | { kind: "image"; size: number; mime: string }
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number; maxSize: number }
  | { kind: "not-file" };

// Raster image types we preview inline via an <img> pointing at the raw
// endpoint. SVG is intentionally excluded: it is text, so it renders in the
// editor AND gets a preview rendered from its own source.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export function imageMimeForPath(relPath: string): string | null {
  const ext = relPath.toLowerCase().split(".").at(-1) ?? "";
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

export type CodeGitState = {
  targetBranch: string;
  targetSourceId: string | null;
  sourceBranch: string;
  sourceHead: string;
  sourceDirty: boolean;
  sourceStatusCount: number;
  targetDirty: boolean;
  targetStatusCount: number;
  compareUrl: string | null;
  originLabel: string | null;
  canOpenPullRequest: boolean;
  canMerge: boolean;
  mergeBlockedReason: string | null;
  error: string | null;
};

export function normalizeRepoRelativePath(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.includes("\0")) return "";
  const normalized = path.posix.normalize(`/${raw.replaceAll("\\", "/")}`).slice(1);
  return normalized === "." || normalized.startsWith("../") ? "" : normalized;
}

export function resolveInside(root: string, relPath: string): string | null {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relPath);
  if (target === rootAbs || target.startsWith(`${rootAbs}${path.sep}`)) return target;
  return null;
}

export async function listCodeSources(repositoryPath: string | null | undefined): Promise<CodeSource[]> {
  if (!repositoryPath) return [];
  const repoKey = worktreeRepoKey(repositoryPath);
  const state = await readSwitchState();
  const sources =
    state.available && repoKey
      ? displayWorktreesForRepo(state.worktrees, repoKey).map((w) => ({
          id: w.name,
          label: w.name,
          path: w.path,
          branch: w.branch,
          head: w.head,
          served: w.served,
        }))
      : [];

  if (sources.length > 0) return dedupeSources(sources);

  const discovered = await discoverFilesystemSources(repositoryPath);
  if (discovered.length > 0) return dedupeSources(discovered);

  const fallbackPath = repositoryPath.replace(/\/+$/, "");
  return [
    {
      id: "repository",
      label: path.basename(fallbackPath) || fallbackPath,
      path: fallbackPath,
      branch: await gitText(fallbackPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "unknown"),
      head: await gitText(fallbackPath, ["rev-parse", "--short", "HEAD"]).catch(() => "unknown"),
      served: false,
    },
  ];
}

async function discoverFilesystemSources(repositoryPath: string): Promise<CodeSource[]> {
  const fallbackPath = repositoryPath.replace(/\/+$/, "");
  const worktreesDir = `${fallbackPath}.worktrees`;
  const candidatePaths = [fallbackPath];
  const siblingNames = await readdir(worktreesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of siblingNames) {
    if (entry.isDirectory()) candidatePaths.push(path.join(worktreesDir, entry.name));
  }

  const candidates = await Promise.all(
    candidatePaths.map(async (candidatePath): Promise<CodeSource | null> => {
      const branch = await gitText(candidatePath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
      if (!branch || branch === "HEAD") return null;
      return {
        id: path.basename(candidatePath) || "repository",
        label: path.basename(candidatePath) || candidatePath,
        path: candidatePath,
        branch,
        head: await gitText(candidatePath, ["rev-parse", "--short", "HEAD"]).catch(() => "unknown"),
        served: false,
      } satisfies CodeSource;
    }),
  );

  const repoKey = worktreeRepoKey(fallbackPath);
  const liveCandidates = candidates.filter((source): source is CodeSource => source !== null);
  return repoKey
    ? displayWorktreesForRepo(liveCandidates, repoKey)
    : [];
}

export function chooseCodeSource(sources: CodeSource[], requested: string | string[] | undefined): CodeSource | null {
  if (sources.length === 0) return null;
  const id = Array.isArray(requested) ? requested[0] : requested;
  return sources.find((source) => source.id === id || source.path === id)
    ?? sources.find((source) => source.served)
    ?? sources.find((source) => source.branch === "main")
    ?? sources[0];
}

export async function listRepositoryDirectory(source: CodeSource, relPath: string): Promise<RepoEntry[]> {
  const gitEntries = await gitListDirectory(source, relPath);
  if (gitEntries) return gitEntries;

  const abs = resolveInside(source.path, relPath);
  if (!abs) return [];
  const rows = await readdir(abs, { withFileTypes: true }).catch(() => []);
  const entries = await Promise.all(
    rows
      .filter((entry) => !HIDDEN_BROWSER_NAMES.has(entry.name))
      .map(async (entry) => {
        const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        const childAbs = path.join(abs, entry.name);
        const st = await lstat(childAbs).catch(() => null);
        return {
          name: entry.name,
          path: childRel,
          type: entry.isDirectory()
            ? "dir"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
          size: st && entry.isFile() ? st.size : null,
          updatedAt: st ? st.mtime.toISOString() : null,
        } satisfies RepoEntry;
      }),
  );
  return entries.sort((a, b) => {
    const group = entryGroup(a.type) - entryGroup(b.type);
    if (group !== 0) return group;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export async function pathKind(source: CodeSource, relPath: string): Promise<"dir" | "file" | "other" | "missing"> {
  const gitKind = await gitPathKind(source.path, relPath);
  if (gitKind) return gitKind;

  const abs = resolveInside(source.path, relPath);
  if (!abs) return "missing";
  const st = await lstat(abs).catch(() => null);
  if (!st) return "missing";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

export async function readRepositoryFile(source: CodeSource, relPath: string, includeBlame: boolean): Promise<FileView> {
  const gitFile = await readGitFile(source, relPath, includeBlame);
  if (gitFile) return gitFile;

  const abs = resolveInside(source.path, relPath);
  if (!abs) return { kind: "not-file" };
  const st = await lstat(abs).catch(() => null);
  if (!st || !st.isFile()) return { kind: "not-file" };
  const imageMime = imageMimeForPath(relPath);
  if (imageMime) {
    if (st.size > MAX_IMAGE_BYTES) return { kind: "too-large", size: st.size, maxSize: MAX_IMAGE_BYTES };
    return { kind: "image", size: st.size, mime: imageMime };
  }
  if (st.size > MAX_FILE_BYTES) return { kind: "too-large", size: st.size, maxSize: MAX_FILE_BYTES };
  const buf = await readFile(abs);
  if (buf.includes(0)) return { kind: "binary", size: st.size };
  const content = buf.toString("utf8");
  if (!includeBlame) return { kind: "text", content, size: st.size, blame: null, blameError: null };
  const blame = await blameFile(source.path, relPath);
  return {
    kind: "text",
    content,
    size: st.size,
    blame: blame.ok ? blame.lines : null,
    blameError: blame.ok ? null : blame.error,
  };
}

// Raw image bytes for the inline <img> preview. Prefers the working-tree file
// on disk and falls back to the git blob. Returns null for non-images, missing
// files, or anything above the image cap.
export async function readRepositoryImageBytes(
  source: CodeSource,
  relPath: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const mime = imageMimeForPath(relPath);
  if (!mime) return null;

  const abs = resolveInside(source.path, relPath);
  if (abs) {
    const st = await lstat(abs).catch(() => null);
    if (st?.isFile() && st.size <= MAX_IMAGE_BYTES) {
      const bytes = await readFile(abs).catch(() => null);
      if (bytes) return { bytes, mime };
    }
  }

  const sizeRaw = await gitText(source.path, ["cat-file", "-s", gitObjectSpec(relPath)]).catch(() => "");
  const size = Number(sizeRaw);
  if (Number.isFinite(size) && size <= MAX_IMAGE_BYTES) {
    const buf = await gitBuffer(source.path, ["show", gitObjectSpec(relPath)]).catch(() => null);
    if (buf) return { bytes: buf, mime };
  }
  return null;
}

export async function canReadRepository(repositoryPath: string): Promise<boolean> {
  const isGit = await gitText(repositoryPath, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
  if (isGit === "true") return true;
  try {
    await access(repositoryPath, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function getCodeGitState(
  source: CodeSource,
  sources: CodeSource[],
  targetBranch: string,
): Promise<CodeGitState> {
  const normalizedTarget = targetBranch.trim() || "main";
  const targetSource = sources.find((item) => item.branch === normalizedTarget) ?? null;
  const originUrl = await gitText(source.path, ["remote", "get-url", "origin"]).catch(() => "");
  const sourceHead = await gitText(source.path, ["rev-parse", "--short", "HEAD"]).catch(() => source.head);
  const sourceStatus = await gitStatusLines(source.path).catch(() => []);
  const targetStatus = targetSource
    ? await gitStatusLines(targetSource.path).catch(() => [])
    : [];
  const compareUrl = originUrl ? compareUrlForOrigin(originUrl, normalizedTarget, source.branch) : null;
  const sourceDirty = sourceStatus.length > 0;
  const targetDirty = targetStatus.length > 0;
  const sameBranch = source.branch === normalizedTarget;
  const missingTarget = !targetSource;
  const mergeBlockedReason =
    sameBranch
      ? "Selected source is already the target branch."
      : missingTarget
        ? `No local ${normalizedTarget} worktree is available.`
        : sourceDirty
          ? "Commit or discard source changes before merging."
          : targetDirty
            ? `Commit or discard ${normalizedTarget} changes before merging.`
            : null;

  return {
    targetBranch: normalizedTarget,
    targetSourceId: targetSource?.id ?? null,
    sourceBranch: source.branch,
    sourceHead,
    sourceDirty,
    sourceStatusCount: sourceStatus.length,
    targetDirty,
    targetStatusCount: targetStatus.length,
    compareUrl,
    originLabel: originUrl ? originLabel(originUrl) : null,
    canOpenPullRequest: Boolean(compareUrl && !sameBranch),
    canMerge: mergeBlockedReason === null,
    mergeBlockedReason,
    error: null,
  };
}

async function gitListDirectory(source: CodeSource, relPath: string): Promise<RepoEntry[] | null> {
  const kind = await gitPathKind(source.path, relPath);
  if (kind !== "dir") return null;

  try {
    const { stdout } = await execFile(
      "git",
      ["-C", source.path, "ls-tree", "-z", "-l", gitObjectSpec(relPath)],
      { maxBuffer: 12 * 1024 * 1024, timeout: 8_000 },
    );
    const entries = stdout
      .split("\0")
      .flatMap((line): RepoEntry[] => {
        if (!line) return [];
        const parsed = parseLsTreeLine(line);
        if (!parsed || HIDDEN_BROWSER_NAMES.has(parsed.name)) return [];
        return [{
          name: parsed.name,
          path: relPath ? `${relPath}/${parsed.name}` : parsed.name,
          type: parsed.type,
          size: parsed.size,
          updatedAt: null,
        }];
      });
    return entries.sort((a, b) => {
      const group = entryGroup(a.type) - entryGroup(b.type);
      if (group !== 0) return group;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  } catch {
    return null;
  }
}

async function readGitFile(source: CodeSource, relPath: string, includeBlame: boolean): Promise<FileView | null> {
  if (!relPath) return null;
  const kind = await gitPathKind(source.path, relPath);
  if (kind === "missing") return null;
  if (kind !== "file") return { kind: "not-file" };

  const sizeRaw = await gitText(source.path, ["cat-file", "-s", gitObjectSpec(relPath)]).catch(() => "");
  const size = Number(sizeRaw);
  if (!Number.isFinite(size)) return null;

  const imageMime = imageMimeForPath(relPath);
  if (imageMime) {
    if (size > MAX_IMAGE_BYTES) return { kind: "too-large", size, maxSize: MAX_IMAGE_BYTES };
    return { kind: "image", size, mime: imageMime };
  }

  if (size > MAX_FILE_BYTES) return { kind: "too-large", size, maxSize: MAX_FILE_BYTES };

  const buf = await gitBuffer(source.path, ["show", gitObjectSpec(relPath)]).catch(() => null);
  if (!buf) return null;
  if (buf.includes(0)) return { kind: "binary", size };
  const content = buf.toString("utf8");
  if (!includeBlame) return { kind: "text", content, size, blame: null, blameError: null };
  const blame = await blameFile(source.path, relPath);
  return {
    kind: "text",
    content,
    size,
    blame: blame.ok ? blame.lines : null,
    blameError: blame.ok ? null : blame.error,
  };
}

async function gitPathKind(repoPath: string, relPath: string): Promise<"dir" | "file" | "other" | "missing" | null> {
  const objectType = await gitText(repoPath, ["cat-file", "-t", gitObjectSpec(relPath)]).catch(() => null);
  if (!objectType) return null;
  if (objectType === "tree") return "dir";
  if (objectType === "blob") return "file";
  if (objectType === "commit") return "other";
  return "missing";
}

function parseLsTreeLine(line: string): Pick<RepoEntry, "name" | "type" | "size"> | null {
  const match = line.match(/^(\d{6})\s+(blob|tree|commit)\s+[0-9a-f]{40}\s+(-|\d+)\t(.+)$/s);
  if (!match) return null;
  const [, mode, objectType, sizeRaw, name] = match;
  return {
    name,
    type: objectType === "tree"
      ? "dir"
      : mode === "120000"
        ? "symlink"
        : objectType === "blob"
          ? "file"
          : "other",
    size: sizeRaw === "-" ? null : Number(sizeRaw),
  };
}

function gitObjectSpec(relPath: string) {
  return `HEAD:${relPath}`;
}

async function blameFile(repoPath: string, relPath: string): Promise<{ ok: true; lines: BlameLine[] } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFile(
      "git",
      ["-C", repoPath, "blame", "--line-porcelain", "--", relPath],
      { maxBuffer: 12 * 1024 * 1024, timeout: 8_000 },
    );
    return { ok: true, lines: parseBlame(stdout) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "git blame failed" };
  }
}

function parseBlame(raw: string): BlameLine[] {
  const lines: BlameLine[] = [];
  let current = {
    commit: "",
    author: "",
    authorTime: null as string | null,
    summary: null as string | null,
  };

  for (const line of raw.split("\n")) {
    const header = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
    if (header) {
      current = {
        commit: header[1].slice(0, 10),
        author: "",
        authorTime: null,
        summary: null,
      };
      continue;
    }
    if (line.startsWith("author ")) {
      current.author = line.slice("author ".length);
      continue;
    }
    if (line.startsWith("author-time ")) {
      const seconds = Number(line.slice("author-time ".length));
      current.authorTime = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
      continue;
    }
    if (line.startsWith("summary ")) {
      current.summary = line.slice("summary ".length);
      continue;
    }
    if (line.startsWith("\t")) {
      lines.push({
        line: lines.length + 1,
        commit: current.commit,
        author: current.author || "unknown",
        authorTime: current.authorTime,
        summary: current.summary,
        content: line.slice(1),
      });
    }
  }

  return lines;
}

async function gitText(repoPath: string, args: string[]) {
  const { stdout } = await execFile("git", ["-C", repoPath, ...args], { timeout: 3_000 });
  return stdout.trim();
}

async function gitStatusLines(repoPath: string) {
  const status = await gitText(repoPath, ["status", "--porcelain"]);
  return status.split("\n").filter(Boolean);
}

function gitBuffer(repoPath: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFileCb(
      "git",
      ["-C", repoPath, ...args],
      { encoding: "buffer", maxBuffer: MAX_FILE_BYTES + 1024, timeout: 8_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function dedupeSources(sources: CodeSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.path.replace(/\/+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function entryGroup(type: RepoEntry["type"]) {
  if (type === "dir") return 0;
  if (type === "file") return 1;
  if (type === "symlink") return 2;
  return 3;
}

function compareUrlForOrigin(originUrl: string, targetBranch: string, sourceBranch: string) {
  const webUrl = webRemoteUrl(originUrl);
  if (!webUrl) return null;
  const source = encodeURIComponent(sourceBranch);
  const target = encodeURIComponent(targetBranch);
  if (webUrl.includes("github.com/")) return `${webUrl}/compare/${target}...${source}`;
  if (webUrl.includes("bitbucket.org/")) return `${webUrl}/pull-requests/new?source=${source}&dest=${target}`;
  return webUrl;
}

function originLabel(originUrl: string) {
  return webRemoteUrl(originUrl)?.replace(/^https?:\/\//, "") ?? originUrl;
}

function webRemoteUrl(originUrl: string) {
  const clean = originUrl.trim().replace(/\.git$/, "");
  const scpLike = clean.match(/^git@([^:]+):(.+)$/);
  if (scpLike) return `https://${scpLike[1]}/${scpLike[2]}`;
  const sshUrl = clean.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshUrl) return `https://${sshUrl[1]}/${sshUrl[2]}`;
  if (clean.startsWith("https://") || clean.startsWith("http://")) return clean;
  return null;
}
