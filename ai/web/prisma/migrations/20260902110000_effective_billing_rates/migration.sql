CREATE TABLE "BillingRateSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope_key" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "workspace_id" TEXT,
    "project_id" TEXT,
    "start_on" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingRateSchedule_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BillingRateSchedule_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BillingRateSchedule_scope_key_start_on_key" ON "BillingRateSchedule"("scope_key", "start_on");
CREATE INDEX "BillingRateSchedule_scope_type_start_on_idx" ON "BillingRateSchedule"("scope_type", "start_on");
CREATE INDEX "BillingRateSchedule_workspace_id_start_on_idx" ON "BillingRateSchedule"("workspace_id", "start_on");
CREATE INDEX "BillingRateSchedule_project_id_start_on_idx" ON "BillingRateSchedule"("project_id", "start_on");

-- Preserve the rates configured before schedules existed as an always-effective
-- baseline. Existing BillingReport snapshots remain unchanged.
INSERT INTO "BillingRateSchedule" ("id", "scope_key", "scope_type", "start_on", "amount_cents", "updatedAt")
SELECT 'rate-global-baseline', 'global', 'global', '1970-01-01', "hourly_rate_cents", CURRENT_TIMESTAMP
FROM "SystemSettings"
WHERE "id" = 'system' AND "hourly_rate_cents" > 0;

INSERT INTO "BillingRateSchedule" ("id", "scope_key", "scope_type", "workspace_id", "start_on", "amount_cents", "updatedAt")
SELECT 'rate-workspace-' || "id", 'workspace:' || "id", 'workspace', "id", '1970-01-01', "hourly_rate_cents", CURRENT_TIMESTAMP
FROM "Workspace"
WHERE "hourly_rate_cents" > 0;

INSERT INTO "BillingRateSchedule" ("id", "scope_key", "scope_type", "project_id", "start_on", "amount_cents", "updatedAt")
SELECT 'rate-project-' || "id", 'project:' || "id", 'project', "id", '1970-01-01', "hourly_rate_cents", CURRENT_TIMESTAMP
FROM "Project"
WHERE "hourly_rate_cents" > 0;
