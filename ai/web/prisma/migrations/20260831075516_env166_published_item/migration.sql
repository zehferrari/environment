-- CreateTable
CREATE TABLE "PublishedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unpublishedAt" DATETIME,
    "source_comment_id" TEXT,
    "source_attachment_id" TEXT,
    "attachment_ids" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PublishedItem_projectId_unpublishedAt_idx" ON "PublishedItem"("projectId", "unpublishedAt");

-- CreateIndex
CREATE INDEX "PublishedItem_taskId_unpublishedAt_idx" ON "PublishedItem"("taskId", "unpublishedAt");

-- CreateIndex
CREATE INDEX "PublishedItem_authorId_idx" ON "PublishedItem"("authorId");

