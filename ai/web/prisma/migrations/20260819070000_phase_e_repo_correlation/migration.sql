-- PHASEE-07: Add durable publication and replay state to TaskRepositoryRun.
-- Tracks publication state per job so crash-replay can re-publish
-- deterministically without creating duplicate spool files.

ALTER TABLE "task_repository_runs" ADD COLUMN "publication_state" TEXT;
ALTER TABLE "task_repository_runs" ADD COLUMN "replay_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "task_repository_runs_publication_state_idx" ON "task_repository_runs"("publication_state");