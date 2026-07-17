-- Keep Task git fields as explicit overrides only. Child Tasks inherit the
-- Epic's effective branch dynamically (explicit or human-key fallback), then
-- fall back to their own human work-item key. Clear only values that are
-- provably copied/redundant or match the
-- legacy CUID-derived branch format.

UPDATE "Task"
SET "branchName" = NULL
WHERE "epicId" IS NOT NULL
  AND "branchName" IS NOT NULL
  AND (
    "branchName" = (
      SELECT "Epic"."branchName"
      FROM "Epic"
      WHERE "Epic"."id" = "Task"."epicId"
    )
    OR lower("branchName") LIKE lower("epicId") || '-%'
  );

UPDATE "Task"
SET "commitPrefix" = NULL
WHERE "epicId" IS NOT NULL
  AND "commitPrefix" IS NOT NULL
  AND "commitPrefix" = (
    SELECT "Epic"."commitPrefix"
    FROM "Epic"
    WHERE "Epic"."id" = "Task"."epicId"
  );

-- Epics generated before human work-item keys were used could also retain a
-- CUID-prefixed synthetic branch. Null restores the human-key fallback.
UPDATE "Epic"
SET "branchName" = NULL
WHERE "branchName" IS NOT NULL
  AND lower("branchName") LIKE lower("id") || '-%';
