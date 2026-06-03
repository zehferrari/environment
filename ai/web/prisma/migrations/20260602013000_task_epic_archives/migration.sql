ALTER TABLE "Epic" ADD COLUMN "archived_at" DATETIME;
ALTER TABLE "Epic" ADD COLUMN "archived_by" TEXT;
ALTER TABLE "Task" ADD COLUMN "archived_at" DATETIME;
ALTER TABLE "Task" ADD COLUMN "archived_by" TEXT;

CREATE INDEX "Epic_archived_at_idx" ON "Epic"("archived_at");
CREATE INDEX "Epic_archived_by_idx" ON "Epic"("archived_by");
CREATE INDEX "Task_archived_at_idx" ON "Task"("archived_at");
CREATE INDEX "Task_archived_by_idx" ON "Task"("archived_by");
