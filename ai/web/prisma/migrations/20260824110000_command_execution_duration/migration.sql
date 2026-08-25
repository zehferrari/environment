-- Phase E operational watch metric. Nullable preserves historical receipts;
-- new command receipts record transaction work through receipt settlement.
ALTER TABLE "task_workflow_command_receipts" ADD COLUMN "execution_duration_ms" INTEGER;
