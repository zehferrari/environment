-- AlterTable: Add definitionVersion and inputSchemaVersion to TaskProcedureRun
-- Both default to 1 so existing rows backfill automatically.
ALTER TABLE "task_procedure_runs" ADD COLUMN "definition_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "task_procedure_runs" ADD COLUMN "input_schema_version" INTEGER NOT NULL DEFAULT 1;