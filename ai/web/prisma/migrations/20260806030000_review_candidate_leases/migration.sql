CREATE TABLE "review_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "candidate_sha" TEXT NOT NULL,
  "base_sha" TEXT,
  "repo_touched" BOOLEAN NOT NULL,
  "validation_outcome" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'awaiting_review',
  "reviewer_id" TEXT,
  "reviewed_at" DATETIME,
  "invalidated_at" DATETIME,
  "invalidated_reason" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "review_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "review_runs_task_id_candidate_sha_key" ON "review_runs"("task_id", "candidate_sha");
CREATE INDEX "review_runs_task_id_status_idx" ON "review_runs"("task_id", "status");
CREATE INDEX "review_runs_status_created_at_idx" ON "review_runs"("status", "created_at");
