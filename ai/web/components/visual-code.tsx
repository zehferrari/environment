"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import Editor, {
  loader,
  type Monaco,
  type OnMount,
} from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import { SyntaxLine } from "@/components/code-syntax";
import { renderFullMarkdown } from "@/lib/markdown";
import {
  commitCodeFile,
  mergeCodeSource,
  pushCodeSource,
  saveCodeFile,
  type CodeActionResult,
} from "@/lib/projects/code-actions";
import type {
  BlameLine,
  CodeGitState,
  CodeSource,
  FileView,
  RepoEntry,
} from "@/lib/projects/repo-code";

loader.config({ monaco: monacoEditor });

type VisualCodeProps = {
  activePath: string;
  browserPath: string;
  canWrite: boolean;
  canEditFile: boolean;
  canWriteReason?: string | null;
  entries: RepoEntry[];
  file: FileView | null;
  git: CodeGitState;
  kind: "dir" | "file" | "other" | "missing";
  relPath: string;
  showBlame: boolean;
  slug: string;
  source: CodeSource;
  sources: CodeSource[];
};

export default function VisualCode({
  activePath,
  browserPath,
  canWrite,
  canEditFile,
  canWriteReason = null,
  entries,
  file,
  git,
  kind,
  relPath,
  showBlame,
  slug,
  source,
  sources,
}: VisualCodeProps) {
  const router = useRouter();
  const [content, setContent] = useState(file?.kind === "text" ? file.content : "");
  const [savedContent, setSavedContent] = useState(file?.kind === "text" ? file.content : "");
  const [commitMessage, setCommitMessage] = useState(defaultCommitMessage(relPath));
  const [notice, setNotice] = useState<CodeActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const editable = canWrite && canEditFile && kind === "file" && file?.kind === "text" && !showBlame;
  const dirty = editable && content !== savedContent;

  useEffect(() => {
    const nextContent = file?.kind === "text" ? file.content : "";
    setContent(nextContent);
    setSavedContent(nextContent);
    setCommitMessage(defaultCommitMessage(relPath));
    setNotice(null);
  }, [file, relPath]);

  function runAction(action: () => Promise<CodeActionResult>, after?: (result: CodeActionResult) => void) {
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      after?.(result);
      if (result.ok) router.refresh();
    });
  }

  function save() {
    if (!editable) return;
    runAction(
      () => saveCodeFile({ slug, sourceId: source.id, path: relPath, content }),
      (result) => {
        if (result.ok) setSavedContent(content);
      },
    );
  }

  function commit() {
    runAction(() => commitCodeFile({
      slug,
      sourceId: source.id,
      path: relPath,
      message: commitMessage,
    }));
  }

  function push() {
    runAction(() => pushCodeSource({ slug, sourceId: source.id, path: relPath }));
  }

  function merge() {
    runAction(() => mergeCodeSource({
      slug,
      sourceId: source.id,
      path: relPath,
      targetBranch: git.targetBranch,
    }));
  }

  return (
    <section className="flex h-[calc(100vh-11rem)] min-h-[40rem] flex-col overflow-hidden rounded-lg border border-line bg-panel text-text shadow-sm">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel-soft px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-caption text-text-muted">
              {source.label} / {browserPath || relPath || ""}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-2 font-mono text-nano uppercase tracking-wider text-text-dim">
              <span>{source.branch} · {git.sourceHead}</span>
              {git.sourceDirty ? <span>{git.sourceStatusCount} changed</span> : <span>clean</span>}
              {source.served ? <span>live</span> : null}
              {git.error ? <span className="text-warn">{git.error}</span> : null}
            </div>
          </div>
          <GitActions
            canWrite={canWrite}
            canEditFile={canEditFile}
            canWriteReason={canWriteReason}
            commit={commit}
            commitMessage={commitMessage}
            dirty={dirty}
            editable={editable}
            git={git}
            merge={merge}
            pending={pending}
            push={push}
            relPath={relPath}
            save={save}
            setCommitMessage={setCommitMessage}
            slug={slug}
            source={source}
            sources={sources}
            showBlame={showBlame}
          />
        </div>

        {notice ? (
          <div
            className={`border-b px-3 py-2 text-body ${
              notice.ok
                ? "border-ok/30 bg-ok/10 text-ok"
                : "border-crit/30 bg-crit/10 text-crit"
            }`}
          >
            {notice.message}
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[3rem_minmax(14rem,18rem)_minmax(0,1fr)] overflow-x-auto">
          <div className="border-r border-line bg-bg-elev">
            <div className="flex h-12 items-center justify-center border-l-2 border-accent text-icon-lg text-text-muted">
              ⧉
            </div>
          </div>

          <aside className="flex min-w-0 flex-col border-r border-line bg-panel-soft">
            <div className="flex h-9 shrink-0 items-center border-b border-line px-3 text-nano font-semibold uppercase tracking-wider text-text-muted">
              Explorer
            </div>
            <Breadcrumbs slug={slug} source={source} relPath={browserPath} showBlame={showBlame} />
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {browserPath ? (
                <EntryLink
                  slug={slug}
                  source={source}
                  entry={{ name: "..", path: parentPath(browserPath), type: "dir", size: null, updatedAt: null }}
                  active={false}
                  showBlame={showBlame}
                />
              ) : null}
              {entries.length === 0 ? (
                <p className="px-3 py-8 text-center text-caption text-text-muted">
                  No files in this folder.
                </p>
              ) : (
                entries.map((entry) => (
                  <EntryLink
                    key={entry.path}
                    slug={slug}
                    source={source}
                    entry={entry}
                    active={entry.path === activePath}
                    showBlame={showBlame}
                  />
                ))
              )}
            </div>
          </aside>

          <EditorPane
            content={content}
            file={file}
            kind={kind}
            relPath={relPath}
            setContent={setContent}
            showBlame={showBlame}
            slug={slug}
            source={source}
          />
        </div>

        <div className="flex h-6 items-center justify-between bg-accent px-3 font-mono text-nano text-bg">
          <span>{source.served ? "Live" : "Source"}: {source.branch}</span>
          <span>{kind === "file" && file && "size" in file ? formatBytes(file.size) : "Ready"}</span>
        </div>
      </div>
    </section>
  );
}

function GitActions({
  canWrite,
  canEditFile,
  canWriteReason,
  commit,
  commitMessage,
  dirty,
  editable,
  git,
  merge,
  pending,
  push,
  relPath,
  save,
  setCommitMessage,
  slug,
  source,
  sources,
  showBlame,
}: {
  canWrite: boolean;
  canEditFile: boolean;
  canWriteReason?: string | null;
  commit: () => void;
  commitMessage: string;
  dirty: boolean;
  editable: boolean;
  git: CodeGitState;
  merge: () => void;
  pending: boolean;
  push: () => void;
  relPath: string;
  save: () => void;
  setCommitMessage: (value: string) => void;
  slug: string;
  source: CodeSource;
  sources: CodeSource[];
  showBlame: boolean;
}) {
  const router = useRouter();
  const blocked = !canWrite ? (canWriteReason ?? "Code actions are not available for this file.") : null;
  const commitBlocked =
    blocked ??
    (!relPath ? "Choose a file to commit." : null) ??
    (dirty ? "Save the editor before committing." : null);
  const branchBlocked =
    blocked ??
    (dirty ? "Save and commit editor changes before branch actions." : null);
  const mergeBlocked = branchBlocked ?? git.mergeBlockedReason;

  return (
    <div className="flex min-w-[22rem] flex-wrap items-center justify-end gap-2 text-caption">
      <select
        value={source.id}
        onChange={(event) => router.push(codeHref(slug, event.target.value, relPath, showBlame))}
        disabled={pending}
        title="Worktree source / branch"
        className="h-8 max-w-[16rem] rounded-md border border-line bg-bg px-2 text-micro outline-none focus:border-accent disabled:opacity-45"
      >
        {sources.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label} · {item.branch} · {item.head}
            {item.served ? " · live" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={save}
        disabled={!editable || !dirty || pending}
        className="rounded-md border border-line bg-panel px-2.5 py-1.5 font-medium text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
        title={!editable ? (!canEditFile ? (canWriteReason ?? "Open a writable text file to edit.") : (blocked ?? "Open a text file without blame mode to edit.")) : undefined}
      >
        Save
      </button>
      <input
        value={commitMessage}
        onChange={(event) => setCommitMessage(event.target.value)}
        disabled={!canWrite || pending}
        className="h-8 w-56 rounded-md border border-line bg-bg px-2 font-mono text-micro outline-none focus:border-accent disabled:opacity-45"
        placeholder="Commit message"
      />
      <button
        type="button"
        onClick={commit}
        disabled={Boolean(commitBlocked) || pending}
        className="rounded-md border border-line bg-panel px-2.5 py-1.5 font-medium text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
        title={commitBlocked ?? undefined}
      >
        Commit
      </button>
      <button
        type="button"
        onClick={push}
        disabled={Boolean(branchBlocked) || pending}
        className="rounded-md border border-line bg-panel px-2.5 py-1.5 font-medium text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
        title={branchBlocked ?? undefined}
      >
        Push
      </button>
      {git.canOpenPullRequest && git.compareUrl && !branchBlocked ? (
        <a
          href={git.compareUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-line bg-panel px-2.5 py-1.5 font-medium text-text hover:border-accent hover:text-accent"
        >
          Pull request
        </a>
      ) : (
        <button
          type="button"
          disabled
          className="rounded-md border border-line bg-panel px-2.5 py-1.5 font-medium text-text-muted opacity-45"
          title={branchBlocked ?? (git.canOpenPullRequest ? undefined : "Pull request is only available from a non-target branch with a supported origin.")}
        >
          Pull request
        </button>
      )}
      <button
        type="button"
        onClick={merge}
        disabled={Boolean(mergeBlocked) || pending}
        className="rounded-md border border-line bg-panel px-2.5 py-1.5 font-medium text-text hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
        title={mergeBlocked ?? undefined}
      >
        Merge to {git.targetBranch}
      </button>
    </div>
  );
}

function EditorPane({
  content,
  file,
  kind,
  relPath,
  setContent,
  showBlame,
  slug,
  source,
}: {
  content: string;
  file: FileView | null;
  kind: "dir" | "file" | "other" | "missing";
  relPath: string;
  setContent: (value: string) => void;
  showBlame: boolean;
  slug: string;
  source: CodeSource;
}) {
  const lowerRelPath = relPath.toLowerCase();
  const isSvg = lowerRelPath.endsWith(".svg");
  const isMarkdown = lowerRelPath.endsWith(".md") || lowerRelPath.endsWith(".markdown");
  return (
    <main className="flex h-full min-w-[42rem] flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center border-b border-line bg-panel">
        {kind === "file" && relPath ? (
          <div className="flex h-full min-w-0 items-center border-r border-line bg-panel px-3">
            <span className="min-w-0 truncate font-mono text-caption text-text">{relPath}</span>
          </div>
        ) : (
          <div className="px-3 font-mono text-caption text-text-muted">Welcome</div>
        )}
        <div className="flex-1" />
        {file?.kind === "text" ? (
          <Link
            href={codeHref(slug, source.id, relPath, !showBlame)}
            className={`mr-2 rounded border px-2 py-1 text-nano font-semibold uppercase tracking-wider transition ${
              showBlame
                ? "border-accent text-accent"
                : "border-line text-text-muted hover:border-accent hover:text-accent"
            }`}
          >
            {showBlame ? "Hide blame" : "Show blame"}
          </Link>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {kind !== "file" || !file ? (
          <EmptyEditor kind={kind} />
        ) : file.kind === "text" ? (
          showBlame && file.blame ? (
            <BlameEditor rows={file.blame} relPath={relPath} />
          ) : isSvg ? (
            <SvgEditor content={content} relPath={relPath} setContent={setContent} />
          ) : isMarkdown ? (
            <MarkdownEditor content={content} relPath={relPath} setContent={setContent} />
          ) : (
            <MonacoCodeEditor content={content} relPath={relPath} setContent={setContent} />
          )
        ) : file.kind === "image" ? (
          <ImagePreview
            slug={slug}
            sourceId={source.id}
            relPath={relPath}
            showBlame={showBlame}
            size={file.size}
          />
        ) : file.kind === "binary" ? (
          <EditorMessage>Binary file preview is not available.</EditorMessage>
        ) : file.kind === "too-large" ? (
          <EditorMessage>
            File is {formatBytes(file.size)}, above the {formatBytes(file.maxSize)} preview limit.
          </EditorMessage>
        ) : (
          <EditorMessage>This path is not a regular file.</EditorMessage>
        )}
        {file?.kind === "text" && file.blameError ? (
          <p className="border-t border-line bg-warn/10 px-card py-control-y text-caption text-warn">
            Blame unavailable: {file.blameError}
          </p>
        ) : null}
      </div>
    </main>
  );
}

function MonacoCodeEditor({
  content,
  relPath,
  setContent,
}: {
  content: string;
  relPath: string;
  setContent: (value: string) => void;
}) {
  const monacoRef = useRef<Monaco | null>(null);
  const modelPath = useMemo(() => `file:///${relPath || "untitled"}`, [relPath]);

  const beforeMount = (monaco: Monaco) => {
    defineAppTheme(monaco);
  };
  const onMount: OnMount = (_editor, monaco) => {
    monacoRef.current = monaco;
    defineAppTheme(monaco);
    monaco.editor.setTheme("pm-app");
  };

  useEffect(() => {
    const refresh = () => {
      if (!monacoRef.current) return;
      defineAppTheme(monacoRef.current);
      monacoRef.current.editor.setTheme("pm-app");
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    media.addEventListener("change", refresh);
    refresh();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", refresh);
    };
  }, []);

  return (
    <div className="h-full min-h-[20rem] border-0">
      <Editor
        beforeMount={beforeMount}
        height="100%"
        language={monacoLanguageForPath(relPath)}
        loading={<EditorMessage>Loading editor...</EditorMessage>}
        onChange={(value) => setContent(value ?? "")}
        onMount={onMount}
        options={{
          automaticLayout: true,
          cursorBlinking: "smooth",
          fontFamily: "var(--font-mono)",
          fontLigatures: true,
          fontSize: 12,
          lineHeight: 20,
          minimap: { enabled: false },
          overviewRulerBorder: false,
          renderLineHighlight: "all",
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: "off",
        }}
        path={modelPath}
        theme="pm-app"
        value={content}
        width="100%"
      />
    </div>
  );
}

function ImagePreview({
  slug,
  sourceId,
  relPath,
  showBlame,
  size,
}: {
  slug: string;
  sourceId: string;
  relPath: string;
  showBlame: boolean;
  size: number;
}) {
  // The blame param is irrelevant to the bytes; keep it off the raw URL.
  void showBlame;
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-bg-elev p-6">
      <div className="rounded-lg border border-line bg-[repeating-conic-gradient(var(--color-panel-soft)_0_25%,transparent_0_50%)] bg-[length:20px_20px] p-3 shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={rawImageHref(slug, sourceId, relPath)}
          alt={relPath}
          className="max-h-[70vh] max-w-full object-contain"
        />
      </div>
      <div className="font-mono text-nano uppercase tracking-wider text-text-muted">
        {relPath.split("/").at(-1)} · {formatBytes(size)}
      </div>
    </div>
  );
}

function MarkdownEditor({
  content,
  relPath,
  setContent,
}: {
  content: string;
  relPath: string;
  setContent: (value: string) => void;
}) {
  return (
    <div className="grid h-full min-h-[24rem] grid-rows-[minmax(16rem,1fr)_minmax(14rem,0.8fr)] lg:grid-cols-2 lg:grid-rows-1">
      <div className="overflow-auto border-b border-line bg-bg-elev p-6 lg:border-b-0 lg:border-r">
        <div className="mx-auto max-w-3xl rounded-panel border border-line bg-panel px-page-x py-page-y shadow-sm">
          <div className="mb-4 border-b border-line pb-3 text-nano font-semibold uppercase tracking-wider text-text-muted">
            Markdown preview · {relPath.split("/").at(-1)}
          </div>
          <div className="md" dangerouslySetInnerHTML={renderFullMarkdown(content)} />
        </div>
      </div>
      <div className="min-h-0">
        <MonacoCodeEditor content={content} relPath={relPath} setContent={setContent} />
      </div>
    </div>
  );
}

function SvgEditor({
  content,
  relPath,
  setContent,
}: {
  content: string;
  relPath: string;
  setContent: (value: string) => void;
}) {
  // SVG is text, so show both: a rendered preview on top (from the live editor
  // content) and the editable source below.
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(content)}`;
  return (
    <div className="flex h-full min-h-[24rem] flex-col">
      <div className="flex h-56 shrink-0 items-center justify-center border-b border-line bg-[repeating-conic-gradient(var(--color-panel-soft)_0_25%,transparent_0_50%)] bg-[length:20px_20px] p-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={dataUrl} alt={relPath} className="max-h-full max-w-full object-contain" />
      </div>
      <div className="min-h-0 flex-1">
        <MonacoCodeEditor content={content} relPath={relPath} setContent={setContent} />
      </div>
    </div>
  );
}

function rawImageHref(slug: string, sourceId: string, relPath: string) {
  const params = new URLSearchParams();
  params.set("source", sourceId);
  params.set("path", relPath);
  return `/projects/${slug}/code/raw?${params.toString()}`;
}

function EmptyEditor({ kind }: { kind: "dir" | "file" | "other" | "missing" }) {
  return (
    <div className="flex min-h-[30rem] items-center justify-center px-page-x text-body text-text-muted">
      {kind === "dir" ? "Select a file to view its contents." : "No file selected."}
    </div>
  );
}

function EditorMessage({ children }: { children: ReactNode }) {
  return <p className="p-6 text-body text-text-muted">{children}</p>;
}

function EntryLink({
  slug,
  source,
  entry,
  active,
  showBlame,
}: {
  slug: string;
  source: CodeSource;
  entry: RepoEntry;
  active: boolean;
  showBlame: boolean;
}) {
  const icon = entry.type === "dir" ? "▸" : entry.type === "file" ? "•" : "◦";
  return (
    <Link
      href={codeHref(slug, source.id, entry.path, showBlame)}
      className={`grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-1 px-control-x py-control-y font-mono text-caption hover:bg-accent-soft ${
        active ? "bg-accent-soft text-accent" : "text-text"
      }`}
    >
      <span className={entry.type === "dir" ? "text-text-muted" : "text-accent"}>{icon}</span>
      <span className="min-w-0 truncate">{entry.name}</span>
      <span className="pl-2 text-nano tabular-nums text-text-muted">
        {entry.size === null ? "" : formatBytes(entry.size)}
      </span>
    </Link>
  );
}

function Breadcrumbs({
  slug,
  source,
  relPath,
  showBlame,
}: {
  slug: string;
  source: CodeSource;
  relPath: string;
  showBlame: boolean;
}) {
  const segments = relPath ? relPath.split("/") : [];
  let acc = "";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-line px-3 py-2 text-micro">
      <Link
        href={codeHref(slug, source.id, "", showBlame)}
        className="font-mono text-text-muted hover:text-text"
      >
        /
      </Link>
      {segments.map((segment) => {
        acc = acc ? `${acc}/${segment}` : segment;
        return (
          <Link
            key={acc}
            href={codeHref(slug, source.id, acc, showBlame)}
            className="min-w-0 truncate font-mono text-text-muted hover:text-text"
          >
            {segment}
          </Link>
        );
      })}
    </div>
  );
}

function BlameEditor({ rows, relPath }: { rows: BlameLine[]; relPath: string }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-left font-mono text-caption leading-5">
      <tbody>
        {rows.map((row) => (
          <tr key={row.line} className="hover:bg-accent-soft">
            <td className="sticky left-0 w-14 select-none bg-panel px-2 text-right text-nano tabular-nums text-text-muted">
              {row.line}
            </td>
            <td className="w-60 max-w-60 border-r border-line px-2 text-nano text-text-muted">
              <div className="truncate text-text" title={row.summary ?? undefined}>
                {row.author}
              </div>
              <div className="truncate">
                <code>{row.commit}</code>
                {row.authorTime ? ` · ${row.authorTime.slice(0, 10)}` : ""}
              </div>
            </td>
            <td className="min-w-full px-3">
              <pre className="whitespace-pre"><SyntaxLine line={row.content} path={relPath} /></pre>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function codeHref(slug: string, sourceId: string, relPath: string, blame: boolean) {
  const params = new URLSearchParams();
  params.set("source", sourceId);
  if (relPath) params.set("path", relPath);
  if (blame) params.set("blame", "1");
  return `/projects/${slug}/code?${params.toString()}`;
}

function parentPath(relPath: string) {
  const parent = relPath ? relPath.split("/").slice(0, -1).join("/") : "";
  return parent === "." ? "" : parent;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function defaultCommitMessage(relPath: string) {
  return relPath ? `Update ${relPath.split("/").at(-1)}` : "";
}

function monacoLanguageForPath(filePath: string) {
  const parts = filePath.toLowerCase().split("/");
  const filename = parts.at(-1) ?? "";
  const ext = filename.includes(".") ? filename.split(".").at(-1) ?? "" : "";
  if (["php", "php4", "php5", "phtml", "ctp"].includes(ext)) return "php";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
  if (["ts", "tsx"].includes(ext)) return "typescript";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["html", "htm"].includes(ext)) return "html";
  if (["xml", "svg"].includes(ext)) return "xml";
  if (["md", "mdx", "markdown"].includes(ext)) return "markdown";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["sh", "bash", "zsh", "fish"].includes(ext)) return "shell";
  if (["py"].includes(ext)) return "python";
  if (["sql"].includes(ext)) return "sql";
  if (["dockerfile", "makefile"].includes(filename)) return "shell";
  return "plaintext";
}

function defineAppTheme(monaco: Monaco) {
  const styles = getComputedStyle(document.documentElement);
  const bg = cssColor(styles, "--color-panel", "#ffffff");
  const fg = cssColor(styles, "--color-text", "#111827");
  const muted = cssColor(styles, "--color-text-muted", "#64748b");
  const line = cssColor(styles, "--color-line", "#e5e7eb");
  const accent = cssColor(styles, "--color-accent", "#6c5ce7");
  const accentSoft = cssColor(styles, "--color-accent-soft", "#f0efff");
  const dark = colorIsDark(bg);
  const token = dark
    ? {
        attr: "d19a66",
        comment: "8b949e",
        keyword: "c678dd",
        number: "d19a66",
        operator: "56b6c2",
        property: "e5c07b",
        string: "98c379",
        tag: "e06c75",
        variable: "e5c07b",
      }
    : {
        attr: "b45309",
        comment: "64748b",
        keyword: "7c3aed",
        number: "b45309",
        operator: "0891b2",
        property: "a16207",
        string: "15803d",
        tag: "dc2626",
        variable: "a16207",
      };
  monaco.editor.defineTheme("pm-app", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: token.comment, fontStyle: "italic" },
      { token: "keyword", foreground: token.keyword },
      { token: "string", foreground: token.string },
      { token: "number", foreground: token.number },
      { token: "regexp", foreground: token.string },
      { token: "operator", foreground: token.operator },
      { token: "delimiter", foreground: token.comment },
      { token: "tag", foreground: token.tag },
      { token: "metatag", foreground: token.tag },
      { token: "attribute.name", foreground: token.attr },
      { token: "attribute.value", foreground: token.string },
      { token: "type", foreground: token.operator },
      { token: "variable", foreground: token.variable },
      { token: "variable.predefined", foreground: token.keyword },
      { token: "identifier.css", foreground: token.property },
      { token: "property", foreground: token.property },
    ],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editor.lineHighlightBackground": accentSoft,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": accent,
      "editorCursor.foreground": accent,
      "editor.selectionBackground": accentSoft,
      "editor.inactiveSelectionBackground": accentSoft,
      "editorIndentGuide.background1": line,
      "editorIndentGuide.activeBackground1": muted,
      "editorGutter.background": bg,
      "editorWidget.background": bg,
      "editorWidget.border": line,
      "input.background": bg,
      "input.foreground": fg,
      "input.border": line,
    },
  });
}

function cssColor(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return toHex(styles.getPropertyValue(name).trim()) ?? fallback;
}

function toHex(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgb) return null;
  return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}

function colorIsDark(hex: string) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}
