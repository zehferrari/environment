ALTER TABLE "Task" ADD COLUMN "alert_reporter" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Task_alert_reporter_idx" ON "Task"("alert_reporter");
