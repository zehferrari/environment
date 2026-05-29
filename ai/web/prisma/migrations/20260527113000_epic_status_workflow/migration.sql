-- Normalize Epic workflow states and track status-change time for Done TTL.
ALTER TABLE "Epic" ADD COLUMN "statusChangedAt" DATETIME;

UPDATE "Epic"
SET "status" = CASE "status"
  WHEN 'open' THEN 'Open'
  WHEN 'done' THEN 'Done'
  WHEN 'archived' THEN 'Archive'
  ELSE "status"
END;

UPDATE "Epic"
SET "statusChangedAt" = COALESCE("updatedAt", "createdAt")
WHERE "statusChangedAt" IS NULL;

CREATE INDEX "Epic_statusChangedAt_idx" ON "Epic"("statusChangedAt");
