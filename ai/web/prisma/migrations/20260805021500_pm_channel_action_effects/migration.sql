-- ENV-118 — separate workflow actions from turn completion.
--
-- PmChannelRun gains the durable end-of-turn facts the ENV-116 invariant
-- adapter previously had to reconstruct from ActivityLog rows.
-- AlterTable
ALTER TABLE "PmChannelRun" ADD COLUMN "disposition" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "settledByAction" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "lastAction" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "lastActionAt" DATETIME;

-- CreateTable
CREATE TABLE "PmChannelContinuation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "projectId" TEXT,
    "taskId" TEXT,
    "epicId" TEXT,
    "messageId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'armed',
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "dispatchedMessageId" TEXT,
    "dispatchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PmChannelContinuation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PmChannelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PmChannelContinuation_status_availableAt_idx" ON "PmChannelContinuation"("status", "availableAt");

-- CreateIndex
CREATE INDEX "PmChannelContinuation_agentSlug_idx" ON "PmChannelContinuation"("agentSlug");

-- CreateIndex
CREATE INDEX "PmChannelContinuation_taskId_idx" ON "PmChannelContinuation"("taskId");

-- CreateIndex
CREATE INDEX "PmChannelContinuation_runId_idx" ON "PmChannelContinuation"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "PmChannelContinuation_runId_messageId_action_key" ON "PmChannelContinuation"("runId", "messageId", "action");
