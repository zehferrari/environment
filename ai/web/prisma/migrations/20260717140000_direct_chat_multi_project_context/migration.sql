CREATE TABLE "DirectAgentChatMessageProject" (
    "messageId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "allowWorkItemManagement" BOOLEAN NOT NULL DEFAULT false,
    "workItemGrantUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("messageId", "projectId"),
    CONSTRAINT "DirectAgentChatMessageProject_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectAgentChatMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DirectAgentChatMessageProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DirectAgentChatMessageProject_projectId_idx"
ON "DirectAgentChatMessageProject"("projectId");

-- Backfill the legacy single-project attachment so old messages keep the same
-- context and grant semantics after the application switches to the join rows.
INSERT OR IGNORE INTO "DirectAgentChatMessageProject" (
    "messageId",
    "projectId",
    "allowWorkItemManagement",
    "workItemGrantUsedAt",
    "createdAt"
)
SELECT
    "id",
    "projectId",
    "allowWorkItemManagement",
    "workItemGrantUsedAt",
    "createdAt"
FROM "DirectAgentChatMessage"
WHERE "projectId" IS NOT NULL;
