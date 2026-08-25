-- Phase E E5 — make V2 ownership the database default for newly-created work.
-- Existing ownership and pin timestamps are copied unchanged.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "epicId" TEXT,
    "parentTaskId" TEXT,
    "blockedById" TEXT,
    "title" TEXT NOT NULL,
    "work_item_key" TEXT,
    "description" TEXT,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'Backlog',
    "assigneeId" TEXT,
    "actingManagerId" TEXT,
    "reporterId" TEXT,
    "approved_on" DATETIME,
    "approved_by" TEXT,
    "archived_at" DATETIME,
    "archived_by" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "statusChangedAt" DATETIME,
    "workflow_version" INTEGER NOT NULL DEFAULT 0,
    "branchName" TEXT,
    "commitPrefix" TEXT,
    "alert_reporter" BOOLEAN NOT NULL DEFAULT false,
    "deployment_status" TEXT NOT NULL DEFAULT 'Not Required',
    "active_workflow_cycle_id" TEXT,
    "workflow_engine" TEXT NOT NULL DEFAULT 'orchestrator_v2',
    "workflow_engine_pinned_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_actingManagerId_fkey" FOREIGN KEY ("actingManagerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("actingManagerId", "active_workflow_cycle_id", "alert_reporter", "approved_by", "approved_on", "archived_at", "archived_by", "assigneeId", "blockedById", "branchName", "commitPrefix", "createdAt", "deletedAt", "deletedById", "deployment_status", "description", "epicId", "id", "parentTaskId", "private", "projectId", "rank", "reporterId", "status", "statusChangedAt", "title", "updatedAt", "work_item_key", "workflow_engine", "workflow_engine_pinned_at", "workflow_version") SELECT "actingManagerId", "active_workflow_cycle_id", "alert_reporter", "approved_by", "approved_on", "archived_at", "archived_by", "assigneeId", "blockedById", "branchName", "commitPrefix", "createdAt", "deletedAt", "deletedById", "deployment_status", "description", "epicId", "id", "parentTaskId", "private", "projectId", "rank", "reporterId", "status", "statusChangedAt", "title", "updatedAt", "work_item_key", "workflow_engine", "workflow_engine_pinned_at", "workflow_version" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE UNIQUE INDEX "Task_work_item_key_key" ON "Task"("work_item_key");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
CREATE INDEX "Task_work_item_key_idx" ON "Task"("work_item_key");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_private_idx" ON "Task"("private");
CREATE INDEX "Task_epicId_idx" ON "Task"("epicId");
CREATE INDEX "Task_assigneeId_idx" ON "Task"("assigneeId");
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");
CREATE INDEX "Task_blockedById_idx" ON "Task"("blockedById");
CREATE INDEX "Task_actingManagerId_idx" ON "Task"("actingManagerId");
CREATE INDEX "Task_reporterId_idx" ON "Task"("reporterId");
CREATE INDEX "Task_approved_by_idx" ON "Task"("approved_by");
CREATE INDEX "Task_archived_at_idx" ON "Task"("archived_at");
CREATE INDEX "Task_archived_by_idx" ON "Task"("archived_by");
CREATE INDEX "Task_deletedAt_idx" ON "Task"("deletedAt");
CREATE INDEX "Task_alert_reporter_idx" ON "Task"("alert_reporter");
CREATE INDEX "Task_workflow_engine_idx" ON "Task"("workflow_engine");

CREATE TABLE "new_task_repository_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "workflow_cycle_id" TEXT,
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
    "publication_state_v2" TEXT,
    "replay_count_v2" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_repository_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_repository_runs_workflow_cycle_id_fkey" FOREIGN KEY ("workflow_cycle_id") REFERENCES "task_workflow_cycles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_task_repository_runs" ("attempt", "base_sha", "branch_name", "candidate_sha", "created_at", "epic_branch", "id", "last_error", "phase", "publication_state_v2", "replay_count_v2", "repo_touched", "repository_path", "reviewed_sha", "task_id", "updated_at", "validation_outcome", "version", "workflow_cycle_id", "worktree_path") SELECT "attempt", "base_sha", "branch_name", "candidate_sha", "created_at", "epic_branch", "id", "last_error", "phase", "publication_state_v2", "replay_count_v2", "repo_touched", "repository_path", "reviewed_sha", "task_id", "updated_at", "validation_outcome", "version", "workflow_cycle_id", "worktree_path" FROM "task_repository_runs";
DROP TABLE "task_repository_runs";
ALTER TABLE "new_task_repository_runs" RENAME TO "task_repository_runs";
CREATE UNIQUE INDEX "task_repository_runs_task_id_key" ON "task_repository_runs"("task_id");
CREATE UNIQUE INDEX "task_repository_runs_workflow_cycle_id_key" ON "task_repository_runs"("workflow_cycle_id");
CREATE INDEX "task_repository_runs_phase_idx" ON "task_repository_runs"("phase");
CREATE INDEX "task_repository_runs_validation_outcome_idx" ON "task_repository_runs"("validation_outcome");
CREATE INDEX "task_repository_runs_publication_state_v2_idx" ON "task_repository_runs"("publication_state_v2");

CREATE TABLE "new_task_workflow_cycles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "opened_workflow_version" INTEGER NOT NULL,
    "closed_workflow_version" INTEGER,
    "opened_by_transition_id" TEXT,
    "closed_by_transition_id" TEXT,
    "base_sha" TEXT,
    "candidate_sha" TEXT,
    "opened_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" DATETIME,
    "workflow_engine" TEXT NOT NULL DEFAULT 'orchestrator_v2',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_workflow_cycles_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_task_workflow_cycles" ("base_sha", "candidate_sha", "closed_at", "closed_by_transition_id", "closed_workflow_version", "created_at", "id", "opened_at", "opened_by_transition_id", "opened_workflow_version", "outcome", "sequence", "status", "task_id", "updated_at", "workflow_engine") SELECT "base_sha", "candidate_sha", "closed_at", "closed_by_transition_id", "closed_workflow_version", "created_at", "id", "opened_at", "opened_by_transition_id", "opened_workflow_version", "outcome", "sequence", "status", "task_id", "updated_at", "workflow_engine" FROM "task_workflow_cycles";
DROP TABLE "task_workflow_cycles";
ALTER TABLE "new_task_workflow_cycles" RENAME TO "task_workflow_cycles";
CREATE INDEX "task_workflow_cycles_task_id_status_idx" ON "task_workflow_cycles"("task_id", "status");
CREATE INDEX "task_workflow_cycles_status_updated_at_idx" ON "task_workflow_cycles"("status", "updated_at");
CREATE INDEX "task_workflow_cycles_workflow_engine_idx" ON "task_workflow_cycles"("workflow_engine");
CREATE UNIQUE INDEX "task_workflow_cycles_task_id_sequence_key" ON "task_workflow_cycles"("task_id", "sequence");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
