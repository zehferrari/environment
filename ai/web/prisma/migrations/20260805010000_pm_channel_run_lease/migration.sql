-- PmChannelRun leased state machine: add lease, heartbeat, finish, and supersede columns.
ALTER TABLE "PmChannelRun" ADD COLUMN "leaseExpiresAt" DateTime;
ALTER TABLE "PmChannelRun" ADD COLUMN "heartbeatAt" DateTime;
ALTER TABLE "PmChannelRun" ADD COLUMN "finishedAt" DateTime;
ALTER TABLE "PmChannelRun" ADD COLUMN "finishedReason" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "supersededByRunId" TEXT;

-- Unique partial index: at most one active (non-terminal) run per (taskId, agentSlug).
-- SQLite does not support WHERE-clause partial indexes with complex IN lists,
-- so we filter to the set of non-terminal statuses the application enforces.
CREATE UNIQUE INDEX "PmChannelRun_active_task_agent_unique"
  ON "PmChannelRun"("taskId", "agentSlug")
  WHERE "status" IN ('queued', 'accepted', 'streaming');