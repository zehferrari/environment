-- System model-provider settings.
ALTER TABLE "SystemSettings" ADD COLUMN "openRouterApiKey" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "openRouterReferer" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "openRouterTitle" TEXT;

-- Project-scoped pool for agents acting as managers/reviewers.
CREATE TABLE "ProjectManagerAssignableAgent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectManagerAssignableAgent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectManagerAssignableAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectManagerAssignableAgent_projectId_userId_key" ON "ProjectManagerAssignableAgent"("projectId", "userId");
CREATE INDEX "ProjectManagerAssignableAgent_userId_idx" ON "ProjectManagerAssignableAgent"("userId");
