-- Add persisted reporter fields plus Epic-level git defaults.
ALTER TABLE "Epic" ADD COLUMN "reporterId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Epic" ADD COLUMN "branchName" TEXT;
ALTER TABLE "Epic" ADD COLUMN "commitPrefix" TEXT;

ALTER TABLE "Task" ADD COLUMN "reporterId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Epic_reporterId_idx" ON "Epic"("reporterId");
CREATE INDEX "Task_reporterId_idx" ON "Task"("reporterId");

-- Best-effort backfill for existing rows. New writes always set reporterId.
UPDATE "Task"
SET "reporterId" = (
  SELECT "ActivityLog"."userId"
  FROM "ActivityLog"
  WHERE "ActivityLog"."taskId" = "Task"."id"
    AND "ActivityLog"."kind" = 'task.create'
    AND "ActivityLog"."userId" IS NOT NULL
  ORDER BY "ActivityLog"."createdAt" ASC
  LIMIT 1
)
WHERE "reporterId" IS NULL;

UPDATE "Epic"
SET "reporterId" = (
  SELECT "ActivityLog"."userId"
  FROM "ActivityLog"
  WHERE "ActivityLog"."kind" = 'epic.create'
    AND "ActivityLog"."userId" IS NOT NULL
    AND json_valid("ActivityLog"."payload")
    AND json_extract("ActivityLog"."payload", '$.epicId') = "Epic"."id"
  ORDER BY "ActivityLog"."createdAt" ASC
  LIMIT 1
)
WHERE "reporterId" IS NULL;
