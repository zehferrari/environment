-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'system',
    "defaultGitUserName" TEXT,
    "defaultGitUserEmail" TEXT,
    "doneTtlDays" INTEGER,
    "binTtlDays" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "readmePath" TEXT,
    "archivedAt" DATETIME,
    "repositoryPath" TEXT,
    "defaultGitUserName" TEXT,
    "defaultGitUserEmail" TEXT,
    "defaultAssigneeId" TEXT,
    "defaultReviewerId" TEXT,
    "doneTtlDays" INTEGER,
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_defaultAssigneeId_fkey" FOREIGN KEY ("defaultAssigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Project_defaultReviewerId_fkey" FOREIGN KEY ("defaultReviewerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Project_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("archivedAt", "createdAt", "defaultAssigneeId", "defaultGitUserEmail", "defaultGitUserName", "defaultReviewerId", "deletedAt", "deletedById", "description", "doneTtlDays", "id", "name", "readmePath", "repositoryPath", "slug", "updatedAt") SELECT "archivedAt", "createdAt", "defaultAssigneeId", "defaultGitUserEmail", "defaultGitUserName", "defaultReviewerId", "deletedAt", "deletedById", "description", "doneTtlDays", "id", "name", "readmePath", "repositoryPath", "slug", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE INDEX "Project_deletedAt_idx" ON "Project"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
