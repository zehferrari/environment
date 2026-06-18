-- Add optional Epic deploy reviewer agent selection.
ALTER TABLE "Epic" ADD COLUMN "deployReviewerId" TEXT REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Epic_deployReviewerId_idx" ON "Epic"("deployReviewerId");
