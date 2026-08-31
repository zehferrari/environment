// ENV-166 — Customer-safe publishing path test harness.
//
// Temp-SQLite harness (same pattern as scripts/user-access-control-test.ts):
// pushes the current schema into a temp database, seeds a realistic
// owner/admin/customer/agent population, and exercises the publishing
// service end to end:
//
//   1. Permission negatives: agents, customers, admins without project
//      access, and unknown principals cannot publish.
//   2. Stored published snapshots are redacted BEFORE persist.
//   3. Serialized published payloads carry NO agent identifiers for any
//      viewer role (whitelist serializer).
//   4. Re-hosted attachment copies are human-provenance rows.
//   5. Agent source rows stay excluded from Customer payloads while
//      published items are present (criterion 7 coherence).
//   6. Unpublish restores the private state — deleting the re-hosted
//      attachment copy rows (shared content-addressed blobs survive while
//      the internal source still references them).
//   7. The compose form publishes the FULL redacted snapshot untruncated.
//   8. A copy that is the blob's last reference removes the blob on
//      unpublish.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";

const execFileP = promisify(execFile);

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "customer-publishing-"));
  const originalDbUrl = process.env.DATABASE_URL;
  const originalAttachmentRoot = process.env.PM_ATTACHMENT_ROOT;
  let db: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(tmp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    // Keep re-hosted attachment blobs inside the temp dir too.
    process.env.PM_ATTACHMENT_ROOT = path.join(tmp, "attachments");

    const dbMod = await import("../lib/db");
    const permissions = await import("../lib/auth/permissions");
    const agentContentPolicy = await import("../lib/users/agent-content-policy");
    const { attachmentAbsolutePath, writeAttachment } = await import("../lib/attachments/storage");
    const publishing = await import("../lib/publishing/service");
    db = dbMod.db as PrismaClient;
    const prisma = db;

    // --- seed -----------------------------------------------------------
    const ownerUser = await prisma.user.create({
      data: {
        username: "owner-test",
        email: "owner-test@example.test",
        kind: "human",
        name: "Mission Control Owner",
        isOwner: true,
      },
    });
    const adminRoleRow =
      (await prisma.rolePermission.findFirst({ where: { name: "admin" }, select: { id: true } })) ??
      (await prisma.rolePermission.create({ data: { name: "admin" } }));
    const adminUser = await prisma.user.create({
      data: {
        username: "admin-test",
        email: "admin-test@example.test",
        kind: "human",
        name: "Admin Human",
        rolePermissionId: adminRoleRow.id,
      },
    });
    const customerUser = await prisma.user.create({
      data: {
        username: "customer-test",
        email: "customer-test@example.test",
        kind: "human",
        name: "Customer Human",
      },
    });
    const agentRow = await prisma.agent.create({
      data: { slug: "agent-test", name: "Agent Test", role: "coding", avatar: "AT" },
    });
    const agentUser = await prisma.user.create({
      data: {
        username: "agent-test",
        email: "agent-test@example.test",
        kind: "agent",
        agentId: agentRow.id,
      },
    });

    const project = await prisma.project.create({
      data: {
        slug: "publish-project",
        name: "Publish Project",
        members: { create: [{ userId: customerUser.id }, { userId: adminUser.id }] },
      },
    });
    const otherProject = await prisma.project.create({
      data: { slug: "other-project", name: "Other Project" },
    });
    const task = await prisma.task.create({
      data: { projectId: project.id, title: "Customer Task" },
    });

    // Internal agent-authored comment — must never surface raw to a customer.
    const agentCommentBody =
      "Agent Test completed the migration and @agent-test verified it end to end.";
    const agentComment = await prisma.comment.create({
      data: {
        taskId: task.id,
        userId: agentUser.id,
        body: agentCommentBody,
        authorAgentSlug: "agent-test",
        provider: "ollama",
        model: "test-model",
        commentKind: "agent_reply",
      },
    });

    // Internal attachment uploaded by the agent.
    const written = await writeAttachment({
      projectId: project.id,
      filename: "internal-report.txt",
      mimeType: "text/plain",
      data: Buffer.from("secret internal report contents", "utf8"),
    });
    const sourceAttachment = await prisma.attachment.create({
      data: {
        projectId: project.id,
        taskId: task.id,
        uploaderId: agentUser.id,
        filename: "internal-report.txt",
        storagePath: written.storagePath,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
      },
    });

    // Long internal comment: proves the compose form receives the FULL
    // redacted snapshot rather than the 280-char label preview.
    const longAgentBody =
      "Agent Test produced the detailed end-to-end narrative. " +
      "Verification progressed through staging, data integrity checks, and rollback drills. ".repeat(8) +
      "FINAL_MARKER_9Z";
    const longAgentComment = await prisma.comment.create({
      data: {
        taskId: task.id,
        userId: agentUser.id,
        body: longAgentBody,
        authorAgentSlug: "agent-test",
        provider: "ollama",
        model: "test-model",
        commentKind: "agent_reply",
      },
    });

    const ownerViewer = await permissions.getViewerByUserId(ownerUser.id);
    const adminViewer = await permissions.getViewerByUserId(adminUser.id);
    const customerViewer = await permissions.getViewerByUserId(customerUser.id);
    assert.ok(ownerViewer, "owner viewer resolves");
    assert.ok(adminViewer, "admin viewer resolves");
    assert.ok(customerViewer, "customer viewer resolves");
    assert.equal(ownerViewer!.role, "owner");
    assert.equal(adminViewer!.role, "admin");
    assert.equal(customerViewer!.role, "customer");

    // --- 1. permission negatives ----------------------------------------
    await assert.rejects(
      () =>
        publishing.publishInternalItem({
          actorUserId: agentUser.id,
          projectId: project.id,
          taskId: task.id,
          title: "Agent attempt",
          body: "Should never work",
        }),
      /Not authorized/,
      "agent principals cannot publish",
    );
    await assert.rejects(
      () =>
        publishing.publishInternalItem({
          actorUserId: customerUser.id,
          projectId: project.id,
          taskId: task.id,
          title: "Customer attempt",
          body: "Should never work",
        }),
      /Not authorized/,
      "customers cannot publish",
    );
    await assert.rejects(
      () =>
        publishing.publishInternalItem({
          actorUserId: adminUser.id,
          projectId: otherProject.id,
          title: "Out of scope",
          body: "Admin without project access",
        }),
      /Not authorized/,
      "admins without project access cannot publish",
    );
    await assert.rejects(
      () =>
        publishing.publishInternalItem({
          actorUserId: "nonexistent-user",
          projectId: project.id,
          title: "Ghost",
          body: "Nope",
        }),
      /Not authorized/,
      "unknown principals cannot publish",
    );
    await assert.rejects(
      () =>
        publishing.publishInternalItem({
          actorUserId: ownerUser.id,
          projectId: project.id,
          taskId: task.id,
          title: "   ",
          body: "x",
        }),
      /A title is required/,
      "empty titles are rejected",
    );

    // --- 2+3+4. publish as owner from the internal comment + attachment --
    const published = await publishing.publishInternalItem({
      actorUserId: ownerUser.id,
      projectId: project.id,
      taskId: task.id,
      title: "Weekly progress — @agent-test",
      body: "",
      sourceCommentId: agentComment.id,
      sourceAttachmentIds: [sourceAttachment.id],
    });
    assert.ok(published.id, "publish returns an id");

    const storedRow = await prisma.publishedItem.findUnique({ where: { id: published.id } });
    assert.ok(storedRow, "published row exists");
    assert.equal(storedRow!.authorId, ownerUser.id, "attributed to the publishing human");
    assert.ok(!storedRow!.body.includes("agent-test"), "stored body has no agent slug");
    assert.ok(!storedRow!.body.includes("Agent Test"), "stored body has no agent display name");
    assert.ok(storedRow!.body.includes("@agent"), "agent mention redacted to the neutral token");
    assert.ok(!storedRow!.title.includes("agent-test"), "stored title has no agent slug");
    assert.ok(storedRow!.body.length > 0, "snapshot body captured from the source comment");

    // 4. attachment provenance is human.
    const copyIds = JSON.parse(storedRow!.attachmentIds ?? "[]") as string[];
    assert.equal(copyIds.length, 1, "one re-hosted attachment copy");
    const copyRow = await prisma.attachment.findUnique({ where: { id: copyIds[0] } });
    assert.ok(copyRow, "re-hosted attachment row exists");
    assert.equal(
      copyRow!.uploaderId,
      ownerUser.id,
      "re-hosted copy uploader is the publishing human",
    );
    assert.notEqual(copyRow!.id, sourceAttachment.id, "re-hosted copy is a fresh row");
    assert.equal(copyRow!.filename, sourceAttachment.filename, "same filename");
    assert.equal(copyRow!.taskId, task.id, "copy is scoped to the task");

    // The re-hosted copy rides the ordinary task attachment list for
    // Customers (human uploader), independent of the PublishedItem row —
    // so unpublish must actively remove it.
    const customerAttachmentWhere = {
      AND: [
        { taskId: task.id },
        agentContentPolicy.hiddenAttachmentWhere(customerViewer!),
      ],
    };
    const customerAttachmentsWhilePublished = await prisma.attachment.findMany({
      where: customerAttachmentWhere,
    });
    assert.ok(
      customerAttachmentsWhilePublished.some((row) => row.id === copyIds[0]),
      "re-hosted copy is customer-visible through the ordinary attachment list while published",
    );
    const copyBlobPath = attachmentAbsolutePath(copyRow!);
    const sourceBlobPath = attachmentAbsolutePath(sourceAttachment);
    assert.equal(
      copyBlobPath,
      sourceBlobPath,
      "re-hosted copy shares the content-addressed blob with the internal source",
    );

    // The internal source rows are untouched (private state preserved).
    const sourceStillThere = await prisma.comment.findUnique({
      where: { id: agentComment.id },
    });
    assert.equal(sourceStillThere!.body, agentCommentBody, "source comment untouched");

    // --- 3. serialized payload whitelist ---------------------------------
    const customerItems = await publishing.listPublishedForTask(customerViewer!, task.id);
    assert.equal(customerItems.length, 1, "customer sees the published item");
    const serialized = JSON.stringify(customerItems[0]);
    for (const banned of [
      "agent-test",
      "Agent Test",
      "authorAgentSlug",
      "provider",
      "model",
      "runId",
      "sourceCommentId",
      "sourceAttachmentId",
      "attachmentIds",
    ]) {
      assert.ok(!serialized.includes(banned), `customer payload must not contain ${banned}`);
    }
    assert.equal(customerItems[0].author?.username, "owner-test", "human author attribution");
    assert.equal(customerItems[0].author?.kind, "human", "author serialized as human");
    assert.equal(customerItems[0].attachments.length, 1, "re-hosted attachment listed");
    assert.equal(customerItems[0].attachments[0].filename, "internal-report.txt");

    const adminItems = await publishing.listPublishedForTask(adminViewer!, task.id);
    assert.equal(adminItems.length, 1, "admin sees the published item");
    const adminSerialized = JSON.stringify(adminItems);
    assert.ok(!adminSerialized.includes("Agent Test"), "admin payload has no agent display name");
    const ownerItems = await publishing.listPublishedForTask(ownerViewer!, task.id);
    assert.equal(ownerItems.length, 1, "owner sees the published item");

    const projectItems = await publishing.listPublishedForProject(customerViewer!, project.id, 5);
    assert.equal(projectItems.length, 1, "project-level list visible to customer");
    await assert.rejects(
      () => publishing.listPublishedForTask(customerViewer!, "no-such-task"),
      /Not authorized/,
      "customer cannot list published items outside their scope",
    );

    // --- 5. agent source rows stay excluded from customer payloads --------
    const customerVisibleComments = await prisma.comment.count({
      where: agentContentPolicy.hiddenCommentWhere(customerViewer!),
    });
    assert.equal(customerVisibleComments, 0, "agent-authored comment excluded for customers");
    const ownerVisibleComments = await prisma.comment.count({
      where: agentContentPolicy.hiddenCommentWhere(ownerViewer!),
    });
    assert.ok(ownerVisibleComments >= 1, "owner still sees the internal source row");

    // --- publishable sources (owner/admin only, redacted previews) --------
    const sources = await publishing.listPublishableSources(ownerViewer!, task.id);
    const sourceOption = sources.comments.find((option) => option.id === agentComment.id);
    assert.ok(sourceOption, "internal comment offered as a publishable source");
    assert.ok(!sourceOption!.preview.includes("agent-test"), "source preview redacts the slug");
    assert.ok(!sourceOption!.preview.includes("Agent Test"), "source preview redacts the name");
    assert.ok(!sourceOption!.body.includes("agent-test"), "compose snapshot redacts the slug");
    assert.ok(!sourceOption!.body.includes("Agent Test"), "compose snapshot redacts the name");
    const longOption = sources.comments.find(
      (option) => option.id === longAgentComment.id,
    );
    assert.ok(longOption, "long internal comment offered as a publishable source");
    assert.ok(
      longOption!.body.length > 280,
      "compose snapshot is the full redacted body, not the label preview",
    );
    assert.ok(
      longOption!.body.endsWith("FINAL_MARKER_9Z"),
      "compose snapshot keeps the source tail untruncated",
    );
    assert.ok(
      longOption!.body.startsWith(longOption!.preview),
      "preview is a prefix of the full snapshot",
    );
    assert.ok(longOption!.preview.length <= 280, "preview stays label-length");
    assert.ok(sources.attachments.some((option) => option.id === sourceAttachment.id));
    await assert.rejects(
      () => publishing.listPublishableSources(customerViewer!, task.id),
      /Not authorized/,
      "customers cannot list publishable sources",
    );

    // --- admin publish path (typed body is redacted too) ------------------
    const adminPublished = await publishing.publishInternalItem({
      actorUserId: adminUser.id,
      projectId: project.id,
      taskId: task.id,
      title: "Admin shared update",
      body: "The migration is verified. Agent Test finished the checks and @agent-test signed off.",
    });
    const adminStored = await prisma.publishedItem.findUnique({
      where: { id: adminPublished.id },
    });
    assert.ok(!adminStored!.body.includes("Agent Test"), "typed body redacted for admin publish");
    assert.ok(adminStored!.body.includes("an agent"), "neutral token present in admin publish");
    const customerAfterAdmin = await publishing.listPublishedForTask(customerViewer!, task.id);
    assert.equal(customerAfterAdmin.length, 2, "both published items customer-visible");

    // --- 6. unpublish restores the private state -------------------------
    await publishing.unpublishPublishedItem({
      actorUserId: ownerUser.id,
      publishedItemId: published.id,
    });
    const afterOwnerUnpublish = await publishing.listPublishedForTask(customerViewer!, task.id);
    assert.equal(afterOwnerUnpublish.length, 1, "unpublished item private for customers");
    const rowAfterUnpublish = await prisma.publishedItem.findUnique({
      where: { id: published.id },
    });
    assert.ok(rowAfterUnpublish!.unpublishedAt, "unpublishedAt set");

    // Unpublish restored the private state for the re-hosted attachment:
    // the copy row is gone, the ordinary Customer attachment query no
    // longer returns it, and the internal source row and its shared
    // content-addressed blob were never touched.
    const customerAttachmentsAfterUnpublish = await prisma.attachment.findMany({
      where: customerAttachmentWhere,
    });
    assert.ok(
      !customerAttachmentsAfterUnpublish.some((row) => row.id === copyIds[0]),
      "re-hosted copy is gone from the Customer attachment query after unpublish",
    );
    const copyRowAfterUnpublish = await prisma.attachment.findUnique({
      where: { id: copyIds[0] },
    });
    assert.equal(copyRowAfterUnpublish, null, "re-hosted copy row deleted on unpublish");
    const sourceRowAfterUnpublish = await prisma.attachment.findUnique({
      where: { id: sourceAttachment.id },
    });
    assert.ok(sourceRowAfterUnpublish, "internal source attachment row intact");
    // The blob survives unpublish: it is content-addressed and still
    // referenced by the intact internal source row.
    await access(sourceBlobPath);

    await publishing.unpublishPublishedItem({
      actorUserId: adminUser.id,
      publishedItemId: adminPublished.id,
    });
    const afterBoth = await publishing.listPublishedForTask(customerViewer!, task.id);
    assert.equal(afterBoth.length, 0, "all published items private again");
    const projectAfterBoth = await publishing.listPublishedForProject(customerViewer!, project.id);
    assert.equal(projectAfterBoth.length, 0, "project list empty after unpublish");

    await assert.rejects(
      () =>
        publishing.unpublishPublishedItem({
          actorUserId: customerUser.id,
          publishedItemId: published.id,
        }),
      /Not authorized/,
      "customers cannot unpublish",
    );

    // --- 7. compose form publishes the FULL redacted snapshot -----------
    const composePublished = await publishing.publishInternalItem({
      actorUserId: ownerUser.id,
      projectId: project.id,
      taskId: task.id,
      title: "Composed from the full snapshot",
      body: longOption!.body,
      sourceCommentId: longAgentComment.id,
    });
    const composeStored = await prisma.publishedItem.findUnique({
      where: { id: composePublished.id },
    });
    assert.ok(composeStored, "compose publish stored");
    assert.equal(
      composeStored!.body,
      longOption!.body,
      "publishing the compose snapshot stores the untruncated redacted body",
    );
    assert.ok(
      composeStored!.body.endsWith("FINAL_MARKER_9Z"),
      "stored compose body keeps the tail marker",
    );
    const customerCompose = await publishing.listPublishedForTask(customerViewer!, task.id);
    assert.equal(customerCompose.length, 1, "composed update is customer-visible");
    await publishing.unpublishPublishedItem({
      actorUserId: ownerUser.id,
      publishedItemId: composePublished.id,
    });
    const afterComposeUnpublish = await publishing.listPublishedForTask(
      customerViewer!,
      task.id,
    );
    assert.equal(afterComposeUnpublish.length, 0, "composed update private after unpublish");

    // --- 8. last-referencing copy: unpublish also removes the blob -------
    const orphanWritten = await writeAttachment({
      projectId: project.id,
      filename: "orphan-report.txt",
      mimeType: "text/plain",
      data: Buffer.from("orphan internal report contents", "utf8"),
    });
    const orphanSource = await prisma.attachment.create({
      data: {
        projectId: project.id,
        taskId: task.id,
        uploaderId: agentUser.id,
        filename: "orphan-report.txt",
        storagePath: orphanWritten.storagePath,
        mimeType: orphanWritten.mimeType,
        sizeBytes: orphanWritten.sizeBytes,
        sha256: orphanWritten.sha256,
      },
    });
    const orphanPublished = await publishing.publishInternalItem({
      actorUserId: ownerUser.id,
      projectId: project.id,
      taskId: task.id,
      title: "Orphan attachment publish",
      body: "Publishing an attachment whose source row will be deleted.",
      sourceAttachmentIds: [orphanSource.id],
    });
    await prisma.attachment.delete({ where: { id: orphanSource.id } });
    await access(orphanWritten.absolutePath);
    await publishing.unpublishPublishedItem({
      actorUserId: ownerUser.id,
      publishedItemId: orphanPublished.id,
    });
    await assert.rejects(
      () => access(orphanWritten.absolutePath),
      /ENOENT/,
      "blob removed on unpublish when the copy was its last reference",
    );

    console.log("customer-publishing-test: all assertions passed");
  } finally {
    await db?.$disconnect?.();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    if (originalAttachmentRoot === undefined) delete process.env.PM_ATTACHMENT_ROOT;
    else process.env.PM_ATTACHMENT_ROOT = originalAttachmentRoot;
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
