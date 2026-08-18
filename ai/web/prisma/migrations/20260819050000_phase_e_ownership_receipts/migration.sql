-- Phase E §5.1 + §6.1 — Durable engine ownership and command receipts
--
-- Additive only: ALTER TABLE for new columns + CREATE TABLE for receipts.
-- No destructive changes. Existing rows default to "legacy" engine.

-- Task: durable engine ownership fields
ALTER TABLE "Task" ADD COLUMN "workflow_engine" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Task" ADD COLUMN "workflow_engine_pinned_at" DATETIME;

-- TaskWorkflowCycle: engine pin frozen at cycle open time
ALTER TABLE "task_workflow_cycles" ADD COLUMN "workflow_engine" TEXT NOT NULL DEFAULT 'legacy';

-- Indexes for engine ownership queries
CREATE INDEX "Task_workflow_engine_idx" ON "Task"("workflow_engine");
CREATE INDEX "task_workflow_cycles_workflow_engine_idx" ON "task_workflow_cycles"("workflow_engine");

-- TaskWorkflowCommandReceipt: single replay authority (Phase E §6.1)
CREATE TABLE "task_workflow_command_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "workflow_cycle_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "decision_actor_id" TEXT,
    "executor_actor_id" TEXT,
    "expected_workflow_version" INTEGER NOT NULL,
    "resulting_workflow_version" INTEGER NOT NULL,
    "transition_id" TEXT,
    "procedure_run_id" TEXT,
    "status" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "task_workflow_command_receipts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_workflow_command_receipts_workflow_cycle_id_fkey" FOREIGN KEY ("workflow_cycle_id") REFERENCES "task_workflow_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Unique constraint: one receipt per (taskId, idempotencyKey) — the final race arbiter
CREATE UNIQUE INDEX "task_workflow_command_receipts_task_id_idempotency_key_key" ON "task_workflow_command_receipts"("task_id", "idempotency_key");

-- Supporting indexes for projection queries
CREATE INDEX "task_workflow_command_receipts_workflow_cycle_id_created_at_idx" ON "task_workflow_command_receipts"("workflow_cycle_id", "created_at");
CREATE INDEX "task_workflow_command_receipts_intent_created_at_idx" ON "task_workflow_command_receipts"("intent", "created_at");
CREATE INDEX "task_workflow_command_receipts_procedure_run_id_idx" ON "task_workflow_command_receipts"("procedure_run_id");