-- Add archived direct-chat conversations. Active direct-chat messages keep
-- archiveId NULL; archiving creates a snapshot row and attaches the current
-- active messages to it.

CREATE TABLE "DirectAgentChatArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentSlug" TEXT NOT NULL,
    "archivedById" TEXT NOT NULL,
    "deletedById" TEXT,
    "summary" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectAgentChatArchive_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DirectAgentChatArchive_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "DirectAgentChatMessage" ADD COLUMN "archiveId" TEXT;

CREATE INDEX "DirectAgentChatArchive_agentSlug_createdAt_idx" ON "DirectAgentChatArchive"("agentSlug", "createdAt");
CREATE INDEX "DirectAgentChatArchive_agentSlug_deletedAt_createdAt_idx" ON "DirectAgentChatArchive"("agentSlug", "deletedAt", "createdAt");
CREATE INDEX "DirectAgentChatArchive_archivedById_idx" ON "DirectAgentChatArchive"("archivedById");
CREATE INDEX "DirectAgentChatArchive_deletedById_idx" ON "DirectAgentChatArchive"("deletedById");

CREATE INDEX "DirectAgentChatMessage_agentSlug_archiveId_createdAt_idx" ON "DirectAgentChatMessage"("agentSlug", "archiveId", "createdAt");
CREATE INDEX "DirectAgentChatMessage_archiveId_createdAt_idx" ON "DirectAgentChatMessage"("archiveId", "createdAt");
