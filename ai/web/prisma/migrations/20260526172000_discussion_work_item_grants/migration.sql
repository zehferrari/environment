ALTER TABLE "AgentChatMessage" ADD COLUMN "allowWorkItemManagement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentChatMessage" ADD COLUMN "workItemGrantUsedAt" DATETIME;
