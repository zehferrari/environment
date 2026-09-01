"use client";

// ENV-166 — Customer-safe published updates.
//
// PublishedUpdatesPanel renders on the task page for ALL human roles. The
// copy is customer-safe: published items read as ordinary human-authored
// project updates — no agent, action-plan or workflow terminology, no
// agent controls, badges or tabs. Publishing controls (compose form
// prefilled with the redacted snapshot, unpublish) are owner/admin-only.

import { useState } from "react";
import { MessageAvatar, MessageTimestamp } from "@/components/message-avatar";
import { publishItem, unpublishItem } from "@/lib/publishing/actions";
import type {
  PublishableSources,
  SerializedPublishedItem,
} from "@/lib/publishing/service";

function PublishedItemRow({
  item,
  canPublish,
}: {
  item: SerializedPublishedItem;
  canPublish: boolean;
}) {
  return (
    <li
      data-published-update
      className="rounded-panel border border-line bg-panel p-3"
    >
      <div className="flex items-center gap-2">
        {item.author ? <MessageAvatar actor={item.author} /> : null}
        <span className="text-caption font-semibold text-text">
          {item.author?.name ?? item.author?.username ?? "Project team"}
        </span>
        <MessageTimestamp value={item.publishedAt} />
      </div>
      <p className="mt-2 text-body font-semibold text-text">{item.title}</p>
      <p className="whitespace-pre-wrap text-caption text-text">{item.body}</p>
      {item.attachments.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {item.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="rounded-lg border border-line bg-bg-elev px-2 py-1 text-caption text-text"
            >
              {attachment.filename}
            </li>
          ))}
        </ul>
      ) : null}
      {canPublish ? (
        <form action={unpublishItem} className="mt-2">
          <input type="hidden" name="publishedItemId" value={item.id} />
          <button
            type="submit"
            className="rounded-lg border border-line px-control-x py-control-y text-caption font-semibold text-text-muted transition hover:border-crit hover:text-crit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crit/60"
          >
            Unpublish
          </button>
        </form>
      ) : null}
    </li>
  );
}

export function PublishedUpdatesPanel({
  projectId,
  taskId,
  canPublish,
  published,
  sourceOptions,
}: {
  projectId: string;
  taskId: string;
  canPublish: boolean;
  published: SerializedPublishedItem[];
  sourceOptions: PublishableSources | null;
}) {
  const [selectedCommentId, setSelectedCommentId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const commentOptions = sourceOptions?.comments ?? [];
  const attachmentOptions = sourceOptions?.attachments ?? [];

  function selectSource(commentId: string) {
    setSelectedCommentId(commentId);
    const source = commentOptions.find((option) => option.id === commentId);
    if (source) {
      // Prefill with the FULL redacted snapshot — not the 280-char label
      // preview, which would publish the source truncated.
      setBody(source.body);
      if (!title) setTitle(`Project update — ${source.createdAt.slice(0, 10)}`);
    }
  }

  return (
    <section
      data-published-updates
      className="mt-3 border-t border-line pt-3"
      aria-label="Latest updates"
    >
      <h3 className="mb-2 text-caption font-semibold tracking-wide text-text">
        Latest updates
      </h3>
      {published.length === 0 ? (
        <p className="text-caption text-text-muted">
          No updates have been shared yet.
        </p>
      ) : (
        <ul className="space-y-3" data-published-updates-list>
          {published.map((item) => (
            <PublishedItemRow key={item.id} item={item} canPublish={canPublish} />
          ))}
        </ul>
      )}

      {canPublish && sourceOptions ? (
        <details className="mt-3" data-publish-compose>
          <summary className="cursor-pointer text-caption font-semibold text-accent">
            Share an update with the customer
          </summary>
          <form action={publishItem} className="mt-2 space-y-2">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="taskId" value={taskId} />
            <input type="hidden" name="sourceCommentId" value={selectedCommentId} />
            <label className="block text-caption text-text-muted">
              Start from an internal comment (optional)
              <select
                value={selectedCommentId}
                onChange={(event) => selectSource(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-bg-elev px-2 py-1 text-caption text-text"
              >
                <option value="">— write my own —</option>
                {commentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.preview.slice(0, 120) || "(empty)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-caption text-text-muted">
              Attach files (optional)
              <select
                name="sourceAttachmentIds"
                multiple
                className="mt-1 block w-full rounded-lg border border-line bg-bg-elev px-2 py-1 text-caption text-text"
              >
                {attachmentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.filename}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-caption text-text-muted">
              Title
              <input
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                className="mt-1 block w-full rounded-lg border border-line bg-bg-elev px-2 py-1 text-caption text-text"
              />
            </label>
            <label className="block text-caption text-text-muted">
              Update text (agent references are removed automatically)
              <textarea
                name="body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={5}
                className="mt-1 block w-full rounded-lg border border-line bg-bg-elev px-2 py-1 text-caption text-text"
              />
            </label>
            <p className="text-caption text-text-muted">
              Shared updates appear to the customer as content from you.
            </p>
            <button
              type="submit"
              className="rounded-lg border border-accent/30 bg-accent-soft px-control-x py-control-y text-caption font-semibold text-accent transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              Share update
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

export function PublishedUpdatesList({
  published,
}: {
  published: SerializedPublishedItem[];
}) {
  if (published.length === 0) return null;
  return (
    <section
      data-published-updates-compact
      className="mt-4 border-t border-line pt-3"
      aria-label="Latest updates"
    >
      <h2 className="mb-2 text-body font-semibold tracking-wide text-text">
        Latest updates
      </h2>
      <ul className="space-y-2">
        {published.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-baseline gap-2 text-caption text-text"
          >
            <MessageTimestamp value={item.publishedAt} />
            <span className="font-semibold">{item.title}</span>
            <span className="text-text-muted">
              — {item.author?.name ?? item.author?.username ?? "Project team"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
