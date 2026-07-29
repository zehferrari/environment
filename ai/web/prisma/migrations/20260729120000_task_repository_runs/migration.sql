-- Persist the PM-owned repository state independently from the human-facing
-- Task.status column. One row is reused across retries and review rounds.
CREATE TABLE "task_repository_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "repository_path" TEXT,
    "branch_name" TEXT,
    "worktree_path" TEXT,
    "epic_branch" TEXT,
    "base_sha" TEXT,
    "candidate_sha" TEXT,
    "reviewed_sha" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'reserved',
    "validation_outcome" TEXT,
    "repo_touched" BOOLEAN,
    "last_error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_repository_runs_task_id_fkey"
      FOREIGN KEY ("task_id") REFERENCES "Task" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_repository_runs_task_id_key"
  ON "task_repository_runs"("task_id");
CREATE INDEX "task_repository_runs_phase_idx"
  ON "task_repository_runs"("phase");
CREATE INDEX "task_repository_runs_validation_outcome_idx"
  ON "task_repository_runs"("validation_outcome");
