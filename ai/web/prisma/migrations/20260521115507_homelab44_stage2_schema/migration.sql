-- HOMELAB-44 Stage 2 schema migration
--
-- 1. Project.readmePath: optional path to the on-disk project README
--    (deploy/runtime data path; canonical /srv/Data/projects/<id>/README.md).
-- 2. Task.parentTaskId: self-referential FK so sub-tasks live in the same
--    table as their parent task. Hierarchy is epic > task > subtask via
--    epicId + parentTaskId (single Task model, no parallel SubTask).
-- 3. Task.status default flips to "Backlog"; existing Stage 1 rows are remapped
--    from snake_case IDs to the verbatim Stage 0 labels (Backlog | To Do |
--    In Progress | Review | Done — no Jira aliases per HOMELAB-44).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "readmePath" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "epicId" TEXT,
    "parentTaskId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Backlog',
    "assigneeId" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("assigneeId", "createdAt", "description", "epicId", "id", "projectId", "rank", "status", "title", "updatedAt") SELECT "assigneeId", "createdAt", "description", "epicId", "id", "projectId", "rank", "status", "title", "updatedAt" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_epicId_idx" ON "Task"("epicId");
CREATE INDEX "Task_assigneeId_idx" ON "Task"("assigneeId");
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Remap Stage 1 snake_case status IDs to verbatim Stage 0 labels.
UPDATE "Task" SET "status" = 'Backlog'     WHERE "status" = 'backlog';
UPDATE "Task" SET "status" = 'To Do'       WHERE "status" = 'todo';
UPDATE "Task" SET "status" = 'In Progress' WHERE "status" = 'in_progress';
UPDATE "Task" SET "status" = 'Review'      WHERE "status" = 'review';
UPDATE "Task" SET "status" = 'Done'        WHERE "status" = 'done';
