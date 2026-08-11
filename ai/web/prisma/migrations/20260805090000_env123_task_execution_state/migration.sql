-- ENV-123 — watchdogs and visibility.
--
-- One row per Task carrying the operator-visible execution state. The unique
-- index on task_id is what makes the watchdog's write an idempotent upsert:
-- two concurrent passes over the same task cannot mint two states.

-- CreateTable
CREATE TABLE "task_execution_states" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "project_id" TEXT,
    "state" TEXT NOT NULL,
    "reason_code" TEXT,
    "reason_detail" TEXT,
    "last_durable_action" TEXT,
    "last_durable_action_at" DATETIME,
    "recovery_action" TEXT,
    "recovery_at" DATETIME,
    "detector_id" TEXT,
    "recovery_count" INTEGER NOT NULL DEFAULT 0,
    "recovery_window_at" DATETIME,
    "breaker_open_until" DATETIME,
    "escalated_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_execution_states_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "task_execution_states_task_id_key" ON "task_execution_states"("task_id");

-- CreateIndex
CREATE INDEX "task_execution_states_state_idx" ON "task_execution_states"("state");

-- CreateIndex
CREATE INDEX "task_execution_states_project_id_idx" ON "task_execution_states"("project_id");
