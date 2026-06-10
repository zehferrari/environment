ALTER TABLE "DeploymentPullRequest" ADD COLUMN "local_change_summary" TEXT;
ALTER TABLE "DeploymentPullRequest" ADD COLUMN "local_change_approved_at" DATETIME;
ALTER TABLE "DeploymentPullRequest" ADD COLUMN "local_change_approved_by" TEXT;
