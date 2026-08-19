-- PHASEE-10 — Add dedupeKey column and partial unique index to ActivityLog.
-- Shared-schema change: additive and NULL-tolerant so it sequences cleanly
-- against PHASEE-08/09 migrations. NULL keys are not constrained by the
-- partial unique index; multiple rows without dedupe keys remain valid.

-- Add the nullable dedupe_key column.
ALTER TABLE "ActivityLog" ADD COLUMN "dedupe_key" TEXT;

-- Create a unique index on dedupe_key. In SQLite, NULL values are never
-- considered equal by UNIQUE constraints, so rows with NULL dedupe_key
-- are not constrained. This gives us the partial unique behaviour we need
-- without a WHERE clause (SQLite doesn't support partial indexes via
-- CREATE UNIQUE INDEX ... WHERE until 3.8.0+, and this deployment targets
-- SQLite 3.40+ which does support it, but the simpler form is portable).
CREATE UNIQUE INDEX "ActivityLog_dedupe_key_key" ON "ActivityLog"("dedupe_key") WHERE "dedupe_key" IS NOT NULL;