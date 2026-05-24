ALTER TABLE "DirectAgentChatMessage" ADD COLUMN "baseArchiveId" TEXT;
ALTER TABLE "DirectAgentChatArchive" ADD COLUMN "parentArchiveId" TEXT;

CREATE INDEX "DirectAgentChatMessage_agentSlug_baseArchiveId_createdAt_idx" ON "DirectAgentChatMessage"("agentSlug", "baseArchiveId", "createdAt");
CREATE INDEX "DirectAgentChatArchive_parentArchiveId_idx" ON "DirectAgentChatArchive"("parentArchiveId");
