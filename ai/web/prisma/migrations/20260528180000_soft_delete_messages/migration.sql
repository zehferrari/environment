-- HOMELAB-41 / item 2: soft-delete individual chat bubbles + comments +
-- direct-chat messages. Adds deletedAt + deletedById to each model.
-- Active reads filter deletedAt: null; agent-context builders also filter
-- deleted out so agents never see deleted content. The frontend renders
-- deleted rows as a collapsed dotted divider that humans can toggle open.
-- Hard purge (rm row) happens via the existing bin-empty paths.

ALTER TABLE "Comment" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Comment" ADD COLUMN "deletedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Comment_deletedAt_idx" ON "Comment"("deletedAt");
CREATE INDEX "Comment_deletedById_idx" ON "Comment"("deletedById");

ALTER TABLE "AgentChatMessage" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "AgentChatMessage" ADD COLUMN "deletedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AgentChatMessage_deletedAt_idx" ON "AgentChatMessage"("deletedAt");
CREATE INDEX "AgentChatMessage_deletedById_idx" ON "AgentChatMessage"("deletedById");

ALTER TABLE "DirectAgentChatMessage" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "DirectAgentChatMessage" ADD COLUMN "deletedById" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "DirectAgentChatMessage_deletedAt_idx" ON "DirectAgentChatMessage"("deletedAt");
CREATE INDEX "DirectAgentChatMessage_deletedById_idx" ON "DirectAgentChatMessage"("deletedById");
