-- Project-level workflow guards and human-friendly work-item keys.

ALTER TABLE "Project" ADD COLUMN "work_item_key_prefix" TEXT;
ALTER TABLE "Project" ADD COLUMN "next_work_item_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Project" ADD COLUMN "only_reporters_can_approve_action_plans" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "only_reporters_can_set_tasks_done" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Epic" ADD COLUMN "work_item_key" TEXT;
ALTER TABLE "Task" ADD COLUMN "work_item_key" TEXT;

CREATE UNIQUE INDEX "Project_work_item_key_prefix_key" ON "Project"("work_item_key_prefix");
CREATE UNIQUE INDEX "Epic_work_item_key_key" ON "Epic"("work_item_key");
CREATE INDEX "Epic_work_item_key_idx" ON "Epic"("work_item_key");
CREATE UNIQUE INDEX "Task_work_item_key_key" ON "Task"("work_item_key");
CREATE INDEX "Task_work_item_key_idx" ON "Task"("work_item_key");
