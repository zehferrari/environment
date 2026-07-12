ALTER TABLE "User" ADD COLUMN "is_owner" BOOLEAN NOT NULL DEFAULT false;

-- Existing installations predate explicit ownership. The earliest human
-- account is the established Mission Control owner; agent mirror rows can
-- never acquire ownership through this backfill.
UPDATE "User"
SET "is_owner" = true
WHERE "id" = (
  SELECT "id"
  FROM "User"
  WHERE "kind" = 'human'
  ORDER BY "createdAt" ASC, "id" ASC
  LIMIT 1
);

CREATE INDEX "User_is_owner_idx" ON "User"("is_owner");
