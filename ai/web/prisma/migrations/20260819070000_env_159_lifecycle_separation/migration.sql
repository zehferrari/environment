-- ENV-159: Lifecycle separation — add admittedAt, capacity-blocked fields,
-- gatewayDispatchId, and AgentExecutionLease table. acceptedAt is retained
-- as a compatibility read path; new code writes admittedAt.

-- AlterTable: PmChannelRun
ALTER TABLE "PmChannelRun" ADD COLUMN "admittedAt" DATETIME;
ALTER TABLE "PmChannelRun" ADD COLUMN "blockedReason" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "blockedByRunId" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "blockedByTaskId" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "capacityBlockedAt" DATETIME;
ALTER TABLE "PmChannelRun" ADD COLUMN "gatewayDispatchId" TEXT;

-- CreateIndex
CREATE INDEX "PmChannelRun_blockedByRunId_idx" ON "PmChannelRun"("blockedByRunId");

-- CreateTable: AgentExecutionLease
CREATE TABLE "AgentExecutionLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentSlug" TEXT NOT NULL,
    "runId" TEXT,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "leaseToken" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" DATETIME,
    "expiresAt" DATETIME,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentExecutionLease_runId_key" ON "AgentExecutionLease"("runId");
CREATE UNIQUE INDEX "AgentExecutionLease_leaseToken_key" ON "AgentExecutionLease"("leaseToken");
CREATE INDEX "AgentExecutionLease_agentSlug_idx" ON "AgentExecutionLease"("agentSlug");
CREATE INDEX "AgentExecutionLease_status_idx" ON "AgentExecutionLease"("status");
CREATE INDEX "AgentExecutionLease_taskId_idx" ON "AgentExecutionLease"("taskId");

-- ENV-159: Partial unique index — only one active lease per agent.
-- SQLite supports partial indexes via WHERE clauses.
CREATE UNIQUE INDEX "AgentExecutionLease_agentSlug_active_uniq" ON "AgentExecutionLease"("agentSlug") WHERE "status" IN ('reserved', 'admitted', 'running');