CREATE TABLE "ReviewFinding" (
 "id" TEXT NOT NULL PRIMARY KEY, "taskId" TEXT NOT NULL, "reviewRunId" TEXT NOT NULL,
 "position" INTEGER NOT NULL, "candidateSha" TEXT NOT NULL, "reviewerId" TEXT NOT NULL,
 "title" TEXT NOT NULL, "acceptanceCriteria" TEXT NOT NULL, "scopeReference" TEXT NOT NULL,
 "actionPlanId" TEXT, "actionPlanVersion" INTEGER, "subTaskId" TEXT,
 "status" TEXT NOT NULL DEFAULT 'open', "completionEvidence" TEXT,
 "supersededReason" TEXT, "ownerInstructionCommentId" TEXT, "resolvedById" TEXT,
 "resolvedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "ReviewFinding_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "ReviewFinding_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "ReviewFinding_subTaskId_fkey" FOREIGN KEY ("subTaskId") REFERENCES "SubTask"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReviewFinding_subTaskId_key" ON "ReviewFinding"("subTaskId");
CREATE UNIQUE INDEX "ReviewFinding_reviewRunId_position_key" ON "ReviewFinding"("reviewRunId", "position");
CREATE INDEX "ReviewFinding_taskId_status_idx" ON "ReviewFinding"("taskId", "status");
