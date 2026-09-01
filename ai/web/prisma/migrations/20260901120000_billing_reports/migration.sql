-- AlterTable
ALTER TABLE "Project" ADD COLUMN "billing_prompt" TEXT;
ALTER TABLE "Project" ADD COLUMN "hourly_rate_cents" INTEGER;

-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN "billing_prompt" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "billing_currency" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "hourly_rate_cents" INTEGER;

-- CreateTable
CREATE TABLE "BillingReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "workspace_id" TEXT,
    "from_date" TEXT NOT NULL,
    "to_date" TEXT NOT NULL,
    "author_emails" TEXT NOT NULL,
    "branch_filter" TEXT,
    "agent_slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "run_message_id" TEXT,
    "error" TEXT,
    "ledger" TEXT NOT NULL,
    "notes" TEXT,
    "rate_cents" INTEGER,
    "currency" TEXT,
    "rate_source" TEXT,
    "requested_by_id" TEXT NOT NULL,
    "finalized_at" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingReportDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "report_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "estimated_minutes" INTEGER NOT NULL,
    "override_minutes" INTEGER,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "rationale" TEXT,
    "commit_count" INTEGER NOT NULL,
    "insertions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "files_touched" INTEGER NOT NULL,
    "first_commit_at" TEXT,
    "last_commit_at" TEXT,
    CONSTRAINT "BillingReportDay_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "BillingReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BillingReport_projectId_from_date_to_date_idx" ON "BillingReport"("projectId", "from_date", "to_date");

-- CreateIndex
CREATE INDEX "BillingReport_workspace_id_idx" ON "BillingReport"("workspace_id");

-- CreateIndex
CREATE INDEX "BillingReport_status_idx" ON "BillingReport"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingReport_projectId_from_date_to_date_agent_slug_requested_by_id_key" ON "BillingReport"("projectId", "from_date", "to_date", "agent_slug", "requested_by_id");

-- CreateIndex
CREATE INDEX "BillingReportDay_report_id_idx" ON "BillingReportDay"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "BillingReportDay_report_id_day_key" ON "BillingReportDay"("report_id", "day");

