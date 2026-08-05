-- ENV-122 — Normalize comments and identity.
-- Add metadata columns to Comment so agent/provider signatures, comment
-- kind, generated/system status, and PM-channel run provenance are
-- persisted at write time instead of parsed from body text.
-- AlterTable
-- Column names match @map attributes in the Prisma Comment model:
-- authorAgentSlug @map("author_agent_slug"), commentKind @map("comment_kind"),
-- isGenerated @map("is_generated"), runId @map("run_id").
ALTER TABLE "Comment" ADD COLUMN "author_agent_slug" TEXT;
ALTER TABLE "Comment" ADD COLUMN "provider" TEXT;
ALTER TABLE "Comment" ADD COLUMN "model" TEXT;
ALTER TABLE "Comment" ADD COLUMN "run_id" TEXT;
ALTER TABLE "Comment" ADD COLUMN "comment_kind" TEXT;
ALTER TABLE "Comment" ADD COLUMN "is_generated" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing comments: human-authored get 'human', agent-authored
-- get 'agent_reply'. We infer from User.kind on the joined User row.
UPDATE "Comment"
SET "comment_kind" = 'human'
WHERE "comment_kind" IS NULL
  AND "userId" IN (SELECT id FROM "User" WHERE kind = 'human');

UPDATE "Comment"
SET "comment_kind" = 'agent_reply'
WHERE "comment_kind" IS NULL
  AND "userId" IN (SELECT id FROM "User" WHERE kind = 'agent');

-- Any remaining NULL (shouldn't exist, but safety net) default to 'human'.
UPDATE "Comment" SET "comment_kind" = 'human' WHERE "comment_kind" IS NULL;

-- CreateIndex (names match Prisma-generated conventions for @map columns)
CREATE INDEX "Comment_author_agent_slug_idx" ON "Comment"("author_agent_slug");
CREATE INDEX "Comment_comment_kind_idx" ON "Comment"("comment_kind");