-- Durable native PM-channel run state for chat/comment/discussion turns.

CREATE TABLE "PmChannelRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "epicId" TEXT,
    "sessionKey" TEXT,
    "driver" TEXT NOT NULL DEFAULT 'openclaw-pm-channel',
    "gatewayPort" INTEGER,
    "httpStatus" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "acceptedAt" DATETIME,
    "streamingAt" DATETIME,
    "completedAt" DATETIME,
    "failedAt" DATETIME,
    "lastEventAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "PmChannelRun_targetKey_key" ON "PmChannelRun"("targetKey");
CREATE INDEX "PmChannelRun_agentSlug_idx" ON "PmChannelRun"("agentSlug");
CREATE INDEX "PmChannelRun_messageId_idx" ON "PmChannelRun"("messageId");
CREATE INDEX "PmChannelRun_projectId_idx" ON "PmChannelRun"("projectId");
CREATE INDEX "PmChannelRun_taskId_idx" ON "PmChannelRun"("taskId");
CREATE INDEX "PmChannelRun_epicId_idx" ON "PmChannelRun"("epicId");
CREATE INDEX "PmChannelRun_status_idx" ON "PmChannelRun"("status");
CREATE INDEX "PmChannelRun_lastEventAt_idx" ON "PmChannelRun"("lastEventAt");
