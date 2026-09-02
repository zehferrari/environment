-- Persist every Billing generation separately so regenerations can be reviewed
-- before replacing the accepted invoice draft.
ALTER TABLE "BillingReport" ADD COLUMN "accepted_run_id" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "hourly_rate_cents" INTEGER;
ALTER TABLE "SystemSettings" ADD COLUMN "billing_currency" TEXT;

CREATE TABLE "BillingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "report_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "message_id" TEXT,
    "author_emails" TEXT NOT NULL,
    "branch_filter" TEXT,
    "ledger" TEXT NOT NULL,
    "notes" TEXT,
    "response" TEXT,
    "error" TEXT,
    "workspace_id" TEXT,
    "rate_cents" INTEGER,
    "currency" TEXT,
    "rate_source" TEXT,
    "completed_at" DATETIME,
    "accepted_at" DATETIME,
    "discarded_at" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingRun_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "BillingReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "BillingRunDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "estimated_minutes" INTEGER NOT NULL,
    "rationale" TEXT,
    "commit_count" INTEGER NOT NULL,
    "insertions" INTEGER NOT NULL,
    "deletions" INTEGER NOT NULL,
    "files_touched" INTEGER NOT NULL,
    "first_commit_at" TEXT,
    "last_commit_at" TEXT,
    CONSTRAINT "BillingRunDay_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "BillingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "BillingRunEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingRunEvent_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "BillingRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "DirectAgentChatMessage" ADD COLUMN "billing_run_id" TEXT REFERENCES "BillingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "BillingRun_message_id_key" ON "BillingRun"("message_id");
CREATE UNIQUE INDEX "BillingRun_report_id_generation_key" ON "BillingRun"("report_id", "generation");
CREATE INDEX "BillingRun_report_id_status_createdAt_idx" ON "BillingRun"("report_id", "status", "createdAt");
CREATE INDEX "BillingRun_workspace_id_idx" ON "BillingRun"("workspace_id");
CREATE UNIQUE INDEX "BillingRunDay_run_id_day_key" ON "BillingRunDay"("run_id", "day");
CREATE INDEX "BillingRunDay_run_id_idx" ON "BillingRunDay"("run_id");
CREATE UNIQUE INDEX "BillingRunEvent_run_id_seq_key" ON "BillingRunEvent"("run_id", "seq");
CREATE INDEX "BillingRunEvent_run_id_createdAt_idx" ON "BillingRunEvent"("run_id", "createdAt");
CREATE INDEX "DirectAgentChatMessage_billing_run_id_idx" ON "DirectAgentChatMessage"("billing_run_id");
