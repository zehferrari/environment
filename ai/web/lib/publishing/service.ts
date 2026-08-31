// ENV-166 — Customer-safe publishing service.
//
// The deliberate route from internal-only content to Customer-visible
// project content. Publishing is an intentional act by a human
// (owner/admin): the body is snapshotted with real agent identities
// redacted BEFORE it is persisted, attachments are re-hosted as fresh
// human-uploader copies, and the serialized form is a strict whitelist —
// no source provenance, no agent author/provider/model/run fields — so a
// published item renders as ordinary human-authored content for every
// viewer role. Unpublishing restores the private state: active-only reads
// drop the row and the internal source was never mutated.

import { readFile } from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  canAccessProject,
  canAccessTask,
  getViewerByUserId,
  hasAdminRole,
  hasOwnerRole,
  type Viewer,
} from "@/lib/auth/permissions";
import { buildAgentRedactor, type AgentIdentity } from "@/lib/users/redact-agents";
import {
  getActorVisibility,
  serializeVisibleActorAs,
  type ActorRow,
  type VisibleMessageActor,
} from "@/lib/users/actor-visibility";
import { attachmentAbsolutePath, writeAttachment } from "@/lib/attachments/storage";

export type SerializedPublishedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type SerializedPublishedItem = {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  taskId: string | null;
  author: VisibleMessageActor | null;
  attachments: SerializedPublishedAttachment[];
};

export type PublishableCommentOption = {
  id: string;
  preview: string;
  createdAt: string;
};

export type PublishableAttachmentOption = {
  id: string;
  filename: string;
};

export type PublishableSources = {
  comments: PublishableCommentOption[];
  attachments: PublishableAttachmentOption[];
};

export type PublishInput = {
  actorUserId: string;
  projectId: string;
  taskId?: string | null;
  title: string;
  body: string;
  sourceCommentId?: string | null;
  sourceAttachmentIds?: string[];
};

export type PublishResult = {
  id: string;
  projectId: string;
  taskId: string | null;
};

// Publishing humans only: real (non-agent) principals whose resolved human
// role is owner or admin. Agents, customers and any other principal are
// rejected server-side before any data is read or written.
async function requirePublishingViewer(
  actorUserId: string | null | undefined,
): Promise<Viewer> {
  if (!actorUserId) throw new Error("Not authorized");
  const viewer = await getViewerByUserId(actorUserId);
  if (!viewer) throw new Error("Not authorized");
  if (viewer.kind !== "human") throw new Error("Not authorized");
  if (!hasOwnerRole(viewer) && !hasAdminRole(viewer)) {
    throw new Error("Not authorized");
  }
  return viewer;
}

// Agent identities must never reach a stored published row — even when the
// publishing human is the owner, whose own interactive view is unredacted.
// Every published snapshot is forced through the registry redactor.
async function publishedSnapshotRedactor(): Promise<(text: string) => string> {
  const agents = await db.user.findMany({
    where: { kind: "agent" },
    select: {
      username: true,
      name: true,
      agent: { select: { slug: true, name: true } },
    },
  });
  const identities: AgentIdentity[] = agents.map((a) => ({
    username: a.username,
    slug: a.agent?.slug ?? null,
    name: a.agent?.name ?? a.name ?? null,
  }));
  return buildAgentRedactor(identities, true);
}

const publishedItemSelect = {
  id: true,
  projectId: true,
  taskId: true,
  authorId: true,
  title: true,
  body: true,
  publishedAt: true,
  attachmentIds: true,
} satisfies Prisma.PublishedItemSelect;

type PublishedItemRow = Prisma.PublishedItemGetPayload<{
  select: typeof publishedItemSelect;
}>;

function parseAttachmentIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export async function publishInternalItem(input: PublishInput): Promise<PublishResult> {
  const viewer = await requirePublishingViewer(input.actorUserId);
  if (!input.projectId) throw new Error("Missing projectId");
  if (!(await canAccessProject(viewer, { id: input.projectId }))) {
    throw new Error("Not authorized");
  }
  const task = input.taskId
    ? await db.task.findUnique({
        where: { id: input.taskId },
        select: { id: true, projectId: true },
      })
    : null;
  if (input.taskId && !task) throw new Error("Unknown task");
  if (task && task.projectId !== input.projectId) {
    throw new Error("Task does not belong to the target project");
  }
  if (task && !(await canAccessTask(viewer, task.id))) {
    throw new Error("Not authorized");
  }

  // A comment source must live on the same task (and must not be deleted).
  let sourceBody: string | null = null;
  if (input.sourceCommentId) {
    const source = input.taskId
      ? await db.comment.findUnique({
          where: { id: input.sourceCommentId },
          select: { taskId: true, body: true, deletedAt: true },
        })
      : null;
    if (!source || source.taskId !== input.taskId || source.deletedAt) {
      throw new Error("Source comment is not available");
    }
    sourceBody = source.body;
  }

  const redact = await publishedSnapshotRedactor();
  const rawBody = (input.body && input.body.trim()) || sourceBody || "";
  const title = redact((input.title ?? "").trim()).trim();
  const body = redact(rawBody).trim();
  if (!title) throw new Error("A title is required to publish an update");
  if (!body) {
    throw new Error("Nothing to publish: provide the update text or pick a source comment");
  }

  // Re-host source attachments as fresh human-uploader copies: the
  // publishing human becomes the uploader of record, so no agent uploader
  // linkage survives on the customer-facing rows.
  const sourceAttachmentIds = [
    ...new Set((input.sourceAttachmentIds ?? []).filter((value) => value !== "")),
  ];
  const copiedAttachmentIds: string[] = [];
  for (const sourceId of sourceAttachmentIds) {
    const src = await db.attachment.findUnique({ where: { id: sourceId } });
    if (!src || src.projectId !== input.projectId) {
      throw new Error("Source attachment is not available");
    }
    if (input.taskId && src.taskId !== input.taskId) {
      throw new Error("Source attachment is not available");
    }
    const data = await readFile(attachmentAbsolutePath(src));
    const written = await writeAttachment({
      projectId: src.projectId,
      filename: src.filename,
      mimeType: src.mimeType,
      data,
    });
    const copy = await db.attachment.create({
      data: {
        projectId: src.projectId,
        taskId: input.taskId ?? src.taskId ?? null,
        epicId: null,
        uploaderId: input.actorUserId,
        filename: src.filename,
        storagePath: written.storagePath,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
      },
      select: { id: true },
    });
    copiedAttachmentIds.push(copy.id);
  }

  const item = await db.publishedItem.create({
    data: {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      authorId: input.actorUserId,
      title,
      body,
      sourceCommentId: input.sourceCommentId ?? null,
      sourceAttachmentId: sourceAttachmentIds[0] ?? null,
      attachmentIds:
        copiedAttachmentIds.length > 0 ? JSON.stringify(copiedAttachmentIds) : null,
    },
    select: { id: true, projectId: true, taskId: true },
  });
  return item;
}

export async function unpublishPublishedItem(input: {
  actorUserId: string;
  publishedItemId: string;
}): Promise<PublishResult> {
  const viewer = await requirePublishingViewer(input.actorUserId);
  if (!input.publishedItemId) throw new Error("Missing publishedItemId");
  const item = await db.publishedItem.findUnique({
    where: { id: input.publishedItemId },
    select: { id: true, projectId: true, taskId: true, unpublishedAt: true },
  });
  if (!item) throw new Error("Unknown published item");
  if (!(await canAccessProject(viewer, { id: item.projectId }))) {
    throw new Error("Not authorized");
  }
  // Idempotent: an already-private item stays private.
  if (item.unpublishedAt) return item;
  await db.publishedItem.update({
    where: { id: item.id },
    data: { unpublishedAt: new Date() },
  });
  return item;
}

const attachmentOptionSelect = {
  id: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
} satisfies Prisma.AttachmentSelect;

