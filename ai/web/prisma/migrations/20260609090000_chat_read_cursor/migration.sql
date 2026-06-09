-- CreateTable
CREATE TABLE "ChatReadCursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "lastReadAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatReadCursor_userId_agentSlug_key" ON "ChatReadCursor"("userId", "agentSlug");

-- CreateIndex
CREATE INDEX "ChatReadCursor_agentSlug_idx" ON "ChatReadCursor"("agentSlug");
