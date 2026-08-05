-- PmChannelRun leased state machine: add lease, heartbeat, finish, and supersede columns.
ALTER TABLE "PmChannelRun" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "PmChannelRun" ADD COLUMN "heartbeatAt" DATETIME;
ALTER TABLE "PmChannelRun" ADD COLUMN "finishedAt" DATETIME;
ALTER TABLE "PmChannelRun" ADD COLUMN "finishedReason" TEXT;
ALTER TABLE "PmChannelRun" ADD COLUMN "supersededByRunId" TEXT;

-- Reconcile existing active duplicates before enforcing uniqueness.
-- For each (taskId, agentSlug) group with more than one non-terminal run,
-- keep the newest (by updatedAt DESC) and mark the rest as superseded.
-- This prevents the unique index creation from failing on pre-existing duplicates.
UPDATE "PmChannelRun" SET
  status = 'superseded',
  "finishedAt" = COALESCE("finishedAt", datetime('now')),
  "finishedReason" = 'reconciled_duplicate_pre_index'
WHERE id IN (
  SELECT id FROM (
    SELECT
      r.id AS id,
      ROW_NUMBER() OVER (
        PARTITION BY r."taskId", r."agentSlug"
        ORDER BY r."updatedAt" DESC
      ) AS rn
    FROM "PmChannelRun" r
    WHERE r."taskId" IS NOT NULL
      AND r.status IN ('queued', 'accepted', 'streaming')
  )
  WHERE rn > 1
);

-- Unique partial index: at most one active (non-terminal) run per (taskId, agentSlug).
CREATE UNIQUE INDEX "PmChannelRun_active_task_agent_unique"
  ON "PmChannelRun"("taskId", "agentSlug")
  WHERE "status" IN ('queued', 'accepted', 'streaming');