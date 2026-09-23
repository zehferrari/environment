-- AlterTable
ALTER TABLE "review_runs" ADD COLUMN "acceptanceChecklistHash" TEXT;
ALTER TABLE "review_runs" ADD COLUMN "acceptancePlanVersion" INTEGER;

-- CreateTable
CREATE TABLE "TaskStandingAuthorization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "actionPlanId" TEXT NOT NULL,
    "actionPlanVersion" INTEGER NOT NULL,
    "workflowCycleId" TEXT,
    "assigneeId" TEXT,
    "reviewerId" TEXT,
    "grantedById" TEXT NOT NULL,
    "repositoryPath" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "scopeFingerprint" TEXT NOT NULL,
    "allowedOperations" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DevEnvironmentLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "taskId" TEXT,
    "grantId" TEXT,
    "attemptId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "expiresAt" DATETIME NOT NULL,
    "expectedSha" TEXT,
    "verifiedSha" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DevPublicationAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "grantId" TEXT,
    "environmentId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "publishedSha" TEXT,
    "verifiedSha" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "resultJson" TEXT
);

-- Additive changes preserve existing rows, constraints and approval semantics.
ALTER TABLE "Project" ADD COLUMN "ownerAcceptancePolicy" TEXT NOT NULL DEFAULT 'task';
ALTER TABLE "Project" ADD COLUMN "devPublicationPolicy" TEXT NOT NULL DEFAULT 'single_use';
ALTER TABLE "Project" ADD COLUMN "devPublicationConfig" TEXT;
ALTER TABLE "ActionPlanStep" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'implementation';
ALTER TABLE "ActionPlanStep" ADD COLUMN "responsibleActor" TEXT NOT NULL DEFAULT 'assignee';
ALTER TABLE "ActionPlanStep" ADD COLUMN "verificationEnvironment" TEXT;
ALTER TABLE "ActionPlanRevisionStep" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'implementation';
ALTER TABLE "ActionPlanRevisionStep" ADD COLUMN "responsibleActor" TEXT NOT NULL DEFAULT 'assignee';
ALTER TABLE "ActionPlanRevisionStep" ADD COLUMN "verificationEnvironment" TEXT;
ALTER TABLE "SubTask" ADD COLUMN "responsibleActor" TEXT NOT NULL DEFAULT 'assignee';
ALTER TABLE "SubTask" ADD COLUMN "verificationEnvironment" TEXT;
ALTER TABLE "SubTask" ADD COLUMN "acceptanceGate" TEXT NOT NULL DEFAULT 'task';
ALTER TABLE "SubTask" ADD COLUMN "planStepKey" TEXT;
ALTER TABLE "SubTask" ADD COLUMN "planContentHash" TEXT;
ALTER TABLE "SubTask" ADD COLUMN "completionEvidence" TEXT;
ALTER TABLE "SubTask" ADD COLUMN "completedById" TEXT;
ALTER TABLE "SubTask" ADD COLUMN "supersededReason" TEXT;

-- CreateIndex
CREATE INDEX "TaskStandingAuthorization_taskId_actionPlanVersion_status_idx" ON "TaskStandingAuthorization"("taskId", "actionPlanVersion", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DevEnvironmentLease_environmentId_key" ON "DevEnvironmentLease"("environmentId");

-- CreateIndex
CREATE INDEX "DevPublicationAttempt_taskId_createdAt_idx" ON "DevPublicationAttempt"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "DevPublicationAttempt_environmentId_state_idx" ON "DevPublicationAttempt"("environmentId", "state");
