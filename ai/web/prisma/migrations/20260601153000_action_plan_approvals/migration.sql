-- Action Plan approvals for Epics and Tasks.
ALTER TABLE "Epic" ADD COLUMN "approved_on" DATETIME;
ALTER TABLE "Epic" ADD COLUMN "approved_by" TEXT;
ALTER TABLE "Task" ADD COLUMN "approved_on" DATETIME;
ALTER TABLE "Task" ADD COLUMN "approved_by" TEXT;

CREATE INDEX "Epic_approved_by_idx" ON "Epic"("approved_by");
CREATE INDEX "Task_approved_by_idx" ON "Task"("approved_by");
