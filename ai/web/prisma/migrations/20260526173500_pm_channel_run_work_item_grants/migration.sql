ALTER TABLE "PmChannelRun" ADD COLUMN "workItemGrantUsedAt" DATETIME;

CREATE INDEX "PmChannelRun_messageId_agentSlug_idx" ON "PmChannelRun"("messageId", "agentSlug");
