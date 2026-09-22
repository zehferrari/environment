CREATE TABLE "TaskThinkingSnapshot" (
 "runId" TEXT NOT NULL PRIMARY KEY,
 "progress" TEXT NOT NULL DEFAULT '',
 "reasoning" TEXT NOT NULL DEFAULT '',
 "tools" TEXT NOT NULL DEFAULT '[]',
 "role" TEXT NOT NULL DEFAULT 'agent',
 "truncated" BOOLEAN NOT NULL DEFAULT false,
 "lastSeq" INTEGER NOT NULL DEFAULT 0,
 "finalReceivedAt" DATETIME,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "TaskThinkingSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PmChannelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
