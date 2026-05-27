-- Remember Discussion recipient selectors and support continuing a Task/Epic
-- Discussion from an archived room.

ALTER TABLE "AgentChatMessage" ADD COLUMN "baseArchiveId" TEXT;
ALTER TABLE "AgentChatMessage" ADD COLUMN "targetType" TEXT;
ALTER TABLE "AgentChatMessage" ADD COLUMN "targetValue" TEXT;
ALTER TABLE "AgentChatMessage" ADD COLUMN "targetLabel" TEXT;
ALTER TABLE "AgentChatRoomArchive" ADD COLUMN "parentArchiveId" TEXT;

CREATE INDEX "AgentChatMessage_baseArchiveId_createdAt_idx" ON "AgentChatMessage"("baseArchiveId", "createdAt");
CREATE INDEX "AgentChatRoomArchive_parentArchiveId_idx" ON "AgentChatRoomArchive"("parentArchiveId");
