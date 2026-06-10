-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "epicId" TEXT,
    "agentSlug" TEXT NOT NULL,
    "archiveId" TEXT,
    "baseArchiveId" TEXT,
    "targetType" TEXT,
    "targetValue" TEXT,
    "targetLabel" TEXT,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "allowDescriptionEdit" BOOLEAN NOT NULL DEFAULT false,
    "editGrantUsedAt" DATETIME,
    "allowWorkItemManagement" BOOLEAN NOT NULL DEFAULT false,
    "workItemGrantUsedAt" DATETIME,
    "originChannel" TEXT NOT NULL DEFAULT 'chat',
    "originCommentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    CONSTRAINT "AgentChatMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentChatMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentChatMessage_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentChatMessage_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "AgentChatRoomArchive" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentChatMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentChatMessage_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentChatMessage" ("agentSlug", "allowDescriptionEdit", "allowWorkItemManagement", "archiveId", "baseArchiveId", "body", "createdAt", "deletedAt", "deletedById", "editGrantUsedAt", "epicId", "id", "originChannel", "originCommentId", "projectId", "senderUserId", "targetLabel", "targetType", "targetValue", "taskId", "workItemGrantUsedAt") SELECT "agentSlug", "allowDescriptionEdit", "allowWorkItemManagement", "archiveId", "baseArchiveId", "body", "createdAt", "deletedAt", "deletedById", "editGrantUsedAt", "epicId", "id", "originChannel", "originCommentId", "projectId", "senderUserId", "targetLabel", "targetType", "targetValue", "taskId", "workItemGrantUsedAt" FROM "AgentChatMessage";
DROP TABLE "AgentChatMessage";
ALTER TABLE "new_AgentChatMessage" RENAME TO "AgentChatMessage";
CREATE INDEX "AgentChatMessage_taskId_createdAt_idx" ON "AgentChatMessage"("taskId", "createdAt");
CREATE INDEX "AgentChatMessage_epicId_createdAt_idx" ON "AgentChatMessage"("epicId", "createdAt");
CREATE INDEX "AgentChatMessage_taskId_archiveId_createdAt_idx" ON "AgentChatMessage"("taskId", "archiveId", "createdAt");
CREATE INDEX "AgentChatMessage_epicId_archiveId_createdAt_idx" ON "AgentChatMessage"("epicId", "archiveId", "createdAt");
CREATE INDEX "AgentChatMessage_archiveId_createdAt_idx" ON "AgentChatMessage"("archiveId", "createdAt");
CREATE INDEX "AgentChatMessage_baseArchiveId_createdAt_idx" ON "AgentChatMessage"("baseArchiveId", "createdAt");
CREATE INDEX "AgentChatMessage_agentSlug_idx" ON "AgentChatMessage"("agentSlug");
CREATE INDEX "AgentChatMessage_originCommentId_idx" ON "AgentChatMessage"("originCommentId");
CREATE INDEX "AgentChatMessage_deletedAt_idx" ON "AgentChatMessage"("deletedAt");
CREATE INDEX "AgentChatMessage_deletedById_idx" ON "AgentChatMessage"("deletedById");
CREATE TABLE "new_AgentSessionBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "openclawSessionKey" TEXT NOT NULL,
    "openclawSessionId" TEXT,
    "lastDispatchedMessageId" TEXT,
    "lastDispatchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AgentSessionBinding" ("agentSlug", "createdAt", "id", "lastDispatchedAt", "lastDispatchedMessageId", "openclawSessionId", "openclawSessionKey", "scopeId", "scopeType", "updatedAt") SELECT "agentSlug", "createdAt", "id", "lastDispatchedAt", "lastDispatchedMessageId", "openclawSessionId", "openclawSessionKey", "scopeId", "scopeType", "updatedAt" FROM "AgentSessionBinding";
DROP TABLE "AgentSessionBinding";
ALTER TABLE "new_AgentSessionBinding" RENAME TO "AgentSessionBinding";
CREATE UNIQUE INDEX "AgentSessionBinding_openclawSessionKey_key" ON "AgentSessionBinding"("openclawSessionKey");
CREATE INDEX "AgentSessionBinding_agentSlug_idx" ON "AgentSessionBinding"("agentSlug");
CREATE INDEX "AgentSessionBinding_openclawSessionId_idx" ON "AgentSessionBinding"("openclawSessionId");
CREATE UNIQUE INDEX "AgentSessionBinding_scopeType_scopeId_agentSlug_key" ON "AgentSessionBinding"("scopeType", "scopeId", "agentSlug");
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "epicId" TEXT,
    "parentTaskId" TEXT,
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
    "deployment_status" TEXT NOT NULL DEFAULT 'Not Required',
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_actingManagerId_fkey" FOREIGN KEY ("actingManagerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("actingManagerId", "approved_by", "approved_on", "archived_at", "archived_by", "assigneeId", "branchName", "commitPrefix", "createdAt", "deletedAt", "deletedById", "deployment_status", "description", "epicId", "id", "parentTaskId", "projectId", "rank", "reporterId", "status", "statusChangedAt", "title", "updatedAt", "work_item_key") SELECT "actingManagerId", "approved_by", "approved_on", "archived_at", "archived_by", "assigneeId", "branchName", "commitPrefix", "createdAt", "deletedAt", "deletedById", "deployment_status", "description", "epicId", "id", "parentTaskId", "projectId", "rank", "reporterId", "status", "statusChangedAt", "title", "updatedAt", "work_item_key" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE UNIQUE INDEX "Task_work_item_key_key" ON "Task"("work_item_key");
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");
CREATE INDEX "Task_work_item_key_idx" ON "Task"("work_item_key");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_epicId_idx" ON "Task"("epicId");
CREATE INDEX "Task_assigneeId_idx" ON "Task"("assigneeId");
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");
CREATE INDEX "Task_actingManagerId_idx" ON "Task"("actingManagerId");
CREATE INDEX "Task_reporterId_idx" ON "Task"("reporterId");
CREATE INDEX "Task_approved_by_idx" ON "Task"("approved_by");
CREATE INDEX "Task_archived_at_idx" ON "Task"("archived_at");
CREATE INDEX "Task_archived_by_idx" ON "Task"("archived_by");
CREATE INDEX "Task_deletedAt_idx" ON "Task"("deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

