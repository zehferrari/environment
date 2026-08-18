-- ORCH contract migration: replace ReviewRun(taskId, candidateSha) uniqueness
-- with cycle identity. The @@unique on workflow_cycle_id (one immutable review
-- lease per cycle) is the new boundary. The old (taskId, candidateSha) unique
-- index prevented the same candidate from entering Review in a later cycle
-- (the V23-36 bug). Drop it and replace with a non-unique index for lookups.
--
-- This is a SQLite table rebuild: SQLite cannot DROP INDEX on a unique index
-- that was created by Prisma's @@unique without rebuilding the table. The
-- safe approach is to drop the specific index by name (Prisma names unique
-- compound indexes as <table>_<columns>_key).

DROP INDEX IF EXISTS "review_runs_task_id_candidate_sha_key";

-- Recreate as a non-unique index for lookup performance.
CREATE INDEX IF NOT EXISTS "review_runs_task_id_candidate_sha_idx" ON "review_runs"("task_id", "candidate_sha");