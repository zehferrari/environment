ALTER TABLE "PmChannelRun" ADD COLUMN "cancellation_requested_at" DATETIME;
ALTER TABLE "PmChannelRun" ADD COLUMN "cancellation_acknowledged_at" DATETIME;
ALTER TABLE "PmChannelRun" ADD COLUMN "cancellation_error" TEXT;

CREATE INDEX "PmChannelRun_supersededByRunId_idx"
ON "PmChannelRun"("supersededByRunId");
