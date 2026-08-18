-- ORCH R5: Partial unique indexes to enforce one active procedure per type/cycle.
-- SQLite supports partial indexes via WHERE clauses. These prevent the
-- check-then-create race in execute.ts from producing competing procedures.
-- The existing @@unique([triggerTransitionId, type]) remains for replay safety.

-- One active (queued/running) procedure per (cycle, type).
CREATE UNIQUE INDEX IF NOT EXISTS "task_procedure_runs_active_cycle_type_uniq"
  ON "task_procedure_runs"("workflow_cycle_id", "type")
  WHERE "workflow_cycle_id" IS NOT NULL AND "status" IN ('queued', 'running');

-- One active (queued/running) planning procedure per (task, type) when
-- the procedure has no cycle (e.g. prepare_todo_task before start).
CREATE UNIQUE INDEX IF NOT EXISTS "task_procedure_runs_active_task_type_uniq"
  ON "task_procedure_runs"("task_id", "type")
  WHERE "workflow_cycle_id" IS NULL AND "status" IN ('queued', 'running');