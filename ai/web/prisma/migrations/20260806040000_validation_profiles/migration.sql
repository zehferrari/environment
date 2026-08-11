CREATE TABLE "project_validation_profiles" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "commands" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "project_validation_profiles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "project_validation_profiles_project_id_key" ON "project_validation_profiles"("project_id");

CREATE TABLE "validation_check_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "review_run_id" TEXT,
  "candidate_sha" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "profile_id" TEXT,
  "profile_version" INTEGER NOT NULL DEFAULT 0,
  "check_name" TEXT NOT NULL,
  "executable" TEXT NOT NULL,
  "arguments" TEXT NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'running',
  "exit_code" INTEGER,
  "output" TEXT,
  "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" DATETIME,
  CONSTRAINT "validation_check_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "validation_check_runs_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "validation_check_runs_job_id_check_name_key" ON "validation_check_runs"("job_id", "check_name");
CREATE INDEX "validation_check_runs_task_id_candidate_sha_idx" ON "validation_check_runs"("task_id", "candidate_sha");
CREATE INDEX "validation_check_runs_review_run_id_idx" ON "validation_check_runs"("review_run_id");
CREATE INDEX "validation_check_runs_status_started_at_idx" ON "validation_check_runs"("status", "started_at");
