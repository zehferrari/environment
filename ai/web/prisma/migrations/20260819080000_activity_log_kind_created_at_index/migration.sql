-- PHASEE-10 — Add composite index on ActivityLog(kind, createdAt)
-- for efficient legacy boundary invocation queries in
-- getLegacyInvocationSummary (range scan by kind + createdAt ordering).

CREATE INDEX "ActivityLog_kind_created_at_idx" ON "ActivityLog"("kind", "createdAt");