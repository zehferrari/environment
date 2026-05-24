ALTER TABLE "AgentChatMessage" ADD COLUMN "originChannel" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "AgentChatMessage" ADD COLUMN "originCommentId" TEXT;

CREATE INDEX "AgentChatMessage_originCommentId_idx" ON "AgentChatMessage"("originCommentId");
