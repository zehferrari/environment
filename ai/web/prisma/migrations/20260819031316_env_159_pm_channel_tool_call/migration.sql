-- CreateTable
CREATE TABLE "PmChannelToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PmChannelToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PmChannelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Comment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "epicId" TEXT,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    "author_agent_slug" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "run_id" TEXT,
    "comment_kind" TEXT,
    "is_generated" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Comment_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Comment_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Comment_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "PmChannelRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Comment" ("author_agent_slug", "body", "comment_kind", "createdAt", "deletedAt", "deletedById", "epicId", "id", "is_generated", "model", "provider", "run_id", "taskId", "userId") SELECT "author_agent_slug", "body", "comment_kind", "createdAt", "deletedAt", "deletedById", "epicId", "id", "is_generated", "model", "provider", "run_id", "taskId", "userId" FROM "Comment";
DROP TABLE "Comment";
ALTER TABLE "new_Comment" RENAME TO "Comment";
CREATE INDEX "Comment_taskId_idx" ON "Comment"("taskId");
CREATE INDEX "Comment_epicId_idx" ON "Comment"("epicId");
CREATE INDEX "Comment_userId_idx" ON "Comment"("userId");
CREATE INDEX "Comment_deletedAt_idx" ON "Comment"("deletedAt");
CREATE INDEX "Comment_deletedById_idx" ON "Comment"("deletedById");
CREATE INDEX "Comment_author_agent_slug_idx" ON "Comment"("author_agent_slug");
CREATE INDEX "Comment_comment_kind_idx" ON "Comment"("comment_kind");
CREATE TABLE "new_review_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "workflow_cycle_id" TEXT,
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
    CONSTRAINT "review_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "review_runs_workflow_cycle_id_fkey" FOREIGN KEY ("workflow_cycle_id") REFERENCES "task_workflow_cycles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_review_runs" ("base_sha", "candidate_sha", "created_at", "id", "invalidated_at", "invalidated_reason", "repo_touched", "reviewed_at", "reviewer_id", "status", "task_id", "updated_at", "validation_outcome", "workflow_cycle_id") SELECT "base_sha", "candidate_sha", "created_at", "id", "invalidated_at", "invalidated_reason", "repo_touched", "reviewed_at", "reviewer_id", "status", "task_id", "updated_at", "validation_outcome", "workflow_cycle_id" FROM "review_runs";
DROP TABLE "review_runs";
ALTER TABLE "new_review_runs" RENAME TO "review_runs";
CREATE UNIQUE INDEX "review_runs_workflow_cycle_id_key" ON "review_runs"("workflow_cycle_id");
CREATE INDEX "review_runs_task_id_status_idx" ON "review_runs"("task_id", "status");
CREATE INDEX "review_runs_task_id_candidate_sha_idx" ON "review_runs"("task_id", "candidate_sha");
CREATE INDEX "review_runs_status_created_at_idx" ON "review_runs"("status", "created_at");
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
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_repository_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_repository_runs_workflow_cycle_id_fkey" FOREIGN KEY ("workflow_cycle_id") REFERENCES "task_workflow_cycles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_task_repository_runs" ("attempt", "base_sha", "branch_name", "candidate_sha", "created_at", "epic_branch", "id", "last_error", "phase", "repo_touched", "repository_path", "reviewed_sha", "task_id", "updated_at", "validation_outcome", "version", "workflow_cycle_id", "worktree_path") SELECT "attempt", "base_sha", "branch_name", "candidate_sha", "created_at", "epic_branch", "id", "last_error", "phase", "repo_touched", "repository_path", "reviewed_sha", "task_id", "updated_at", "validation_outcome", "version", "workflow_cycle_id", "worktree_path" FROM "task_repository_runs";
DROP TABLE "task_repository_runs";
ALTER TABLE "new_task_repository_runs" RENAME TO "task_repository_runs";
CREATE UNIQUE INDEX "task_repository_runs_task_id_key" ON "task_repository_runs"("task_id");
CREATE UNIQUE INDEX "task_repository_runs_workflow_cycle_id_key" ON "task_repository_runs"("workflow_cycle_id");
CREATE INDEX "task_repository_runs_phase_idx" ON "task_repository_runs"("phase");
CREATE INDEX "task_repository_runs_validation_outcome_idx" ON "task_repository_runs"("validation_outcome");
CREATE TABLE "new_workflow_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "transition_id" TEXT,
    "workflow_cycle_id" TEXT,
    "aggregate_version" INTEGER NOT NULL,
    "effect_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" DATETIME,
    "completed_at" DATETIME,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "workflow_outbox_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_outbox_transition_id_fkey" FOREIGN KEY ("transition_id") REFERENCES "workflow_transitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_outbox_workflow_cycle_id_fkey" FOREIGN KEY ("workflow_cycle_id") REFERENCES "task_workflow_cycles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_workflow_outbox" ("aggregate_version", "attempts", "available_at", "completed_at", "created_at", "dedupe_key", "effect_type", "id", "last_error", "lease_expires_at", "lease_owner", "payload", "project_id", "status", "task_id", "transition_id", "updated_at", "workflow_cycle_id") SELECT "aggregate_version", "attempts", "available_at", "completed_at", "created_at", "dedupe_key", "effect_type", "id", "last_error", "lease_expires_at", "lease_owner", "payload", "project_id", "status", "task_id", "transition_id", "updated_at", "workflow_cycle_id" FROM "workflow_outbox";
