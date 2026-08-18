-- TaskProcedureRun + TaskProcedureStep: durable ordered procedure engine
-- (ORCH-03). One run per (trigger transition, procedure type); steps are
-- claimed with leases, executed by a closed handler registry, and retried
-- with backoff. A step may wait for an asynchronous callback.

CREATE TABLE "task_procedure_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "workflow_cycle_id" TEXT,
  "trigger_transition_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "current_step" TEXT,
  "input" TEXT,
  "output" TEXT,
  "last_error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  "completed_at" DATETIME,
  CONSTRAINT "task_procedure_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_procedure_runs_workflow_cycle_id_fkey" FOREIGN KEY ("workflow_cycle_id") REFERENCES "task_workflow_cycles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "task_procedure_runs_trigger_transition_id_type_key" ON "task_procedure_runs"("trigger_transition_id", "type");
CREATE INDEX "task_procedure_runs_status_updated_at_idx" ON "task_procedure_runs"("status", "updated_at");
CREATE INDEX "task_procedure_runs_task_id_status_idx" ON "task_procedure_runs"("task_id", "status");
CREATE INDEX "task_procedure_runs_workflow_cycle_id_idx" ON "task_procedure_runs"("workflow_cycle_id");

CREATE TABLE "task_procedure_steps" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "procedure_run_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" DATETIME,
  "input" TEXT,
  "output" TEXT,
  "last_error" TEXT,
  "started_at" DATETIME,
  "completed_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "task_procedure_steps_procedure_run_id_fkey" FOREIGN KEY ("procedure_run_id") REFERENCES "task_procedure_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "task_procedure_steps_procedure_run_id_name_key" ON "task_procedure_steps"("procedure_run_id", "name");
CREATE UNIQUE INDEX "task_procedure_steps_procedure_run_id_ordinal_key" ON "task_procedure_steps"("procedure_run_id", "ordinal");
CREATE INDEX "task_procedure_steps_status_available_at_idx" ON "task_procedure_steps"("status", "available_at");
CREATE INDEX "task_procedure_steps_lease_expires_at_idx" ON "task_procedure_steps"("lease_expires_at");