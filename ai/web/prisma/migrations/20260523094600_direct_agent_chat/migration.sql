-- Direct agent chat opened from the global sidebar CHAT section.
CREATE TABLE "DirectAgentChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentSlug" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectAgentChatMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "DirectAgentChatMessage_agentSlug_createdAt_idx" ON "DirectAgentChatMessage"("agentSlug", "createdAt");
CREATE INDEX "DirectAgentChatMessage_senderUserId_idx" ON "DirectAgentChatMessage"("senderUserId");