DROP TABLE "workflow_outbox";
ALTER TABLE "new_workflow_outbox" RENAME TO "workflow_outbox";
CREATE UNIQUE INDEX "workflow_outbox_dedupe_key_key" ON "workflow_outbox"("dedupe_key");
CREATE INDEX "workflow_outbox_status_available_at_idx" ON "workflow_outbox"("status", "available_at");
CREATE INDEX "workflow_outbox_lease_expires_at_idx" ON "workflow_outbox"("lease_expires_at");
CREATE INDEX "workflow_outbox_task_id_aggregate_version_idx" ON "workflow_outbox"("task_id", "aggregate_version");
CREATE INDEX "workflow_outbox_transition_id_idx" ON "workflow_outbox"("transition_id");
CREATE INDEX "workflow_outbox_workflow_cycle_id_idx" ON "workflow_outbox"("workflow_cycle_id");
CREATE TABLE "new_workflow_transitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "workflow_cycle_id" TEXT,
    "workflow_version" INTEGER NOT NULL,
    "intent" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "source" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "evidence" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_transitions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_transitions_workflow_cycle_id_fkey" FOREIGN KEY ("workflow_cycle_id") REFERENCES "task_workflow_cycles" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "workflow_transitions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_workflow_transitions" ("actor_user_id", "created_at", "evidence", "from_status", "id", "idempotency_key", "intent", "source", "task_id", "to_status", "workflow_cycle_id", "workflow_version") SELECT "actor_user_id", "created_at", "evidence", "from_status", "id", "idempotency_key", "intent", "source", "task_id", "to_status", "workflow_cycle_id", "workflow_version" FROM "workflow_transitions";
DROP TABLE "workflow_transitions";
ALTER TABLE "new_workflow_transitions" RENAME TO "workflow_transitions";
CREATE INDEX "workflow_transitions_intent_created_at_idx" ON "workflow_transitions"("intent", "created_at");
CREATE INDEX "workflow_transitions_actor_user_id_idx" ON "workflow_transitions"("actor_user_id");
CREATE INDEX "workflow_transitions_workflow_cycle_id_idx" ON "workflow_transitions"("workflow_cycle_id");
CREATE UNIQUE INDEX "workflow_transitions_task_id_workflow_version_key" ON "workflow_transitions"("task_id", "workflow_version");
CREATE UNIQUE INDEX "workflow_transitions_task_id_idempotency_key_key" ON "workflow_transitions"("task_id", "idempotency_key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PmChannelToolCall_runId_idx" ON "PmChannelToolCall"("runId");

-- CreateIndex
CREATE INDEX "PmChannelToolCall_toolCallId_idx" ON "PmChannelToolCall"("toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "PmChannelToolCall_runId_toolCallId_key" ON "PmChannelToolCall"("runId", "toolCallId");
