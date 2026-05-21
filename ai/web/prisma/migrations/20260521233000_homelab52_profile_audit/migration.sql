-- HOMELAB-52: add denormalized target fields for agent profile editor audit rows.
ALTER TABLE "ActivityLog" ADD COLUMN "targetAgent" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN "targetFile" TEXT;

CREATE INDEX "ActivityLog_targetAgent_idx" ON "ActivityLog"("targetAgent");
CREATE INDEX "ActivityLog_targetFile_idx" ON "ActivityLog"("targetFile");
