-- SubTask.kind: checklist phase discriminator ("implementation" | "review").
ALTER TABLE "SubTask" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'implementation';
CREATE INDEX "SubTask_taskId_kind_idx" ON "SubTask"("taskId", "kind");
