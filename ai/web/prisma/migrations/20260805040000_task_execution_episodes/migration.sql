-- ENV-121 — bound context by execution episodes.
--
-- One row per (Task, agent, episodeNo). The unique index is the duplicate-
-- rollover guard: a retried or concurrent close-and-open cannot mint a second
-- episode with the same number, it fails.

-- CreateTable
CREATE TABLE "task_execution_episodes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "project_id" TEXT,
    "agent_slug" TEXT NOT NULL,
    "episode_no" INTEGER NOT NULL,
    "session_key" TEXT,
    "message_id" TEXT,
    "run_id" TEXT,
    "cycle_count" INTEGER NOT NULL DEFAULT 0,
    "cycle_budget" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "completed_work" TEXT,
    "evidence" TEXT,
    "open_checklist" TEXT,
    "next_action" TEXT,
    "risks" TEXT,
    "checkpoint_at" DATETIME,
    "close_reason" TEXT,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_execution_episodes_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "task_execution_episodes_task_id_status_idx" ON "task_execution_episodes"("task_id", "status");

-- CreateIndex
CREATE INDEX "task_execution_episodes_agent_slug_idx" ON "task_execution_episodes"("agent_slug");

-- CreateIndex
CREATE INDEX "task_execution_episodes_run_id_idx" ON "task_execution_episodes"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_execution_episodes_task_id_agent_slug_episode_no_key" ON "task_execution_episodes"("task_id", "agent_slug", "episode_no");