// Whitelist serializer: only these fields exist in the payload. Internal
// source provenance (sourceCommentId/sourceAttachmentId/raw attachmentIds)
// and every agent identifier field are structurally absent for every viewer
// role — they are not selected and never re-attached.
export async function serializePublishedItems(
  viewer: Viewer,
  rows: readonly PublishedItemRow[],
): Promise<SerializedPublishedItem[]> {
  const authorIds = [...new Set(rows.map((row) => row.authorId))];
  const authors: ActorRow[] = authorIds.length
    ? await db.user.findMany({
        where: { id: { in: authorIds } },
        select: {
          id: true,
          username: true,
          kind: true,
          name: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, name: true, avatar: true } },
        },
      })
    : [];
  const authorById = new Map(authors.map((author) => [author.id, author]));

  const attachmentIds = [
    ...new Set(rows.flatMap((row) => parseAttachmentIds(row.attachmentIds))),
  ];
  const attachments = attachmentIds.length
    ? await db.attachment.findMany({
        where: { id: { in: attachmentIds } },
        select: attachmentOptionSelect,
      })
    : [];
  const attachmentById = new Map(attachments.map((row) => [row.id, row]));

  const visibility = await getActorVisibility(viewer);
  // Defense in depth over the persist-time snapshot redaction: re-run the
  // registry redactor for masked/hidden viewers (a no-op on text that was
  // already redacted at publish time).
  const redact = buildAgentRedactor(
    visibility.agentIdentities,
    visibility.redactAgentReferences,
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: redact(row.body),
    publishedAt: row.publishedAt.toISOString(),
    taskId: row.taskId,
    // The author is the publishing human; the actor-visibility projector is
    // the single actor path, so even a corrupted agent-authored row can only
    // surface as a masked synthetic identity for non-owner viewers.
    author: serializeVisibleActorAs(authorById.get(row.authorId) ?? null, "auto", visibility),
    attachments: parseAttachmentIds(row.attachmentIds)
      .map((id) => attachmentById.get(id))
      .filter((row2): row2 is NonNullable<typeof row2> => row2 !== undefined),
  }));
}

export async function listPublishedForTask(
  viewer: Viewer,
  taskId: string,
): Promise<SerializedPublishedItem[]> {
  if (!(await canAccessTask(viewer, taskId))) throw new Error("Not authorized");
  const rows = await db.publishedItem.findMany({
    where: { taskId, unpublishedAt: null },
    orderBy: { publishedAt: "desc" },
    select: publishedItemSelect,
  });
  return serializePublishedItems(viewer, rows);
}

export async function listPublishedForProject(
  viewer: Viewer,
  projectId: string,
  limit = 8,
): Promise<SerializedPublishedItem[]> {
  if (!(await canAccessProject(viewer, { id: projectId }))) {
    throw new Error("Not authorized");
  }
  const rows = await db.publishedItem.findMany({
    where: { projectId, unpublishedAt: null },
    orderBy: { publishedAt: "desc" },
    take: limit,
    select: publishedItemSelect,
  });
  return serializePublishedItems(viewer, rows);
}

// Owner/admin-only: the redacted previews ARE the candidate snapshot, so
// this must never be reachable by a Customer.
export async function listPublishableSources(
  viewer: Viewer,
  taskId: string,
): Promise<PublishableSources> {
  await requirePublishingViewer(viewer.id);
  if (!(await canAccessTask(viewer, taskId))) throw new Error("Not authorized");
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { projectId: true },
  });
  if (!task) throw new Error("Unknown task");
  const redact = await publishedSnapshotRedactor();
  const comments = await db.comment.findMany({
    where: { taskId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, body: true, createdAt: true },
  });
  const attachments = await db.attachment.findMany({
    where: {
      OR: [{ taskId }, { projectId: task.projectId, taskId: null, epicId: null }],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, filename: true },
  });
  return {
    comments: comments.map((row) => ({
      id: row.id,
      preview: redact(row.body).slice(0, 280),
      createdAt: row.createdAt.toISOString(),
    })),
    attachments,
  };
}
