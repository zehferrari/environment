-- ENV-122 — Normalize comments and identity.
-- Add metadata columns to Comment so agent/provider signatures, comment
-- kind, generated/system status, and PM-channel run provenance are
-- persisted at write time instead of parsed from body text.
-- AlterTable
ALTER TABLE "Comment" ADD COLUMN "authorAgentSlug" TEXT;
ALTER TABLE "Comment" ADD COLUMN "provider" TEXT;
ALTER TABLE "Comment" ADD COLUMN "model" TEXT;
ALTER TABLE "Comment" ADD COLUMN "runId" TEXT;
ALTER TABLE "Comment" ADD COLUMN "commentKind" TEXT;
ALTER TABLE "Comment" ADD COLUMN "isGenerated" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing comments: human-authored get 'human', agent-authored
-- get 'agent_reply'. We infer from User.kind on the joined User row.
UPDATE "Comment"
SET "commentKind" = 'human'
WHERE "commentKind" IS NULL
  AND "userId" IN (SELECT id FROM "User" WHERE kind = 'human');

UPDATE "Comment"
SET "commentKind" = 'agent_reply'
WHERE "commentKind" IS NULL
  AND "userId" IN (SELECT id FROM "User" WHERE kind = 'agent');

-- Any remaining NULL (shouldn't exist, but safety net) default to 'human'.
UPDATE "Comment" SET "commentKind" = 'human' WHERE "commentKind" IS NULL;

-- CreateIndex
CREATE INDEX "Comment_authorAgentSlug_idx" ON "Comment"("authorAgentSlug");
CREATE INDEX "Comment_commentKind_idx" ON "Comment"("commentKind");