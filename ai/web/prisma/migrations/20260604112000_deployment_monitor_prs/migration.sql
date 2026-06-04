ALTER TABLE "Project" ADD COLUMN "deployment_provider" TEXT NOT NULL DEFAULT 'bitbucket';
ALTER TABLE "Project" ADD COLUMN "deployment_production_branch" TEXT;
ALTER TABLE "Project" ADD COLUMN "deployment_mode" TEXT NOT NULL DEFAULT 'pr-only';
ALTER TABLE "Project" ADD COLUMN "deployment_on_merge" TEXT;
ALTER TABLE "Project" ADD COLUMN "deployment_bitbucket_workspace" TEXT;
ALTER TABLE "Project" ADD COLUMN "deployment_bitbucket_repo_slug" TEXT;
ALTER TABLE "Epic" ADD COLUMN "deployment_status" TEXT NOT NULL DEFAULT 'Not Required';
ALTER TABLE "Task" ADD COLUMN "deployment_status" TEXT NOT NULL DEFAULT 'Not Required';

CREATE TABLE "DeploymentPullRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT,
  "epicId" TEXT,
  "provider" TEXT NOT NULL,
  "provider_pr_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "source_branch" TEXT NOT NULL,
  "target_branch" TEXT NOT NULL,
  "latest_commit_sha" TEXT NOT NULL,
  "reporter_user_id" TEXT NOT NULL,
  "reporter_name" TEXT NOT NULL,
  "reporter_email" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DeploymentPullRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DeploymentPullRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DeploymentPullRequest_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeploymentPullRequest_provider_provider_pr_id_key" ON "DeploymentPullRequest"("provider", "provider_pr_id");
CREATE INDEX "DeploymentPullRequest_projectId_idx" ON "DeploymentPullRequest"("projectId");
CREATE INDEX "DeploymentPullRequest_taskId_idx" ON "DeploymentPullRequest"("taskId");
CREATE INDEX "DeploymentPullRequest_epicId_idx" ON "DeploymentPullRequest"("epicId");
CREATE INDEX "DeploymentPullRequest_status_idx" ON "DeploymentPullRequest"("status");
