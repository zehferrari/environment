-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "epicId" TEXT,
    "parentTaskId" TEXT,
    "blockedById" TEXT,
    "title" TEXT NOT NULL,
    "work_item_key" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Backlog',
    "assigneeId" TEXT,
    "actingManagerId" TEXT,
    "reporterId" TEXT,
    "approved_on" DATETIME,
    "approved_by" TEXT,
    "archived_at" DATETIME,
    "archived_by" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "statusChangedAt" DATETIME,
    "branchName" TEXT,
    "commitPrefix" TEXT,
    "alert_reporter" BOOLEAN NOT NULL DEFAULT false,
    "deployment_status" TEXT NOT NULL DEFAULT 'Not Required',
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_actingManagerId_fkey" FOREIGN KEY ("actingManagerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("actingManagerId", "alert_reporter", "approved_by", "approved_on", "archived_at", "archived_by", "assigneeId", "branchName", "commitPrefix", "createdAt", "deletedAt", "deletedById", "deployment_status", "description", "epicId", "id", "parentTaskId", "projectId", "rank", "reporterId", "status", "statusChangedAt", "title", "updatedAt", "work_item_key") SELECT "actingManagerId", "alert_reporter", "approved_by", "approved_on", "archived_at", "archived_by", "assigneeId", "branchName", "commitPrefix", "createdAt", "deletedAt", "deletedById", "deployment_status", "description", "epicId", "id", "parentTaskId", "projectId", "rank", "reporterId", "status", "statusChangedAt", "title", "updatedAt", "work_item_key" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE UNIQUE INDEX "Task_work_item_key_key" ON "Task"("work_item_key");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
CREATE INDEX "Task_work_item_key_idx" ON "Task"("work_item_key");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_epicId_idx" ON "Task"("epicId");
CREATE INDEX "Task_assigneeId_idx" ON "Task"("assigneeId");
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");
CREATE INDEX "Task_blockedById_idx" ON "Task"("blockedById");
CREATE INDEX "Task_actingManagerId_idx" ON "Task"("actingManagerId");
CREATE INDEX "Task_reporterId_idx" ON "Task"("reporterId");
CREATE INDEX "Task_approved_by_idx" ON "Task"("approved_by");
CREATE INDEX "Task_archived_at_idx" ON "Task"("archived_at");
CREATE INDEX "Task_archived_by_idx" ON "Task"("archived_by");
CREATE INDEX "Task_deletedAt_idx" ON "Task"("deletedAt");
CREATE INDEX "Task_alert_reporter_idx" ON "Task"("alert_reporter");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
