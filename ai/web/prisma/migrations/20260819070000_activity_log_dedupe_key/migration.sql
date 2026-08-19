-- PHASEE-10 — Add dedupeKey column and unique index to ActivityLog.
-- Shared-schema change: additive and NULL-tolerant so it sequences cleanly
-- against PHASEE-08/09 migrations. SQLite UNIQUE constraints treat NULL
-- values as distinct, so multiple rows without dedupe keys remain valid.

-- Add the nullable dedupe_key column.
ALTER TABLE "ActivityLog" ADD COLUMN "dedupe_key" TEXT;

-- Create a portable unique index on dedupe_key. SQLite UNIQUE constraints
-- treat NULL values as distinct, so rows with NULL dedupe_key remain valid.
CREATE UNIQUE INDEX "ActivityLog_dedupe_key_key" ON "ActivityLog"("dedupe_key");
