-- Workspace data model and API (ENV-90)
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'internal',
    "archived_at" DATETIME,
    "archived_by" TEXT,
    "logo_path" TEXT,
    "logo_mime_type" TEXT,
    "logo_size_bytes" INTEGER,
    "logo_updated_at" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workspace_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");
CREATE INDEX "Workspace_archived_at_idx" ON "Workspace"("archived_at");
CREATE INDEX "Workspace_type_idx" ON "Workspace"("type");

CREATE TABLE "WorkspaceProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkspaceProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceProject_workspaceId_projectId_key" ON "WorkspaceProject"("workspaceId", "projectId");
CREATE INDEX "WorkspaceProject_projectId_idx" ON "WorkspaceProject"("projectId");

CREATE TABLE "WorkspaceAgentPool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceAgentPool_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkspaceAgentPool_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceAgentPool_workspaceId_agentId_key" ON "WorkspaceAgentPool"("workspaceId", "agentId");
CREATE INDEX "WorkspaceAgentPool_agentId_idx" ON "WorkspaceAgentPool"("agentId");
