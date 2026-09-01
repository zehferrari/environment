-- Historical direct SQLite maintenance inserted a small number of
-- ActivityLog.createdAt values as ISO text. Prisma's SQLite DateTime decoder
-- expects epoch milliseconds and raises P2023 when an aggregate encounters
-- those rows. Normalize every parseable text timestamp in-place.
UPDATE "ActivityLog"
SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000
WHERE typeof("createdAt") = 'text'
  AND strftime('%s', "createdAt") IS NOT NULL;

-- A description request is persisted before its agent turn is dispatched.
-- Retire stale one-shot grants that never obtained a PM-channel run, preserving
-- the discussion/audit row while ensuring the UI no longer treats it as live.
UPDATE "AgentChatMessage"
SET "editGrantUsedAt" = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE "originChannel" = 'description'
  AND "allowDescriptionEdit" = 1
  AND "editGrantUsedAt" IS NULL
  AND "createdAt" < (CAST(strftime('%s', 'now') AS INTEGER) * 1000) - 60000
  AND NOT EXISTS (
    SELECT 1
    FROM "PmChannelRun"
    WHERE "PmChannelRun"."messageId" = "AgentChatMessage"."id"
  );
