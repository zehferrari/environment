PRAGMA foreign_keys=OFF;

-- Epic worker pool: an Epic may list multiple coding agents that the
-- Acting Manager can assign to child Tasks. Task.assigneeId stays single.
CREATE TABLE "EpicWorker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "epicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EpicWorker_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EpicWorker_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EpicWorker_epicId_userId_key" ON "EpicWorker"("epicId", "userId");
CREATE INDEX "EpicWorker_userId_idx" ON "EpicWorker"("userId");

INSERT INTO "EpicWorker" ("id", "epicId", "userId", "createdAt")
SELECT 'epicworker_' || e."id" || '_' || e."assigneeId", e."id", e."assigneeId", CURRENT_TIMESTAMP
FROM "Epic" e
JOIN "User" u ON u."id" = e."assigneeId"
LEFT JOIN "Agent" a ON a."id" = u."agentId"
WHERE e."assigneeId" IS NOT NULL
  AND u."status" = 'active'
  AND u."kind" = 'agent'
  AND a."role" = 'coding'
  AND a."deactivatedAt" IS NULL;

DROP INDEX IF EXISTS "Epic_assigneeId_idx";

CREATE TABLE "new_Epic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "work_item_key" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Backlog',
    "statusChangedAt" DATETIME,
    "actingManagerId" TEXT,
    "reporterId" TEXT,
    "approved_on" DATETIME,
    "approved_by" TEXT,
    "archived_at" DATETIME,
    "archived_by" TEXT,
    "branchName" TEXT,
    "commitPrefix" TEXT,
    "deployment_status" TEXT NOT NULL DEFAULT 'Not Required',
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Epic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Epic_actingManagerId_fkey" FOREIGN KEY ("actingManagerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Epic_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Epic_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Epic_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Epic_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Epic" (
    "id", "projectId", "title", "work_item_key", "description", "status",
    "statusChangedAt", "actingManagerId", "reporterId", "approved_on",
    "approved_by", "archived_at", "archived_by", "branchName",
    "commitPrefix", "deployment_status", "deletedAt", "deletedById",
    "createdAt", "updatedAt"
)
SELECT
    "id", "projectId", "title", "work_item_key", "description", "status",
    "statusChangedAt", "actingManagerId", "reporterId", "approved_on",
    "approved_by", "archived_at", "archived_by", "branchName",
    "commitPrefix", "deployment_status", "deletedAt", "deletedById",
    "createdAt", "updatedAt"
FROM "Epic";

DROP TABLE "Epic";
ALTER TABLE "new_Epic" RENAME TO "Epic";

CREATE UNIQUE INDEX "Epic_work_item_key_key" ON "Epic"("work_item_key");
CREATE INDEX "Epic_projectId_idx" ON "Epic"("projectId");
CREATE INDEX "Epic_work_item_key_idx" ON "Epic"("work_item_key");
CREATE INDEX "Epic_status_idx" ON "Epic"("status");
CREATE INDEX "Epic_statusChangedAt_idx" ON "Epic"("statusChangedAt");
CREATE INDEX "Epic_actingManagerId_idx" ON "Epic"("actingManagerId");
CREATE INDEX "Epic_reporterId_idx" ON "Epic"("reporterId");
CREATE INDEX "Epic_approved_by_idx" ON "Epic"("approved_by");
CREATE INDEX "Epic_archived_at_idx" ON "Epic"("archived_at");
CREATE INDEX "Epic_archived_by_idx" ON "Epic"("archived_by");
CREATE INDEX "Epic_deletedAt_idx" ON "Epic"("deletedAt");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
