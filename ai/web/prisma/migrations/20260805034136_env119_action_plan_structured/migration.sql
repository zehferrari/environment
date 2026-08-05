-- CreateTable
CREATE TABLE "ActionPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "approvedOn" DATETIME,
    "approvedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ActionPlan_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ActionPlan_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActionPlanStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionPlanId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "acceptanceCriteria" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'sequential',
    "assigneeId" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActionPlanStep_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ActionPlanStep_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ActionPlan_taskId_key" ON "ActionPlan"("taskId");

-- CreateIndex
CREATE INDEX "ActionPlan_approvedById_idx" ON "ActionPlan"("approvedById");

-- CreateIndex
CREATE INDEX "ActionPlanStep_actionPlanId_rank_idx" ON "ActionPlanStep"("actionPlanId", "rank");

-- CreateIndex
CREATE INDEX "ActionPlanStep_assigneeId_idx" ON "ActionPlanStep"("assigneeId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionPlanStep_actionPlanId_stepId_key" ON "ActionPlanStep"("actionPlanId", "stepId");
