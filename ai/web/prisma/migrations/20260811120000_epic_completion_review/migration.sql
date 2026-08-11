ALTER TABLE "Epic" ADD COLUMN "completion_review_status" TEXT NOT NULL DEFAULT 'Not Required';
ALTER TABLE "Epic" ADD COLUMN "completion_review_candidate_sha" TEXT;
ALTER TABLE "Epic" ADD COLUMN "completion_review_requested_at" DATETIME;
ALTER TABLE "Epic" ADD COLUMN "completion_review_completed_at" DATETIME;
ALTER TABLE "Epic" ADD COLUMN "completion_review_last_error" TEXT;
