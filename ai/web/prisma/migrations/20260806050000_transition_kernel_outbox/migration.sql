ALTER TABLE "Task" ADD COLUMN "workflow_version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "workflow_transitions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "workflow_version" INTEGER NOT NULL,
  "intent" TEXT NOT NULL,
  "from_status" TEXT NOT NULL,
  "to_status" TEXT NOT NULL,
  "actor_user_id" TEXT,
  "source" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "evidence" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_transitions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workflow_transitions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "workflow_transitions_task_id_workflow_version_key" ON "workflow_transitions"("task_id", "workflow_version");
CREATE UNIQUE INDEX "workflow_transitions_task_id_idempotency_key_key" ON "workflow_transitions"("task_id", "idempotency_key");
CREATE INDEX "workflow_transitions_intent_created_at_idx" ON "workflow_transitions"("intent", "created_at");
CREATE INDEX "workflow_transitions_actor_user_id_idx" ON "workflow_transitions"("actor_user_id");

CREATE TABLE "workflow_outbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "transition_id" TEXT,
  "aggregate_version" INTEGER NOT NULL,
  "effect_type" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" DATETIME,
  "completed_at" DATETIME,
  "last_error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "workflow_outbox_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workflow_outbox_transition_id_fkey" FOREIGN KEY ("transition_id") REFERENCES "workflow_transitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "workflow_outbox_dedupe_key_key" ON "workflow_outbox"("dedupe_key");
CREATE INDEX "workflow_outbox_status_available_at_idx" ON "workflow_outbox"("status", "available_at");
CREATE INDEX "workflow_outbox_lease_expires_at_idx" ON "workflow_outbox"("lease_expires_at");
CREATE INDEX "workflow_outbox_task_id_aggregate_version_idx" ON "workflow_outbox"("task_id", "aggregate_version");
CREATE INDEX "workflow_outbox_transition_id_idx" ON "workflow_outbox"("transition_id");

ALTER TABLE "AgentChatMessage" ADD COLUMN "workflow_dedupe_key" TEXT;
CREATE UNIQUE INDEX "AgentChatMessage_workflow_dedupe_key_key" ON "AgentChatMessage"("workflow_dedupe_key");
