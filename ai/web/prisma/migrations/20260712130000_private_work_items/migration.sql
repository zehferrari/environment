ALTER TABLE "Epic" ADD COLUMN "private" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "private" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Epic_private_idx" ON "Epic"("private");
CREATE INDEX "Task_private_idx" ON "Task"("private");
